#!/usr/bin/env node
/**
 * LEASH MCP server: lets an AI agent request a spend. Every spend goes through
 * the real Noir prover (nargo + bb) and the real Barretenberg verifier.
 * Nothing is simulated: if a tool or key is missing, the tool call errors.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  checkVerifierHealth,
  currentEpoch,
  generatePaymentProof,
  getDefaultPolicy,
  isAddress,
  leashHome,
  NONCE_RE,
  policyIdOf,
  proofKeccak,
  Receipt,
  ReceiptStore,
  SpendInputs,
  SpendingPolicy,
  SpendTracker,
  verifyPaymentProof,
  vkHash,
} from '@leash/core';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossRailRefusal, Rail, railKey, RailTotals } from './ledger.js';
import { createProxyServer, ProofGatedProxy, splitCommand } from './proxy.js';

/** `--demo`: prove against the fixed-salt demo policy (recordings/tests only). Default: the owner's random-salt policy. */
const DEMO = process.argv.includes('--demo') || process.env.LEASH_DEMO === '1';
const policy = () => getDefaultPolicy({ demo: DEMO });

/** Proofs made by leash_request_payment in this process, keyed by nonce, for on-chain submission. */
interface StoredProof {
  proofHex: string;
  publicInputsHex: string;
  amount: number;
  spend: SpendInputs;
  newSpendCommit: string;
  rail: 'evm' | 'paypal';
  merchantIdHash: string;
  recipient: string;
  paypalMerchantId?: string;
}
const proofs = new Map<string, StoredProof>();
const spendTracker = new SpendTracker(true);
/** This device's receipts for on-chain releases (PayPal receipts live at the gateway). */
let localReceipts: ReceiptStore | null = null;
const receipts = () => (localReceipts ??= new ReceiptStore());
const gatewayUrl = () => process.env.LEASH_GATEWAY_URL?.replace(/\/$/, '');

/**
 * fetch to the gateway with a deadline (LEASH_GATEWAY_TIMEOUT_MS, default 20 s): a gateway that accepts
 * and never answers must not stall the agent's tool call for undici's ~300 s default.
 */
async function gatewayFetch(base: string, route: string, init: RequestInit = {}): Promise<Response> {
  const ms = Number(process.env.LEASH_GATEWAY_TIMEOUT_MS ?? 20_000);
  const what = `${init.method ?? 'GET'} ${route.split('?')[0]}`;
  try {
    return await fetch(`${base}${route}`, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`Gateway ${base} did not answer within ${ms} ms (${what})`);
    throw new Error(`Gateway ${base} unreachable (${what}): ${String((e as Error)?.message ?? e)}`);
  }
}

const castCall = (rpc: string, to: string, sig: string, ...args: string[]) =>
  execFileSync('cast', ['call', to, sig, ...args, '--rpc-url', rpc], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Owner of the policy on chain (policies are keyed by (owner, commitment)). */
const policyOwner = () => process.env.LEASH_POLICY_OWNER_ADDRESS ?? process.env.LEASH_SENDER_ADDRESS;

/**
 * Spend data of every proof this device made today, kept in <LEASH_HOME>/pending-spends.json (no proof
 * bytes, no secrets: nonce, spent_before, amount, new_spend_commit). If a proof lands without this
 * process advancing its spend record (a relayer submitted it, `cast send` timed out after the tx was
 * mined, the gateway's answer was lost, leash-mcp restarted), the chain or gateway holds that proof's
 * new_spend_commit, and the record is reconciled from here instead of locking the policy until UTC midnight.
 */
interface PendingSpend {
  key: string;
  nonce: string;
  epoch: number;
  spentBeforeCents: number;
  amountCents: number;
  newSpendCommit: string;
  /** the rail whose spend chain this proof extends (absent in records written before rails were split) */
  rail?: Rail;
}
const pendingFile = () => join(leashHome(), 'pending-spends.json');
function readPending(): PendingSpend[] {
  const f = pendingFile();
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as PendingSpend[];
  } catch {
    return [];
  }
}
function rememberPending(p: PendingSpend): void {
  const keep = readPending().filter((x) => x.epoch === p.epoch && !(x.key === p.key && x.nonce === p.nonce));
  const f = pendingFile();
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...keep, p], null, 2), { mode: 0o600 });
  renameSync(tmp, f);
}
/** Advance the rail's spend record from the pending proof whose new commitment is the one that landed. */
function reconcile(key: string, epoch: number, landedCommit: string, rail: Rail): SpendInputs | undefined {
  const hit = readPending().find(
    (x) => x.key === key.toLowerCase() && x.epoch === epoch && (!x.rail || x.rail === rail) && x.newSpendCommit.toLowerCase() === landedCommit.toLowerCase()
  );
  if (!hit) return undefined;
  const next = spendTracker.advance(railKey(key, rail), { epoch, spentBeforeCents: hit.spentBeforeCents, amountCents: hit.amountCents, newSpendCommit: hit.newSpendCommit });
  return { epoch, prevSpendCommit: landedCommit, spentBeforeCents: next.spentCents };
}

