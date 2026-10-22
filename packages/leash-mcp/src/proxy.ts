/**
 * Proof-gated MCP proxy: `leash-mcp --upstream "<command> [args…]"`.
 *
 * Sits in front of another MCP server (meant for PayPal's official agent toolkit server,
 * `npx -y @paypal/mcp --tools=all`, whose order tools are create_order / get_order / pay_order:
 * https://github.com/paypal/agent-toolkit) and re-exports its tools under the same names.
 * Payment tools are gated:
 *   create_order  needs { nonce, merchant } on top of the upstream arguments. The proxy computes the
 *                 order total from the upstream arguments, proves locally (nargo + bb) that paying that
 *                 many cents to that merchant fits the policy, verifies the proof, injects
 *                 custom_id = keccak256(public inputs) into the forwarded call, forwards, and records a
 *                 receipt. No valid proof, no upstream call.
 *   pay_order     only for an order this proxy created from a verified proof. Before every capture the
 *                 order is read back with get_order: its payee must be the allowlisted PayPal merchant
 *                 and its amount exactly the proven cents in USD, or nothing is forwarded. The capture
 *                 must then come back COMPLETED for exactly the proven cents.
 * Default-deny for everything else: only read-only tools (get_*, list_*, show_*) pass through unchanged.
 * Every other upstream tool (under `--tools=all` that includes create_refund, create_subscription,
 * send_invoice, accept_dispute_claim, …) is hidden from tools/list and refused with "LEASH refused:
 * <tool> moves money and is not proof-gated"; nothing is forwarded.
 *
 * @paypal/mcp's create_order schema has no custom_id field (it takes items, currencyCode, notes, …),
 * so when the upstream tool has no `custom_id` property the binding goes into `notes` as
 * "leash:<keccak>"; the receipt records which field carried it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  assertCaptureMatches,
  currentEpoch,
  generatePaymentProof,
  keccak256Hex,
  NONCE_RE,
  proofKeccak,
  Receipt,
  ReceiptStore,
  SpendingPolicy,
  SpendTracker,
  valueToCents,
  verifyPaymentProof,
  vkHash,
} from '@leash/core';
import { crossRailRefusal, railKey, RailTotals } from './ledger.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type UpstreamTool = { name: string; description?: string; inputSchema: { type: 'object'; properties?: Record<string, any>; required?: string[] } };

export const GATED_CREATE = new Set(['create_order']);
export const GATED_CAPTURE = new Set(['pay_order']);
/** Read-only upstream tools that pass through with no proof (default-deny for everything else). */
export const READ_ONLY = /^(get|list|show)_[a-z0-9_]+$/;

/** How the proxy treats an upstream tool: proof-gated, read-only passthrough, or hidden and refused. */
export function toolPolicy(name: string): 'create' | 'capture' | 'read' | 'deny' {
  if (GATED_CREATE.has(name)) return 'create';
  if (GATED_CAPTURE.has(name)) return 'capture';
  return READ_ONLY.test(name) ? 'read' : 'deny';
}

const refuse = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `LEASH refused: ${msg}` }], isError: true });
const text = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });

/** Split a shell-ish command string: `npx -y @paypal/mcp --tools=all` -> ['npx', '-y', …]. Quotes group words. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Order total in cents from @paypal/agent-toolkit create_order arguments: sum of
 * itemCost * quantity, plus tax (taxPercent), plus shippingCost, minus discount; currency must be USD.
 * Returns an error string when the total can't be determined, so the call is refused rather than
 * forwarded with an amount the proof doesn't cover.
 */
export function orderTotalCents(args: Record<string, any>): number | string {
  if (args.currencyCode !== undefined && args.currencyCode !== 'USD') return `currencyCode ${args.currencyCode} is not USD`;
  const items = args.items;
  if (!Array.isArray(items) || items.length === 0) return 'create_order needs items to compute the amount';
  let total = 0;
  for (const it of items) {
    const cost = Number(it?.itemCost);
    const qty = Number(it?.quantity ?? 1);
    const tax = Number(it?.taxPercent ?? 0);
    if (!Number.isFinite(cost) || cost < 0 || !Number.isInteger(qty) || qty <= 0 || !Number.isFinite(tax) || tax < 0) {
      return 'items need a non-negative itemCost, a positive integer quantity and a non-negative taxPercent';
    }
    total += cost * qty * (1 + tax / 100);
  }
  total += Number(args.shippingCost ?? 0) - Number(args.discount ?? 0);
  const cents = Math.round(total * 100);
  if (!Number.isFinite(cents) || cents <= 0) return 'order total must be positive';
  return cents;
}

