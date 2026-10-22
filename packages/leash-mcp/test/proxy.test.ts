import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSpendingPolicy, keccak256Hex, policyIdOf, Receipt, ReceiptStore, SpendTracker } from '@leash/core';
import { orderTotalCents, ProofGatedProxy, splitCommand, toolPolicy } from '../src/proxy.js';

// End to end over stdio: MCP client -> leash-mcp --upstream (real nargo + bb proofs) -> echo fixture.
const ROOT = path.resolve(__dirname, '../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-proxy-'));
const echoLog = path.join(home, 'echo.jsonl');
const client = new Client({ name: 'proxy-test', version: '1.0.0' });
const forwarded = () => (fs.existsSync(echoLog) ? fs.readFileSync(echoLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');
const item = (dollars: number) => [{ name: 'credits', quantity: 1, itemCost: dollars, taxPercent: 0, itemTotal: dollars }];

beforeAll(async () => {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '../dist/index.js'), '--demo', '--upstream', `node "${path.join(__dirname, 'fixtures/echo-upstream.cjs')}"`],
      cwd: ROOT,
      env: {
        ...(process.env as Record<string, string>),
        LEASH_HOME: home,
        ECHO_LOG: echoLog,
        PAYPAL_PAYEE_MERCHANT_ID: 'ABCDEFGHJKLMN', // adds a PayPal merchant to the demo allowlist
        LEASH_POLICY_OWNER_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      },
      stderr: 'pipe',
    })
  );
}, 60_000);