const spendKey = (commitment: string) => {
  const owner = policyOwner();
  return isAddress(owner) ? policyIdOf(owner, commitment) : commitment;
};

/**
 * Spend-chain inputs for the next proof. With a LeashPayment contract the chain is the source of
 * truth: today's stored commitment must be the one this device last advanced to (then we know the
 * spent total that opens it), or zero / another day (start fresh). Without a contract, the local
 * record is used.
 */
async function gatewaySpendInputs(commitment: string): Promise<SpendInputs> {
  const epoch = currentEpoch();
  const owner = policyOwner();
  const base = gatewayUrl();
  if (!base || !isAddress(owner)) throw new Error('PayPal rail not configured: set LEASH_GATEWAY_URL and LEASH_POLICY_OWNER_ADDRESS.');
  const id = policyIdOf(owner, commitment);
  const res = await gatewayFetch(base, `/api/spend/${id}`);
  if (!res.ok) throw new Error(`Gateway ${base} answered ${res.status} for /api/spend`);
  let spend: { epoch: number; commit: string } | null;
  try {
    ({ spend } = (await res.json()) as { spend: { epoch: number; commit: string } | null });
  } catch (e) {
    throw new Error(`Gateway ${base} sent an unreadable /api/spend answer: ${String((e as Error)?.message ?? e)}`);
  }
  if (!spend || spend.epoch !== epoch || /^0x0+$/.test(spend.commit)) return { epoch, prevSpendCommit: '0', spentBeforeCents: 0 };
  const local = spendTracker.get(railKey(id, 'paypal'));
  if (local && local.epoch === epoch && local.commit.toLowerCase() === spend.commit.toLowerCase()) {
    return { epoch, prevSpendCommit: spend.commit, spentBeforeCents: local.spentCents };
  }
  const reconciled = reconcile(id, epoch, spend.commit, 'paypal');
  if (reconciled) return reconciled;
  throw new Error(`Gateway spend commitment ${spend.commit} is not one this device produced today; can't open it.`);
}

function spendInputs(commitment: string): SpendInputs {
  const epoch = currentEpoch();
  const rpc = process.env.LEASH_RPC_URL;
  const contract = process.env.LEASH_PAYMENT_CONTRACT_ADDRESS;
  const owner = policyOwner();
  if (!rpc || !contract || !isAddress(owner)) return spendTracker.inputs(spendKey(commitment), epoch);
  const id = policyIdOf(owner, commitment);
  const chainCommit = castCall(rpc, contract, 'spendCommit(bytes32)(bytes32)', id).toLowerCase();
  const chainEpoch = Number(castCall(rpc, contract, 'spendEpoch(bytes32)(uint64)', id).split(' ')[0]);
  if (/^0x0+$/.test(chainCommit) || chainEpoch !== epoch) return { epoch, prevSpendCommit: '0', spentBeforeCents: 0 };
  const local = spendTracker.get(id);
  if (local && local.epoch === epoch && local.commit.toLowerCase() === chainCommit) {
    return { epoch, prevSpendCommit: chainCommit, spentBeforeCents: local.spentCents };
  }
  const reconciled = reconcile(id, epoch, chainCommit, 'evm');
  if (reconciled) return reconciled;
  throw new Error(
    `Spend commitment on chain (${chainCommit}) is not one this device produced today; can't open it to prove the daily cap. Another device spent under this policy.`
  );
}