/** purchase_units[0].amount as cents, or an error string when it is missing, not USD or unparseable. */
export function unitAmountCents(unit: any): number | string {
  const value = unit?.amount?.value;
  if (value === undefined || value === null) return 'missing';
  const currency = unit?.amount?.currency_code;
  if (currency !== 'USD') return `${value} ${currency ?? '(no currency)'}`;
  try {
    return valueToCents(String(value));
  } catch {
    return `${value} ${currency}`;
  }
}

function parseJson(r: ToolResult): any {
  try {
    return JSON.parse(r.content.map((c) => c.text).join(''));
  } catch {
    return undefined;
  }
}

export interface ProxyOptions {
  upstream: string[];
  policy: SpendingPolicy;
  policyId: string;
  receipts?: ReceiptStore;
  spend?: SpendTracker;
}

export class ProofGatedProxy {
  private client = new Client({ name: 'leash-mcp-proxy', version: '1.0.0' });
  private tools: UpstreamTool[] = [];
  private readonly receipts: ReceiptStore;
  private readonly spend: SpendTracker;

  constructor(private readonly opts: ProxyOptions) {
    this.receipts = opts.receipts ?? new ReceiptStore();
    this.spend = opts.spend ?? new SpendTracker(true);
  }

  async connect(): Promise<void> {
    const [command, ...args] = this.opts.upstream;
    if (!command) throw new Error('--upstream needs a command');
    await this.client.connect(new StdioClientTransport({ command, args, env: process.env as Record<string, string>, stderr: 'inherit' }));
    this.tools = (await this.client.listTools()).tools as UpstreamTool[];
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Upstream tools, same names; gated create tools also require nonce + merchant. Denied tools are hidden. */
  listTools(): UpstreamTool[] {
    return this.tools.filter((t) => toolPolicy(t.name) !== 'deny').map((t) => {
      if (!GATED_CREATE.has(t.name)) {
        return GATED_CAPTURE.has(t.name)
          ? { ...t, description: `${t.description ?? ''} [LEASH: only for orders created from a verified proof]`.trim() }
          : t;
      }
      return {
        ...t,
        description: `${t.description ?? ''} [LEASH: proof-gated. Add nonce (unique decimal string) and merchant (allowlisted name); the order total must fit the spending policy.]`.trim(),
        inputSchema: {
          ...t.inputSchema,
          properties: {
            ...(t.inputSchema.properties ?? {}),
            nonce: { type: 'string', description: 'LEASH payment nonce (decimal string, unique per policy)' },
            merchant: { type: 'string', description: 'LEASH allowlisted merchant this order pays' },
          },
          required: [...new Set([...(t.inputSchema.required ?? []), 'nonce', 'merchant'])],
        },
      };
    });
  }

  async call(name: string, args: Record<string, any>): Promise<ToolResult> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return refuse(`unknown tool ${name}`);
    switch (toolPolicy(name)) {
      case 'create':
        return this.gatedCreate(tool, args);
      case 'capture':
        return this.gatedCapture(args);
      case 'read':
        return (await this.client.callTool({ name, arguments: args })) as ToolResult;
      default:
        return refuse(`${name} moves money and is not proof-gated`);
    }
  }

