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
  generatePaymentProof,
  getDefaultPolicy,
  verifyPaymentProof,
} from '@leash/core';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** Proofs made by leash_request_payment in this process, keyed by nonce, for on-chain submission. */
const proofs = new Map<string, { proofHex: string; publicInputsHex: string; amount: number }>();

/**
 * Submit a stored proof to LeashPayment.executePayment with `cast send`.
 * Needs LEASH_RPC_URL, LEASH_PAYMENT_CONTRACT_ADDRESS and LEASH_SENDER_ADDRESS, an account the node
 * has unlocked (e.g. an Anvil dev account). No private key is handled here.
 * LEASH_POLICY_OWNER_ADDRESS (optional, defaults to the sender) selects whose policy pays.
 */
function executeOnchain(nonce: string, recipientOverride?: string): ToolResult {
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
  const hex = stored.publicInputsHex.replace(/^0x/, '');
  if (hex.length !== 5 * 64) return fail(`Expected 5 public inputs, got ${hex.length / 64}`);
  const slot = (i: number) => '0x' + hex.slice(i * 64, (i + 1) * 64);
  const provenRecipient = '0x' + slot(4).slice(-40);
  const recipient = recipientOverride ?? provenRecipient;
  try {
    const out = execFileSync(
      'cast',
      [
        'send', contract,
        'executePayment(address,bytes32,uint256,bytes32,bytes32,address,bytes)',
        owner, slot(0), String(stored.amount), slot(2), slot(3), recipient, stored.proofHex,
        '--value', String(stored.amount), '--rpc-url', rpc, '--unlocked', '--from', sender, '--json',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 }
    );
    const receipt = JSON.parse(out);
    return ok({ released: receipt.status === '0x1', txHash: receipt.transactionHash, block: Number(receipt.blockNumber), recipient, amountCents: stored.amount, amountWei: stored.amount });
  } catch (err) {
    // cast --json reports errors as JSON on stdout (cast 1.x), older versions on stderr.
    const e = err as { stderr?: string; stdout?: string };
    const stderr = [e.stdout, e.stderr].filter(Boolean).join('\n') || String(err);
    const reason = stderr.match(/reverted:?\s*([^,"\n]+)/i)?.[1] ?? stderr.split('\n').find((l) => l.trim()) ?? 'unknown';
    const known: Record<string, string> = { '0x9fc3a218': 'SumcheckFailed (proof does not verify for these public inputs)' };
    const named = reason.replace(/custom error (0x[0-9a-fA-F]{8})/, (m, sel: string) => known[sel.toLowerCase()] ?? m);
    return fail(`On-chain payment REJECTED by LeashPayment: ${named.replace(/,? data: "0x[0-9a-fA-F]*"/, '').trim()}`);
  }
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
      'Prove a payment satisfies the policy (merchant allowlist + per-transaction cap) and verify the proof. Returns the proof and verification result, or the rule the request violated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        merchant: { type: 'string', description: 'Merchant name, e.g. "openai"' },
        amountCents: { type: 'integer', minimum: 1, description: 'Amount in cents' },
        nonce: { type: 'string', description: 'Unique nonce for this payment, as a decimal integer string' },
        recipient: {
          type: 'string',
          description: 'Payee 0x address; defaults to LEASH_RECIPIENT_ADDRESS',
        },
      },
      required: ['merchant', 'amountCents', 'nonce'],
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
        const p = getDefaultPolicy();
        return ok({ name: p.name, policyCommitment: p.policyCommitment });
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
        if (typeof nonce !== 'string' || !nonce.trim()) {
          return fail('nonce must be a non-empty string');
        }
        const recipient = typeof args.recipient === 'string' ? args.recipient : undefined;
        // With a LeashPayment contract configured, prove for the EVM verifier (keccak transcript).
        const useEvmTarget = Boolean(process.env.LEASH_PAYMENT_CONTRACT_ADDRESS);

        const proof = generatePaymentProof({
          policy: getDefaultPolicy(),
          merchantName: merchant,
          amountCents,
          nonce,
          recipient,
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
          proofs.set(nonce, { proofHex: proof.proofHex, publicInputsHex: proof.publicInputsHex, amount: amountCents });
        }
        return ok({
          approved: verification.valid,
          // publicInputs.amount is the proven amount in cents (300 = $3.00), not dollars.
          amountCents,
          units: { amount: 'cents', onchain: '1 cent settles as 1 wei on the demo chain' },
          publicInputs: proof.publicInputs,
          proveMs: proof.durationMs,
          verification,
          proofHex: proof.proofHex,
        });
      }
      case 'leash_execute_onchain': {
        if (typeof args.nonce !== 'string' || !args.nonce.trim()) return fail('nonce must be a non-empty string');
        const r = args.recipient;
        if (r !== undefined && (typeof r !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r))) {
          return fail('recipient must be a 0x-prefixed 20-byte address');
        }
        return executeOnchain(args.nonce, r as string | undefined);
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

if (require.main === module) {
  createServer()
    .connect(new StdioServerTransport())
    .catch((err) => {
      console.error('[leash-mcp] failed to start:', err);
      process.exit(1);
    });
}