/** PayPal-rail spend inputs: the gateway's chain when one is configured, else this device's record. */
async function paypalRailInputs(commitment: string): Promise<SpendInputs> {
  return gatewayUrl() ? gatewaySpendInputs(commitment) : spendTracker.inputs(railKey(spendKey(commitment), 'paypal'));
}

/**
 * Cents landed today on every rail this policy can use. `own` is the rail being paid on, with the
 * spend inputs its proof opens; the other rails are read from the chain / gateway (reconciled like a
 * proof's own inputs, so a lost answer can't hide a landed payment) and from this device's records.
 */
async function railTotals(p: SpendingPolicy, own: { rail: Rail; spend: SpendInputs }): Promise<RailTotals> {
  const t: RailTotals = {};
  t.evm = own.rail === 'evm' ? own.spend.spentBeforeCents : spendInputs(p.policyCommitment).spentBeforeCents;
  if (p.merchantLeaves.some((m) => m.paypalMerchantId)) {
    t.paypal = own.rail === 'paypal' ? own.spend.spentBeforeCents : (await paypalRailInputs(p.policyCommitment)).spentBeforeCents;
    // Orders the proof-gated proxy (leash-mcp --upstream) made from this device today.
    const proxy = spendTracker.get(railKey(spendKey(p.policyCommitment), 'proxy'));
    if (proxy && proxy.epoch === currentEpoch() && proxy.spentCents > 0) t.proxy = proxy.spentCents;
  }
  return t;
}

/** Refusal text when releasing a stored proof would take the policy over its daily cap across rails. */
async function releaseRefusal(stored: StoredProof): Promise<string | undefined> {
  const p = policy();
  return crossRailRefusal({
    rail: stored.rail,
    totals: await railTotals(p, { rail: stored.rail, spend: stored.spend }),
    amountCents: stored.amount,
    dailyCapCents: p.dailyCapCents,
    outcome: 'Nothing was sent.',
  });
}

/**
 * Submit a stored proof to LeashPayment.executePayment with `cast send`.
 * Needs LEASH_RPC_URL, LEASH_PAYMENT_CONTRACT_ADDRESS and LEASH_SENDER_ADDRESS, an account the node
 * has unlocked (e.g. an Anvil dev account). No private key is handled here.
 * LEASH_POLICY_OWNER_ADDRESS (optional, defaults to the sender) selects whose policy pays.
 */
