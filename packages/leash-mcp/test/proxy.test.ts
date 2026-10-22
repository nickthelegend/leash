import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256Hex, ReceiptStore } from '@leash/core';
import { orderTotalCents, splitCommand, toolPolicy } from '../src/proxy.js';

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
    expect(tools.map((t) => t.name).sort()).toEqual(['create_order', 'get_info', 'pay_order']);
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
});