  private async gatedCreate(tool: UpstreamTool, args: Record<string, any>): Promise<ToolResult> {
    const { nonce, merchant, ...upstreamArgs } = args;
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return refuse('nonce (decimal string, no leading zeros) is required for a payment tool');
    if (typeof merchant !== 'string' || !merchant.trim()) return refuse('merchant is required for a payment tool');
    if (this.receipts.isNonceUsed(this.opts.policyId, nonce)) return refuse(`nonce ${nonce} already used`);
    const amountCents = orderTotalCents(upstreamArgs);
    if (typeof amountCents === 'string') return refuse(amountCents);

    const { policy, policyId } = this.opts;
    // Only a PayPal merchant's proof may authorize a PayPal order: a proof for an EVM-payee merchant
    // (e.g. openai) binds an EVM address, which says nothing about who the PayPal order pays.
    // (An unlisted merchant falls through to the prover, which refuses it as Rule R1.)
    const listed = policy.merchantLeaves.find((m) => m.name === merchant.trim().toLowerCase());
    if (listed && !listed.paypalMerchantId) {
      return refuse(`merchant '${listed.name}' is paid on the EVM rail (payee ${listed.payee}), not a PayPal merchant; its proof can't authorize a PayPal order`);
    }
    const epoch = currentEpoch();
    // The proxy's orders are their own spend chain (rail "paypal-mcp"); the policy's daily cap covers it
    // together with what this device released on chain and through the gateway today.
    const proxyKey = railKey(policyId, 'proxy');
    const spendInputs = this.spend.inputs(proxyKey, epoch);
    const today = (key: string) => {
      const s = this.spend.get(key);
      return s && s.epoch === epoch ? s.spentCents : 0;
    };
    const totals: RailTotals = { evm: today(railKey(policyId, 'evm')) };
    if (today(railKey(policyId, 'paypal')) > 0) totals.paypal = today(railKey(policyId, 'paypal'));
    totals.proxy = spendInputs.spentBeforeCents;
    const overCap = crossRailRefusal({ rail: 'proxy', totals, amountCents, dailyCapCents: policy.dailyCapCents, outcome: 'Nothing was proved or forwarded.' });
    if (overCap) return refuse(overCap);
    let proof;
    try {
      proof = generatePaymentProof({ policy, merchantName: merchant, amountCents, nonce, spend: spendInputs });
    } catch (e: any) {
      return refuse(`no proof for ${amountCents} cents to '${merchant}': ${String(e.message).split('\n')[0]}`);
    }
    const v = verifyPaymentProof({ proofHex: proof.proofHex, publicInputsHex: proof.publicInputsHex, expectedAmount: amountCents, expectedNonce: nonce });
    if (!v.valid) return refuse(`proof did not verify: ${v.error}`);

    // Bind the forwarded call to this exact proof.
    const customId = keccak256Hex(proof.publicInputsHex);
    const props = tool.inputSchema.properties ?? {};
    const boundVia = 'custom_id' in props ? 'custom_id' : 'notes' in props ? 'notes' : null;
    if (!boundVia) return refuse(`upstream ${tool.name} has neither custom_id nor notes to carry the proof binding`);
    const forwarded =
      boundVia === 'custom_id'
        ? { ...upstreamArgs, custom_id: customId }
        : { ...upstreamArgs, notes: [upstreamArgs.notes, `leash:${customId}`].filter(Boolean).join(' ') };

    // Consume nonce + spend before the upstream call so a parallel call with the same nonce/prev fails.
    const leaf = listed!; // the prover refused unlisted merchants above
    const base: Receipt = {
      policyId,
      nonce,
      amountCents,
      merchantIdHash: proof.publicInputs.merchant_id_hash,
      recipient: proof.publicInputs.recipient,
      epoch,
      newSpendCommit: proof.publicInputs.new_spend_commit,
      proofKeccak: proofKeccak(proof.proofHex),
      vkHash: vkHash('default'),
      proofTarget: 'default',
      rail: 'paypal',
      status: 'FAILED',
      custom_id: customId,
      ts: new Date().toISOString(),
    };
    this.receipts.saveProof({ proofHex: proof.proofHex, publicInputsHex: proof.publicInputsHex, proofTarget: 'default' });
    this.receipts.put({ ...base, error: `forwarding ${tool.name} (binding in ${boundVia})` });
    this.spend.advance(proxyKey, { epoch, spentBeforeCents: spendInputs.spentBeforeCents, amountCents, newSpendCommit: proof.publicInputs.new_spend_commit });

    const result = (await this.client.callTool({ name: tool.name, arguments: forwarded })) as ToolResult;
    const order = parseJson(result);
    const unit = order?.purchase_units?.[0];
    const payee = unit?.payee?.merchant_id;
    const status: Receipt['status'] = result.isError
      ? 'FAILED'
      : order?.status === 'PAYER_ACTION_REQUIRED' || order?.status === 'CREATED'
        ? 'AWAITING_APPROVAL'
        : 'FORWARDED';
    const payeeMismatch = Boolean(payee && payee !== leaf.paypalMerchantId);
    // An amount the response reports must be the proven cents in USD; an absent one is checked with
    // get_order before capture (as every order is).
    const reported = unitAmountCents(unit);
    const amountMismatch = reported !== 'missing' && reported !== amountCents;
    const error = payeeMismatch
      ? `upstream order payee ${payee} is not the allowlisted ${leaf.paypalMerchantId}`
      : amountMismatch
        ? `upstream order amount ${typeof reported === 'number' ? `${unit.amount.value} USD` : reported} is not the proven ${amountCents} cents`
        : result.isError
          ? 'upstream error'
          : undefined;
    this.receipts.put({
      ...base,
      status: payeeMismatch || amountMismatch ? 'FAILED' : status,
      // Verified only when PayPal named the allowlisted payee AND the proven amount.
      payeeVerified: Boolean(payee) && !payeeMismatch && typeof reported === 'number' && !amountMismatch,
      paypalOrderId: typeof order?.id === 'string' ? order.id : undefined,
      approveUrl: order?.links?.find?.((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href,
      error,
      ts: new Date().toISOString(),
    });
    return {
      ...result,
      content: [
        ...result.content,
        { type: 'text', text: JSON.stringify({ leash: { proven: true, amountCents, nonce, custom_id: customId, boundVia, payeeMismatch, amountMismatch } }) },
      ],
    };
  }

  /**
   * Right before every capture: read the order back with the upstream's read-only get_order and
   * require purchase_units[0].payee.merchant_id to be the allowlisted PayPal merchant and
   * purchase_units[0].amount to be exactly the proven cents in USD. The order can change between
   * create and capture, so a match at create time is not enough. Returns a refusal (nothing is
   * forwarded), or undefined when the order is verified (the receipt is updated).
   */
  private async verifyOrder(id: string, r: Receipt): Promise<ToolResult | undefined> {
    const leaf = this.opts.policy.merchantLeaves.find((m) => m.hash === r.merchantIdHash);
    if (!leaf?.paypalMerchantId) return refuse(`order ${id}: its proof is not for a PayPal merchant in this policy`);
    if (!this.tools.some((t) => t.name === 'get_order')) {
      return refuse(`order ${id}: the upstream has no get_order to check the payee and amount before capture`);
    }
    const got = (await this.client.callTool({ name: 'get_order', arguments: { id } })) as ToolResult;
    const order = got.isError ? undefined : parseJson(got);
    const unit = order?.purchase_units?.[0];
    const payee = unit?.payee?.merchant_id;
    if (!payee) {
      return refuse(`order ${id}: PayPal did not report purchase_units[0].payee.merchant_id, so the payee is unverified; not capturing`);
    }
    if (payee !== leaf.paypalMerchantId) {
      const error = `order payee ${payee} is not the allowlisted ${leaf.paypalMerchantId}`;
      this.receipts.put({ ...r, status: 'FAILED', payeeVerified: false, error, ts: new Date().toISOString() });
      return refuse(`order ${id}: ${error}; not capturing`);
    }
    const cents = unitAmountCents(unit);
    if (cents === 'missing') {
      return refuse(`order ${id}: PayPal did not report purchase_units[0].amount, so the amount is unverified; not capturing`);
    }
    if (cents !== r.amountCents) {
      const error = `amount ${typeof cents === 'number' ? `${unit.amount.value} USD` : cents} is not the proven ${r.amountCents} cents`;
      this.receipts.put({ ...r, status: 'FAILED', payeeVerified: false, error, ts: new Date().toISOString() });
      return refuse(`order ${id}: ${error}; not capturing`);
    }
    if (!r.payeeVerified) this.receipts.put({ ...r, payeeVerified: true, ts: new Date().toISOString() });
    return undefined;
  }

  private async gatedCapture(args: Record<string, any>): Promise<ToolResult> {
    const id = args?.id;
    let r = typeof id === 'string' ? this.receipts.byOrderId(id) : undefined;
    if (!r) return refuse(`order ${String(id)} was not created through a verified LEASH proof`);
    if (r.status === 'COMPLETED') return refuse(`order ${id} is already captured`);
    // Same rule as PayGateway.capture: only an order waiting for the buyer can be captured. A FAILED
    // order (payee mismatch, upstream error) or one the upstream gave no status for never is.
    if (r.status !== 'AWAITING_APPROVAL') {
      return refuse(`order ${id} is ${r.status}${r.error ? ` (${r.error})` : ''}; only an order awaiting approval can be captured`);
    }
    const unverified = await this.verifyOrder(id, r);
    if (unverified) return unverified;
    r = this.receipts.byOrderId(id)!;
    const result = (await this.client.callTool({ name: 'pay_order', arguments: { id } })) as ToolResult;
    if (result.isError) return result;
    try {
      const cap = assertCaptureMatches(parseJson(result), { amountCents: r.amountCents });
      this.receipts.put({ ...r, status: 'COMPLETED', captureId: cap.captureId, error: undefined, ts: new Date().toISOString() });
    } catch (e: any) {
      this.receipts.put({ ...r, status: 'FAILED', error: e.message, ts: new Date().toISOString() });
      return { ...result, isError: true, content: [...result.content, { type: 'text', text: `LEASH: capture does not match the proof: ${e.message}` }] };
    }
    return result;
  }
}

/** MCP server that exposes the proxied tools over stdio. */
export function createProxyServer(proxy: ProofGatedProxy): Server {
  const server = new Server({ name: 'leash-mcp-proxy', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: proxy.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => proxy.call(req.params.name, (req.params.arguments ?? {}) as Record<string, any>));
  return server;
}