async function executeOnchain(nonce: string, recipientOverride?: string): Promise<ToolResult> {
  const rpc = process.env.LEASH_RPC_URL;
  const contract = process.env.LEASH_PAYMENT_CONTRACT_ADDRESS;
  const sender = process.env.LEASH_SENDER_ADDRESS;
  if (!rpc || !contract || !sender) {
    return fail('On-chain path not configured: set LEASH_RPC_URL, LEASH_PAYMENT_CONTRACT_ADDRESS and LEASH_SENDER_ADDRESS (an unlocked account).');
  }
  // Sends use eth_sendTransaction from a node-unlocked account, which only dev nodes offer.
  // Refuse anything that is not a local Anvil/Hardhat chain (chain id 31337).
  let chainId: string;
  try {
    chainId = execFileSync('cast', ['chain-id', '--rpc-url', rpc], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return fail(`Could not read chain id from ${rpc}: ${String((err as { stderr?: string }).stderr ?? err).trim()}`);
  }
  if (chainId !== '31337') {
    return fail(`Refusing to send: chain id ${chainId} is not a local dev chain (31337). leash_execute_onchain uses an unlocked node account and is for Anvil only.`);
  }
  // Policies are keyed by (owner, commitment) on-chain; the policy owner defaults to the sender.
  const owner = process.env.LEASH_POLICY_OWNER_ADDRESS ?? sender;
  const stored = proofs.get(nonce);
  if (!stored) return fail(`No proof for nonce '${nonce}' in this session; call leash_request_payment first.`);
  if (stored.rail === 'paypal') return fail(`The proof for nonce '${nonce}' pays a PayPal merchant; use leash_pay_paypal.`);
  // Another rail may have spent since this proof was made: the cap is per policy, not per rail.
  const overCap = await releaseRefusal(stored);
  if (overCap) return fail(overCap);
  const hex = stored.publicInputsHex.replace(/^0x/, '');
  if (hex.length !== 8 * 64) return fail(`Expected 8 public inputs, got ${hex.length / 64}`);
  const slot = (i: number) => '0x' + hex.slice(i * 64, (i + 1) * 64);
  const provenRecipient = '0x' + slot(4).slice(-40);
  const recipient = recipientOverride ?? provenRecipient;
  try {
    const out = execFileSync(
      'cast',
      [
        'send', contract,
        'executePayment(address,bytes32,uint256,bytes32,bytes32,address,(uint64,bytes32,bytes32),bytes)',
        owner, slot(0), String(stored.amount), slot(2), slot(3), recipient,
        `(${BigInt(slot(5))},${slot(6)},${slot(7)})`, stored.proofHex,
        // LEASH_PAY_FROM_ESCROW=1: a relayer submits with no msg.value; the owner's per-policy escrow pays.
        ...(process.env.LEASH_PAY_FROM_ESCROW === '1' ? [] : ['--value', String(stored.amount)]),
        '--rpc-url', rpc, '--unlocked', '--from', sender, '--json',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 }
    );
    const receipt = JSON.parse(out);
    const released = receipt.status === '0x1';
    if (released) {
      // The chain accepted the spend update: advance this device's record of today's total.
      const policyId = policyIdOf(owner, slot(0));
      spendTracker.advance(policyId, {
        epoch: stored.spend.epoch,
        spentBeforeCents: stored.spend.spentBeforeCents,
        amountCents: stored.amount,
        newSpendCommit: stored.newSpendCommit,
      });
      receipts().saveProof({ proofHex: stored.proofHex, publicInputsHex: stored.publicInputsHex, proofTarget: 'evm' });
      receipts().put({
        policyId,
        nonce: BigInt(slot(3)).toString(),
        amountCents: stored.amount,
        merchantIdHash: stored.merchantIdHash,
        recipient: recipient.toLowerCase(),
        epoch: stored.spend.epoch,
        newSpendCommit: stored.newSpendCommit,
        proofKeccak: proofKeccak(stored.proofHex),
        vkHash: vkHash('evm'),
        proofTarget: 'evm',
        rail: 'evm',
        status: 'COMPLETED',
        txHash: receipt.transactionHash,
        ts: new Date().toISOString(),
      });
    }
    return ok({
      released,
      txHash: receipt.transactionHash,
      block: Number(receipt.blockNumber),
      recipient,
      amountCents: stored.amount,
      amountWei: stored.amount,
      paidFrom: process.env.LEASH_PAY_FROM_ESCROW === '1' ? `policy escrow (relayer ${sender} sent no value)` : `msg.value from ${sender}`,
      spentTodayCents: stored.spend.spentBeforeCents + stored.amount,
    });
  } catch (err) {
    // cast --json reports errors as JSON on stdout (cast 1.x), older versions on stderr.
    const e = err as { stderr?: string; stdout?: string };
    const stderr = [e.stdout, e.stderr].filter(Boolean).join('\n') || String(err);
    const reason = stderr.match(/reverted:?\s*([^,"\n]+)/i)?.[1] ?? stderr.split('\n').find((l) => l.trim()) ?? 'unknown';
    const known: Record<string, string> = { '0x9fc3a218': 'SumcheckFailed (proof rejected: it does not verify for these public inputs)' };
    const named = reason.replace(/custom error (0x[0-9a-fA-F]{8})/, (m, sel: string) => known[sel.toLowerCase()] ?? m);
    return fail(`On-chain payment REJECTED by LeashPayment: ${named.replace(/,? data: "0x[0-9a-fA-F]*"/, '').trim()}`);
  }
}

/** Send a PayPal-rail proof to the verify-only gateway; surfaces the buyer approve link when one is needed. */
async function payPaypal(nonce: string): Promise<ToolResult> {
  const base = gatewayUrl();
  const owner = policyOwner();
  if (!base || !isAddress(owner)) return fail('PayPal rail not configured: set LEASH_GATEWAY_URL and LEASH_POLICY_OWNER_ADDRESS.');
  const stored = proofs.get(nonce);
  if (!stored) return fail(`No proof for nonce '${nonce}' in this session; call leash_request_payment first.`);
  if (stored.rail !== 'paypal' || !stored.paypalMerchantId) {
    return fail(`The proof for nonce '${nonce}' pays ${stored.recipient}, which is not a PayPal merchant in this policy; use leash_execute_onchain.`);
  }
  const overCap = await releaseRefusal(stored);
  if (overCap) return fail(overCap);
  let res: Response;
  try {
    res = await gatewayFetch(base, '/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, proofHex: stored.proofHex, publicInputsHex: stored.publicInputsHex, paypalMerchantId: stored.paypalMerchantId }),
    });
  } catch (e) {
    // The gateway may still have consumed it; the next proof reconciles from pending-spends.json.
    return fail(`${(e as Error).message}; check leash_receipt for nonce '${nonce}' before retrying.`);
  }
  let body: { success?: boolean; consumed?: boolean; error?: string; receipt?: Receipt };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // If the gateway did consume it, the next proof reconciles from pending-spends.json.
    return fail(`Gateway ${base} answered ${res.status} with a body that is not JSON (or not in time); check leash_receipt for nonce '${nonce}'.`);
  }
  if (body.consumed && body.receipt) {
    spendTracker.advance(railKey(body.receipt.policyId, 'paypal'), {
      epoch: stored.spend.epoch,
      spentBeforeCents: stored.spend.spentBeforeCents,
      amountCents: stored.amount,
      newSpendCommit: stored.newSpendCommit,
    });
  }
  if (!body.receipt) return fail(`Gateway refused (${res.status}): ${body.error ?? 'unknown error'}`);
  const r = body.receipt;
  return ok({
    status: r.status,
    amountCents: r.amountCents,
    paypalOrderId: r.paypalOrderId,
    captureId: r.captureId,
    custom_id: r.custom_id,
    ...(r.status === 'AWAITING_APPROVAL'
      ? { awaitingApproval: true, approveUrl: r.approveUrl, note: 'Above the owner approval threshold: the buyer must open approveUrl; the gateway captures after approval.' }
      : {}),
    ...(r.status === 'FAILED' ? { error: r.error } : {}),
  });
}

async function findReceipt(nonce: string): Promise<ToolResult> {
  const found: Receipt[] = receipts().byNonce(nonce);
  const base = gatewayUrl();
  let gatewayNote: string | undefined;
  if (base) {
    const owner = policyOwner();
    const q = isAddress(owner) ? `?policyId=${policyIdOf(owner, policy().policyCommitment)}` : '';
    try {
      const res = await gatewayFetch(base, `/api/receipts/${encodeURIComponent(nonce)}${q}`);
      if (res.ok) {
        const b = (await res.json()) as { receipt?: Receipt; receipts?: Receipt[] };
        found.push(...(b.receipt ? [b.receipt] : b.receipts ?? []));
      } else if (res.status !== 404) gatewayNote = `gateway answered ${res.status}`;
    } catch (e) {
      gatewayNote = String((e as Error).message);
    }
  }
  if (found.length === 0) return fail(`No receipt for nonce '${nonce}'${gatewayNote ? ` (${gatewayNote})` : ''}.`);
  return ok({ receipts: found, ...(gatewayNote ? { gatewayNote } : {}) });
}

export const TOOLS = [
  {
    name: 'leash_policy',
    description:
      'Return the public commitment of the active spending policy. Rules stay private; only the commitment is revealed.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'leash_verifier_health',
    description: 'Report whether nargo, bb and the verification key are available.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'leash_request_payment',
    description:
      'Prove a payment satisfies the policy (merchant allowlist with each merchant\'s bound payee, per-transaction cap, rolling daily cap) and verify the proof. Returns the proof and verification result, or the rule the request violated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        merchant: { type: 'string', description: 'Merchant name, e.g. "openai"' },
        amountCents: { type: 'integer', minimum: 1, description: 'Amount in cents' },
        nonce: { type: 'string', pattern: '^(0|[1-9][0-9]{0,29})$', description: 'Unique nonce for this payment, as a decimal integer string (no leading zeros)' },
        recipient: {
          type: 'string',
          description: 'Payee 0x address; defaults to the payee the policy lists for this merchant',
        },
      },
      required: ['merchant', 'amountCents', 'nonce'],
    },
  },
  {
    name: 'leash_pay_paypal',
    description:
      'Release a proven payment to a PayPal merchant through the verify-only LEASH gateway (Orders v2). Above the owner approval threshold it returns approveUrl for the buyer; otherwise a vaulted wallet is charged. Without PayPal credentials the gateway answers "Setup required".',
    inputSchema: {
      type: 'object' as const,
      properties: { nonce: { type: 'string', description: 'Nonce used in leash_request_payment' } },
      required: ['nonce'],
    },
  },
  {
    name: 'leash_receipt',
    description:
      'Look up the receipt for a nonce: policyId, amount (cents), salted merchant hash, payee, proof hash, vk hash, and the PayPal order/capture ids or the on-chain tx hash.',
    inputSchema: {
      type: 'object' as const,
      properties: { nonce: { type: 'string', description: 'Payment nonce' } },
      required: ['nonce'],
    },
  },
  {
    name: 'leash_execute_onchain',
    description:
      'Submit the proof made for a nonce to the LeashPayment contract, which re-verifies it on chain, burns the nonce and releases exactly the proven amount (in wei) to the recipient. recipient defaults to the payee bound in the proof.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nonce: { type: 'string', description: 'Nonce used in leash_request_payment' },
        recipient: { type: 'string', description: 'Payee 0x address to send to (optional)' },
      },
      required: ['nonce'],
    },
  },
];

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Refused before anything runs (nargo never sees it). Same rule as the proof's public input. */
const NONCE_HELP = 'nonce must be a decimal integer string without leading zeros (1-30 digits), e.g. "3001"';

