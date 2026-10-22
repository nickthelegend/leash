import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayError, getDefaultPolicy, PayGateway, PayPalService } from '@leash/core';

// One policy, two settlement rails, one daily cap. A real local Anvil (scripts/demo-anvil.sh: LeashVerifier +
// LeashPayment, escrow-funded demo policy) carries the EVM rail; a local HTTP gateway around the real
// PayGateway (bb verify, spend.json) carries the PayPal rail. PayPal has no credentials here, so the gateway
// answers 503 "Proof verified; nothing consumed" once its own checks pass; that answer is what the agent got
// before leash-mcp enforced the cap across rails.
const ROOT = path.resolve(__dirname, '../../..');
const MERCHANT = 'ABCDEFGHJKLMN';
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-xrail-'));
const demoDir = path.join(tmp, 'demo');
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
const client = new Client({ name: 'cross-rail-test', version: '1.0.0' });
let server: http.Server;
let anvilPid: number | undefined;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function body(req: http.IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) s += c;
  return JSON.parse(s || '{}');
}

async function call(name: string, args: Record<string, unknown>) {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content.map((c: any) => c.text).join('\n');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: Boolean(r.isError), text, json };
}

beforeAll(async () => {
  const anvilPort = await freePort();
  const env = { ...process.env, PATH: `${path.join(ROOT, '.tools')}:${process.env.PATH}`, LEASH_DEMO_DIR: demoDir, ANVIL_PORT: String(anvilPort), LEASH_DAILY_CAP_CENTS: '700', PAYPAL_PAYEE_MERCHANT_ID: MERCHANT };
  execFileSync(path.join(ROOT, 'scripts/demo-anvil.sh'), { cwd: ROOT, env, stdio: 'pipe' });
  anvilPid = Number(fs.readFileSync(path.join(demoDir, 'anvil.pid'), 'utf8'));
  const anvilEnv = Object.fromEntries(
    fs.readFileSync(path.join(demoDir, 'anvil.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );

  // The PayPal-rail gateway: the same PayGateway the console's /api/pay uses, with no PayPal credentials.
  const gw = new PayGateway({ dir: path.join(tmp, 'gateway'), paypal: new PayPalService({ clientId: '', clientSecret: '' }) });
  process.env.LEASH_DEMO = '1';
  process.env.LEASH_DAILY_CAP_CENTS = '700';
  process.env.PAYPAL_PAYEE_MERCHANT_ID = MERCHANT;
  const policy = getDefaultPolicy({ demo: true });
  gw.register({ owner: OWNER, policyCommitment: policy.policyCommitment, approvalThresholdCents: 0 }, { trustedOwnerDevice: true });
  server = http.createServer(async (req, res) => {
    const send = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    try {
      const spend = /^\/api\/spend\/(0x[0-9a-fA-F]{64})$/.exec(req.url ?? '');
      if (req.method === 'GET' && spend) return send(200, { policyId: spend[1].toLowerCase(), spend: gw.spendState(spend[1]) ?? null });
      if (req.method === 'POST' && req.url === '/api/pay') {
        const b = await body(req);
        const receipt = await gw.pay({ ...b, returnUrl: 'http://127.0.0.1/r', cancelUrl: 'http://127.0.0.1/c' });
        return send(200, { success: true, consumed: true, receipt });
      }
      send(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof GatewayError) return send(e.status, { success: false, error: e.message, ...e.extra });
      send(500, { success: false, error: String((e as Error).message) });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '../dist/index.js')],
      cwd: ROOT,
      env: {
        ...(Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LEASH_') && !k.startsWith('PAYPAL_'))) as Record<string, string>),
        ...anvilEnv,
        PATH: env.PATH,
        LEASH_HOME: home,
        LEASH_GATEWAY_URL: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
        PAYPAL_PAYEE_MERCHANT_ID: MERCHANT,
      },
      stderr: 'pipe',
    })
  );
}, 240_000);

afterAll(async () => {
  await client.close().catch(() => undefined);
  server?.close();
  if (anvilPid) {
    try {
      process.kill(anvilPid);
    } catch {
      // already gone
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('daily cap across rails (EVM chain + PayPal gateway, one policy, cap 700 cents)', () => {
  it('a PayPal proof made while nothing was spent is refused at release once the chain holds 700 cents', async () => {
    const early = await call('leash_request_payment', { merchant: 'paypal-sandbox-merchant', amountCents: 500, nonce: '9001' });
    expect(early.isError, early.text).toBe(false);
    expect(early.json).toMatchObject({ approved: true, rail: 'paypal', spentTodayBeforeCents: 0 });

    for (const [nonce, amountCents] of [['9002', 300], ['9003', 400]] as const) {
      const p = await call('leash_request_payment', { merchant: 'openai', amountCents, nonce });
      expect(p.json?.approved, p.text).toBe(true);
      const x = await call('leash_execute_onchain', { nonce });
      expect(x.json?.released, x.text).toBe(true);
    }

    const late = await call('leash_pay_paypal', { nonce: '9001' });
    expect(late.isError).toBe(true);
    expect(late.text).toBe('Daily cap reached across rails: 700 cents already spent today (evm 700, paypal 0) + 500 > daily cap 700 cents. Nothing was sent.');
  }, 300_000);

  it('a new PayPal payment is refused before proving when the chain already spent the cap (700 + 500 > 700)', async () => {
    const r = await call('leash_request_payment', { merchant: 'paypal-sandbox-merchant', amountCents: 500, nonce: '9004' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Daily cap reached across rails: 700 cents already spent today (evm 700, paypal 0) + 500 > daily cap 700 cents. Nothing was proved.');
    const one = await call('leash_request_payment', { merchant: 'paypal-sandbox-merchant', amountCents: 1, nonce: '9005' });
    expect(one.isError).toBe(true);
    expect(one.text).toMatch(/^Daily cap reached across rails: 700 cents already spent today/);
  }, 120_000);

  it('the EVM rail on its own still reports the circuit rule (no cross-rail wording)', async () => {
    const r = await call('leash_request_payment', { merchant: 'openai', amountCents: 100, nonce: '9006' });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/across rails/);
  }, 120_000);
});
