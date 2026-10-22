/**
 * The owner-device routes (prove, create policy, matrix, PayPal vault) hold the policy secrets. They answer
 * only this machine's own console: Host must be loopback (no LAN, no DNS rebinding), a browser request
 * must be same-origin, and a body must be JSON (no cross-site text/plain POST, i.e. no CSRF). /api/prove
 * proves only the policy it is sent, never a stored one. Runs against the e2e console (127.0.0.1:3107).
 */
import { test, expect, BASE } from './fixtures';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const OTHER_OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** A raw HTTP request to the console with full control of Host and other headers (Node's fetch can't set Host). */
function raw(method: string, pathName: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: any }> {
  const u = new URL(pathName, BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { ...headers, ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = { text };
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const proveBody = (policy: unknown) => JSON.stringify({ policy, merchantName: 'openai', amountCents: 300, nonce: '9', useEvmTarget: true });

test.describe('owner-device routes answer only this machine’s console', () => {
  let policy: any;
  test.beforeAll(async ({ request }) => {
    const created = await (await request.post('/api/policies', { data: { name: 'Owner-device check', maxPerTxCents: 500, merchants: ['openai'] } })).json();
    policy = created.policy;
    expect(policy?.policyCommitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('the console binds 127.0.0.1 in dev and start (no LAN listener)', async () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/package.json'), 'utf8')).scripts;
    expect(scripts.dev).toMatch(/next dev -H 127\.0\.0\.1\b/);
    expect(scripts.start).toMatch(/next start -H 127\.0\.0\.1\b/);
  });

  test('loopback, JSON, with a policy: proves (the control case)', async () => {
    const r = await raw('POST', '/api/prove', { host: new URL(BASE).host, 'content-type': 'application/json' }, proveBody(policy));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.publicInputs.policy_commitment).toBe(policy.policyCommitment);
  });

  test('no policy in the body: 400, no fallback to the owner’s stored policy', async () => {
    const r = await raw('POST', '/api/prove', { host: new URL(BASE).host, 'content-type': 'application/json' }, JSON.stringify({ merchantName: 'openai', amountCents: 300, nonce: '9', useEvmTarget: true }));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Missing required parameter: policy/);
    expect(r.json.proofHex).toBeUndefined();
  });

  test('a hex, zero-padded or TOML-injection nonce: 400 before nargo runs', async () => {
    for (const nonce of ['0x0bb9', '03001', '1"\nmax_per_tx = "1']) {
      const r = await raw('POST', '/api/prove', { host: new URL(BASE).host, 'content-type': 'application/json' }, JSON.stringify({ policy, merchantName: 'openai', amountCents: 300, nonce }));
      expect(r.status, nonce).toBe(400);
      expect(r.json.error).toMatch(/^nonce must be a decimal integer string without leading zeros/);
    }
  });

  test('bad amount, merchant or recipient: 400 kind "input", never 503 "setup" (the console would say "Prover unavailable")', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ amountCents: 'abc' }, 'amountCents must be a positive integer (cents)'],
      [{ amountCents: -5 }, 'amountCents must be a positive integer (cents)'],
      [{ amountCents: 2.5 }, 'amountCents must be a positive integer (cents)'],
      [{ merchantName: 42 }, 'merchantName must be a non-empty string'],
      [{ merchantName: '   ' }, 'merchantName must be a non-empty string'],
      [{ recipient: 'not-an-address' }, 'recipient must be a 0x-prefixed 20-byte address'],
    ];
    for (const [patch, error] of cases) {
      const body = JSON.stringify({ policy, merchantName: 'openai', amountCents: 300, nonce: '9', ...patch });
      const r = await raw('POST', '/api/prove', { host: new URL(BASE).host, 'content-type': 'application/json' }, body);
      expect(r.status, JSON.stringify(patch)).toBe(400);
      expect(r.json).toEqual({ success: false, kind: 'input', error });
    }
  });

  test('text/plain body (a cross-site form or no-cors fetch): 415, no proof', async () => {
    const r = await raw('POST', '/api/prove', { host: new URL(BASE).host, 'content-type': 'text/plain' }, proveBody(policy));
    expect(r.status).toBe(415);
    expect(r.json.proofHex).toBeUndefined();
  });

  test('a LAN or rebinding Host: 403 on /api/prove and /api/harness', async () => {
    for (const host of ['192.168.1.20:3107', 'attacker.example:3107']) {
      const p = await raw('POST', '/api/prove', { host, 'content-type': 'application/json' }, proveBody(policy));
      expect(p.status, host).toBe(403);
      expect(p.json.error).toMatch(/only requests to localhost \/ 127\.0\.0\.1/);
      const h = await raw('GET', '/api/harness', { host });
      expect(h.status, host).toBe(403);
    }
  });

  test('Sec-Fetch-Site cross-site / same-site: 403', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await raw('POST', '/api/prove', { host: new URL(BASE).host, 'content-type': 'application/json', 'sec-fetch-site': site }, proveBody(policy));
      expect(r.status, site).toBe(403);
    }
  });

  test('in Chrome: a page on another origin cannot create and register a policy with a no-cors text/plain POST', async ({ page, request, guard }) => {
    guard.allow('/api/policies', 403); // Sec-Fetch-Site: cross-site
    guard.allow('/api/policies', 415); // text/plain
    const count = async () => ((await (await request.get('/api/policies')).json()).policies as unknown[]).length;
    const before = await count();
    // http://localhost:3107 is another site than http://127.0.0.1:3107: Chrome marks the request cross-site.
    const other = BASE.replace('127.0.0.1', 'localhost');
    await page.goto(`${other}/robots-missing-${Date.now()}`).catch(() => undefined);
    await page.evaluate(async (target) => {
      await fetch(`${target}/api/policies`, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ name: 'csrf', maxPerTxCents: 50000, approvalThresholdCents: 50000, merchants: ['openai'] }),
      }).catch(() => undefined);
    }, BASE);
    await page.waitForTimeout(1500);
    expect(await count()).toBe(before);
  });

  test('PayPal vault confirm for another owner: 403 before any PayPal call', async ({ request }) => {
    const r = await request.post('/api/paypal/vault', {
      data: { action: 'confirm', owner: OTHER_OWNER, policyCommitment: policy.policyCommitment, approvalThresholdCents: 50000, setupTokenId: '5C991763VB2781612' },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toMatch(/owner must be this console's owner/);
  });

  test('/api/pay off localhost without LEASH_PUBLIC_URL: Setup required, no return link built from the Host header', async () => {
    const r = await raw('POST', '/api/pay', { host: 'attacker.example', 'content-type': 'application/json' }, JSON.stringify({}));
    expect(r.status).toBe(503);
    expect(r.json.error).toMatch(/^Setup required \(LEASH_PUBLIC_URL\)/);
  });
});