const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export async function callTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'leash_policy': {
        const p = policy();
        return ok({ name: p.name, policyCommitment: p.policyCommitment, demoPolicy: DEMO });
      }
      case 'leash_verifier_health':
        return ok(checkVerifierHealth());
      case 'leash_request_payment': {
        const merchant = args.merchant;
        const amountCents = args.amountCents;
        const nonce = args.nonce;
        if (typeof merchant !== 'string' || !merchant.trim()) {
          return fail('merchant must be a non-empty string');
        }
        if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
          return fail('amountCents must be a positive integer');
        }
        if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
          return fail(NONCE_HELP);
        }
        const recipient = typeof args.recipient === 'string' ? args.recipient : undefined;
        const p = policy();
        // A merchant listed with a PayPal merchant id settles through the gateway (PayPal rail);
        // otherwise on chain. The EVM rail proves for the Solidity verifier (keccak transcript).
        const leaf = p.merchantLeaves.find((m) => m.name === merchant.trim().toLowerCase());
        const rail: 'evm' | 'paypal' = leaf?.paypalMerchantId ? 'paypal' : 'evm';
        const useEvmTarget = rail === 'evm' && Boolean(process.env.LEASH_PAYMENT_CONTRACT_ADDRESS);
        const spend = rail === 'paypal' ? await paypalRailInputs(p.policyCommitment) : spendInputs(p.policyCommitment);
        // The circuit checks the cap on this rail's chain; the policy's cap covers all rails together.
        const overCap = crossRailRefusal({
          rail,
          totals: await railTotals(p, { rail, spend }),
          amountCents,
          dailyCapCents: p.dailyCapCents,
          outcome: 'Nothing was proved.',
        });
        if (overCap) return fail(overCap);

        const proof = generatePaymentProof({
          policy: p,
          merchantName: merchant,
          amountCents,
          nonce,
          recipient,
          spend,
          useEvmTarget,
        });
        const verification = verifyPaymentProof({
          proofHex: proof.proofHex,
          publicInputsHex: proof.publicInputsHex,
          expectedCommitment: proof.publicInputs.policy_commitment,
          expectedAmount: amountCents,
          expectedMerchantHash: proof.publicInputs.merchant_id_hash,
          expectedNonce: nonce,
          useEvmTarget,
        });
        if (verification.valid) {
          const owner = policyOwner();
          rememberPending({
            key: (isAddress(owner) ? policyIdOf(owner, p.policyCommitment) : p.policyCommitment).toLowerCase(),
            nonce,
            epoch: spend.epoch,
            spentBeforeCents: spend.spentBeforeCents,
            amountCents,
            newSpendCommit: proof.publicInputs.new_spend_commit,
            rail,
          });
          proofs.set(nonce, {
            proofHex: proof.proofHex,
            publicInputsHex: proof.publicInputsHex,
            amount: amountCents,
            spend,
            newSpendCommit: proof.publicInputs.new_spend_commit,
            rail,
            merchantIdHash: proof.publicInputs.merchant_id_hash,
            recipient: proof.publicInputs.recipient,
            paypalMerchantId: leaf?.paypalMerchantId,
          });
        }
        return ok({
          approved: verification.valid,
          rail,
          // publicInputs.amount is the proven amount in cents (300 = $3.00), not dollars.
          amountCents,
          units: { amount: 'cents', onchain: '1 cent settles as 1 wei on the demo chain' },
          spentTodayBeforeCents: spend.spentBeforeCents,
          publicInputs: proof.publicInputs,
          proveMs: proof.durationMs,
          verification,
          proofHex: proof.proofHex,
        });
      }
      case 'leash_execute_onchain': {
        if (typeof args.nonce !== 'string' || !NONCE_RE.test(args.nonce)) return fail(NONCE_HELP);
        const r = args.recipient;
        if (r !== undefined && (typeof r !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r))) {
          return fail('recipient must be a 0x-prefixed 20-byte address');
        }
        return await executeOnchain(args.nonce, r as string | undefined);
      }
      case 'leash_pay_paypal': {
        if (typeof args.nonce !== 'string' || !NONCE_RE.test(args.nonce)) return fail(NONCE_HELP);
        return await payPaypal(args.nonce);
      }
      case 'leash_receipt': {
        if (typeof args.nonce !== 'string' || !NONCE_RE.test(args.nonce)) return fail(NONCE_HELP);
        return await findReceipt(args.nonce);
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    // nargo/bb failures (e.g. a constraint the payment breaks) carry the reason on stderr.
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return fail(stderr ? `${msg}\n${stderr.slice(0, 600)}` : msg);
  }
}

