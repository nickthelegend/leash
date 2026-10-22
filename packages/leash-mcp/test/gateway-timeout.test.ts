import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A gateway that accepts the connection and never answers (a real local socket, nothing simulated):
// leash-mcp's tool calls must fail with a readable timeout instead of hanging for undici's ~300 s.
const ROOT = path.resolve(__dirname, '../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-gwtimeout-'));
const client = new Client({ name: 'gateway-timeout-test', version: '1.0.0' });
const sockets: net.Socket[] = [];
const silent = http.createServer(() => undefined);
silent.on('connection', (s) => sockets.push(s));
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LEASH_') && !k.startsWith('PAYPAL_'))) as Record<string, string>;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '../dist/index.js'), '--demo'],
      cwd: ROOT,
      env: {
        ...env,
        LEASH_HOME: home,
        LEASH_GATEWAY_URL: base,
        LEASH_GATEWAY_TIMEOUT_MS: '500',
        LEASH_POLICY_OWNER_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        PAYPAL_PAYEE_MERCHANT_ID: 'ABCDEFGHJKLMN',
      },
      stderr: 'pipe',
    })
  );
}, 60_000);

afterAll(async () => {
  await client.close();
  sockets.forEach((s) => s.destroy());
  silent.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('gateway calls have a deadline (LEASH_GATEWAY_TIMEOUT_MS)', () => {
  it('a PayPal-rail payment fails readably within the limit when the gateway never answers', async () => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name: 'leash_request_payment', arguments: { merchant: 'paypal-sandbox-merchant', amountCents: 100, nonce: '4401' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(new RegExp(`^Gateway ${base.replace(/[.]/g, '\\.')} did not answer within 500 ms \\(GET /api/spend/0x[0-9a-f]{64}\\)$`));
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it('leash_receipt reports the silent gateway instead of hanging', async () => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name: 'leash_receipt', arguments: { nonce: '4401' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('did not answer within 500 ms (GET /api/receipts/4401)');
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);
});