afterAll(async () => {
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('helpers', () => {
  it('computes the toolkit order total in cents', () => {
    expect(orderTotalCents({ currencyCode: 'USD', items: item(3) })).toBe(300);
    expect(orderTotalCents({ currencyCode: 'USD', items: [{ itemCost: 2.5, quantity: 2, taxPercent: 10 }], shippingCost: 1, discount: 0.5 })).toBe(600);
    expect(orderTotalCents({ currencyCode: 'EUR', items: item(3) })).toMatch(/not USD/);
    expect(orderTotalCents({ currencyCode: 'USD' })).toMatch(/needs items/);
  });
  it('default-deny: only create_order / pay_order (gated) and get_* / list_* / show_* (read-only) are allowed', () => {
    expect(toolPolicy('create_order')).toBe('create');
    expect(toolPolicy('pay_order')).toBe('capture');
    for (const t of ['get_order', 'list_transactions', 'show_product_details']) expect(toolPolicy(t)).toBe('read');
    for (const t of ['create_refund', 'create_subscription', 'send_invoice', 'accept_dispute_claim', 'cancel_subscription', 'update_subscription']) {
      expect(toolPolicy(t)).toBe('deny');
    }
  });
  it('splits the upstream command', () => {
    expect(splitCommand('npx -y @paypal/mcp --tools=all')).toEqual(['npx', '-y', '@paypal/mcp', '--tools=all']);
    expect(splitCommand(`node "/a b/x.cjs"`)).toEqual(['node', '/a b/x.cjs']);
  });
});

describe('leash-mcp --upstream (proof-gated proxy)', () => {
  it('re-exports the upstream tool names; create_order now requires nonce and merchant', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_order', 'get_info', 'get_order', 'pay_order']);
    const create = tools.find((t) => t.name === 'create_order')!;
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(['currencyCode', 'items', 'nonce', 'merchant']));
  });

  it('passes read-only tools straight through', async () => {
    const r: any = await client.callTool({ name: 'get_info', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(forwarded().at(-1).tool).toBe('get_info');
  });

  it('hides and refuses a money-moving upstream tool that is not proof-gated (create_refund); nothing is forwarded', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('create_refund');
    const before = forwarded().length;
    const r: any = await client.callTool({ name: 'create_refund', arguments: { capture_id: '2GG279541U471931P', amount: { value: '3.00', currency_code: 'USD' } } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('LEASH refused: create_refund moves money and is not proof-gated');
    expect(forwarded().length).toBe(before);
  });

  it('refuses create_order without a nonce and forwards nothing', async () => {
    const before = forwarded().length;
    const r: any = await client.callTool({ name: 'create_order', arguments: { currencyCode: 'USD', items: item(3), merchant: 'paypal-sandbox-merchant' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/LEASH refused: nonce/);
    expect(forwarded().length).toBe(before);
  });

  it('refuses an over-cap order ($9.00 > $5.00) with no proof and forwards nothing', async () => {
    const before = forwarded().length;
    const r: any = await client.callTool({ name: 'create_order', arguments: { currencyCode: 'USD', items: item(9), nonce: '501', merchant: 'paypal-sandbox-merchant' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Rule R2 Violation/);
    expect(forwarded().length).toBe(before);
  });

  it('refuses a merchant outside the allowlist', async () => {
    const r: any = await client.callTool({ name: 'create_order', arguments: { currencyCode: 'USD', items: item(3), nonce: '502', merchant: 'shady_exchange' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Rule R1 Violation/);
  });

  it('refuses a PayPal order backed by an EVM-payee merchant (openai) and forwards nothing', async () => {
    const before = forwarded().length;
    const r: any = await client.callTool({ name: 'create_order', arguments: { currencyCode: 'USD', items: item(3), nonce: '504', merchant: 'openai' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^LEASH refused: merchant 'openai' is paid on the EVM rail .* not a PayPal merchant/);
    expect(forwarded().length).toBe(before);
    expect(new ReceiptStore(home).byNonce('504')).toEqual([]); // nonce not consumed
  });

  it('proves a $3.00 order, injects keccak(public inputs) into notes, forwards once, records a receipt', async () => {
    const before = forwarded().length;
    const r: any = await client.callTool({
      name: 'create_order',
      arguments: { currencyCode: 'USD', items: item(3), notes: 'gpu credits', nonce: '503', merchant: 'paypal-sandbox-merchant' },
    });
    expect(r.isError).toBeFalsy();
    const calls = forwarded();
    expect(calls.length).toBe(before + 1);
    const sent = calls.at(-1);
    expect(sent.tool).toBe('create_order');
    expect(sent.received.nonce).toBeUndefined(); // LEASH fields are stripped before forwarding
    expect(sent.received.merchant).toBeUndefined();
    const m = /^gpu credits leash:(0x[0-9a-f]{64})$/.exec(sent.received.notes);
    expect(m).not.toBeNull();

    const store = new ReceiptStore(home);
    const receipt = store.byNonce('503')[0];
    expect(receipt.amountCents).toBe(300);
    expect(receipt.custom_id).toBe(m![1]);
    const proof = store.loadProof(receipt.proofKeccak)!;
    expect(keccak256Hex(proof.publicInputsHex)).toBe(m![1]); // custom_id = keccak(public inputs)
    expect(receipt.status).toBe('FORWARDED'); // the echo upstream reports no order status
  }, 60_000);

  it('refuses a replayed nonce', async () => {
    const before = forwarded().length;
    const r: any = await client.callTool({ name: 'create_order', arguments: { currencyCode: 'USD', items: item(1), nonce: '503', merchant: 'paypal-sandbox-merchant' } });
    expect(textOf(r)).toMatch(/nonce 503 already used/);
    expect(forwarded().length).toBe(before);
  });

  it('refuses pay_order for an order that no verified proof created', async () => {
    const before = forwarded().length;
    const r: any = await client.callTool({ name: 'pay_order', arguments: { id: '5O190127TN364715T' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not created through a verified LEASH proof/);
    expect(forwarded().length).toBe(before);
  });

  it('counts what this device released on chain today against the same daily cap (1300 on chain + 300 here + 300 > 1500)', async () => {
    const policyId = new ReceiptStore(home).byNonce('503')[0].policyId;
    // This device's record of today's on-chain releases (what leash-mcp writes after LeashPayment accepts one).
    const evmRecord = path.join(home, 'spend', `${policyId.toLowerCase().replace(/[^0-9a-z]/g, '')}.json`);
    fs.writeFileSync(evmRecord, JSON.stringify({ epoch: Math.floor(Date.now() / 86_400_000), spentCents: 1300, commit: `0x${'1'.repeat(64)}` }));
    try {
      const before = forwarded().length;
      const r: any = await client.callTool({ name: 'create_order', arguments: { currencyCode: 'USD', items: item(3), nonce: '505', merchant: 'paypal-sandbox-merchant' } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe(
        'LEASH refused: Daily cap reached across rails: 1600 cents already spent today (evm 1300, paypal-mcp 300) + 300 > daily cap 1500 cents. Nothing was proved or forwarded.'
      );
      expect(forwarded().length).toBe(before);
      expect(new ReceiptStore(home).byNonce('505')).toEqual([]); // nonce not consumed
    } finally {
      fs.rmSync(evmRecord, { force: true });
    }
  });
});

// In-process proxy over the same echo upstream, with receipts placed in its store: pay_order must only
// ever forward for an order that is AWAITING_APPROVAL and whose PayPal payee is the allowlisted one.
describe('pay_order is refused unless the order awaits approval and its payee is verified', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-capture-'));
  const log = path.join(dir, 'echo.jsonl');
  const replies = path.join(dir, 'replies.json');
  const reply = (r: Record<string, unknown>) => fs.writeFileSync(replies, JSON.stringify(r));
  const order = (id: string, value: string, currency = 'USD') => ({
    id,
    status: 'PAYER_ACTION_REQUIRED',
    purchase_units: [{ payee: { merchant_id: 'ABCDEFGHJKLMN' }, amount: { currency_code: currency, value } }],
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const policy = createSpendingPolicy({
    name: 'capture rules',
    maxPerTxCents: 500,
    merchants: [{ name: 'paypal-shop', paypalMerchantId: 'ABCDEFGHJKLMN' }, { name: 'openai' }],
    policySalt: '515151',
    spendSalt: '525252',
  });
  const policyId = policyIdOf('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', policy.policyCommitment);
  const store = new ReceiptStore(dir);
  let proxy: ProofGatedProxy;
  const receipt = (nonce: string, orderId: string, extra: Partial<Receipt>): Receipt => ({
    policyId,
    nonce,
    amountCents: 300,
    merchantIdHash: policy.merchantLeaves[0].hash,
    recipient: policy.merchantLeaves[0].payee,
    epoch: 20748,
    newSpendCommit: '0x' + '1'.repeat(64),
    proofKeccak: '0x' + '2'.repeat(64),
    vkHash: 'test',
    proofTarget: 'default',
    rail: 'paypal',
    status: 'AWAITING_APPROVAL',
    paypalOrderId: orderId,
    ts: new Date().toISOString(),
    ...extra,
  });

  beforeAll(async () => {
    process.env.ECHO_LOG = log;
    process.env.ECHO_REPLIES = replies;
    proxy = new ProofGatedProxy({
      upstream: [process.execPath, path.join(__dirname, 'fixtures/echo-upstream.cjs')],
      policy,
      policyId,
      receipts: store,
      spend: new SpendTracker(false),
    });
    await proxy.connect();
  }, 60_000);
  afterAll(async () => {
    await proxy.close();
    delete process.env.ECHO_LOG;
    delete process.env.ECHO_REPLIES;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a FAILED order (payee mismatch flagged at create) is never captured', async () => {
    store.put(receipt('601', 'ORDER-MISMATCH', { status: 'FAILED', error: 'upstream order payee ZZZZZZZZZZZZZ is not the allowlisted ABCDEFGHJKLMN' }));
    const r = await proxy.call('pay_order', { id: 'ORDER-MISMATCH' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^LEASH refused: order ORDER-MISMATCH is FAILED \(upstream order payee ZZZZZZZZZZZZZ/);
    expect(calls().filter((c) => c.tool === 'pay_order')).toEqual([]);
  });

  it('an order the upstream gave no status for (FORWARDED) is never captured', async () => {
    store.put(receipt('602', 'ORDER-NOSTATUS', { status: 'FORWARDED' }));
    const r = await proxy.call('pay_order', { id: 'ORDER-NOSTATUS' });
    expect(textOf(r)).toMatch(/^LEASH refused: order ORDER-NOSTATUS is FORWARDED; only an order awaiting approval can be captured/);
    expect(calls().filter((c) => c.tool === 'pay_order')).toEqual([]);
  });

  it('an awaiting order whose payee was never reported is checked with get_order first, and refused when PayPal names no payee', async () => {
    store.put(receipt('603', 'ORDER-NOPAYEE', { status: 'AWAITING_APPROVAL' }));
    const r = await proxy.call('pay_order', { id: 'ORDER-NOPAYEE' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/payee\.merchant_id, so the payee is unverified; not capturing/);
    const c = calls();
    expect(c.filter((x) => x.tool === 'get_order').map((x) => x.received)).toEqual([{ id: 'ORDER-NOPAYEE' }]); // read-only check
    expect(c.filter((x) => x.tool === 'pay_order')).toEqual([]);
  });

  it('an order created for the right payee but the wrong amount ($30.00 for a 300-cent proof) is FAILED at create, and pay_order is never forwarded', async () => {
    reply({ create_order: order('ORDER-AMOUNT', '30.00') });
    const created = await proxy.call('create_order', { currencyCode: 'USD', items: item(3), nonce: '611', merchant: 'paypal-shop' });
    expect(textOf(created)).toMatch(/"amountMismatch":true/);
    const r = store.byOrderId('ORDER-AMOUNT')!;
    expect(r.status).toBe('FAILED');
    expect(r.payeeVerified).toBe(false);
    expect(r.error).toMatch(/upstream order amount 30\.00 USD is not the proven 300 cents/);
    const paid = await proxy.call('pay_order', { id: 'ORDER-AMOUNT' });
    expect(paid.isError).toBe(true);
    expect(textOf(paid)).toMatch(/^LEASH refused: order ORDER-AMOUNT is FAILED/);
    expect(calls().filter((c) => c.tool === 'pay_order')).toEqual([]);
  }, 60_000);

  it('an order whose amount matched at create but reads back changed ($30.00) from get_order is refused before pay_order is forwarded', async () => {
    reply({ create_order: order('ORDER-REREAD', '3.00') });
    await proxy.call('create_order', { currencyCode: 'USD', items: item(3), nonce: '612', merchant: 'paypal-shop' });
    const r = store.byOrderId('ORDER-REREAD')!;
    expect(r.status).toBe('AWAITING_APPROVAL');
    expect(r.payeeVerified).toBe(true);
    reply({ get_order: order('ORDER-REREAD', '30.00') });
    const paid = await proxy.call('pay_order', { id: 'ORDER-REREAD' });
    expect(paid.isError).toBe(true);
    expect(textOf(paid)).toMatch(/^LEASH refused: order ORDER-REREAD: amount 30\.00 USD is not the proven 300 cents; not capturing/);
    expect(calls().filter((c) => c.tool === 'get_order').at(-1)!.received).toEqual({ id: 'ORDER-REREAD' });
    expect(calls().filter((c) => c.tool === 'pay_order')).toEqual([]);
  }, 60_000);

  it('an order whose get_order reports no amount is refused before pay_order is forwarded', async () => {
    reply({ create_order: order('ORDER-NOAMT', '3.00') });
    await proxy.call('create_order', { currencyCode: 'USD', items: item(3), nonce: '613', merchant: 'paypal-shop' });
    reply({ get_order: { id: 'ORDER-NOAMT', status: 'APPROVED', purchase_units: [{ payee: { merchant_id: 'ABCDEFGHJKLMN' } }] } });
    const paid = await proxy.call('pay_order', { id: 'ORDER-NOAMT' });
    expect(textOf(paid)).toMatch(/^LEASH refused: order ORDER-NOAMT: PayPal did not report purchase_units\[0\]\.amount/);
    expect(calls().filter((c) => c.tool === 'pay_order')).toEqual([]);
  }, 60_000);
});