/**
 * With LEASH_MCP_LOG set, append each tool call and its exact result to that file as one JSON line,
 * so a demo can show what the tools returned rather than the agent's paraphrase of it.
 */
function logToolCall(tool: string, args: Record<string, unknown>, result: ToolResult): void {
  const file = process.env.LEASH_MCP_LOG;
  if (!file) return;
  const text = result.content.map((c) => c.text).join('\n');
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Errors are plain text; keep them as a string.
  }
  const line = { ts: new Date().toISOString(), tool, args, isError: Boolean(result.isError), result: parsed };
  appendFileSync(file, JSON.stringify(line) + '\n');
}

export function createServer(): Server {
  const server = new Server(
    { name: 'leash-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(req.params.name, args);
    logToolCall(req.params.name, args, result);
    return result;
  });
  return server;
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--upstream');
  if (i < 0) {
    await createServer().connect(new StdioServerTransport());
    return;
  }
  // Proof-gated proxy mode: leash-mcp --upstream "npx -y @paypal/mcp --tools=all"
  const upstream = splitCommand(process.argv[i + 1] ?? '');
  // PayPal's server needs a bearer token (PAYPAL_ACCESS_TOKEN, PAYPAL_ENVIRONMENT=SANDBOX); don't start
  // a proxy that can only fail later.
  if (upstream.some((a) => a.startsWith('@paypal/mcp')) && !process.env.PAYPAL_ACCESS_TOKEN) {
    console.error('[leash-mcp] Setup required (PAYPAL_ACCESS_TOKEN) for the @paypal/mcp upstream');
    process.exit(1);
  }
  const p = policy();
  const owner = policyOwner();
  const proxy = new ProofGatedProxy({
    upstream,
    policy: p,
    policyId: policyIdOf(isAddress(owner) ? owner : '0x0000000000000000000000000000000000000000', p.policyCommitment),
  });
  await proxy.connect();
  await createProxyServer(proxy).connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[leash-mcp] failed to start:', err);
    process.exit(1);
  });
}
