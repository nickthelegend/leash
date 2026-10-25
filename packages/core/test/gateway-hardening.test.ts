import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGatewayApp } from '../src/gateway/server.js';
import { PayGateway } from '../src/gateway/payGateway.js';
import { createSpendingPolicy } from '../src/policy/policy.js';
import { generatePaymentProof } from '../src/prover/prover.js';
import { verifyPaymentProof } from '../src/verifier/verifier.js';

// Real nargo + bb; the "hung bb" is a real executable that just sleeps.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-harden-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createGatewayApp(new PayGateway({ dir: path.join(dir, 'gw') })).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as any).port}`);
  } finally {
    server.close();
  }
}

describe('bb and nargo calls are bounded', () => {
  it('a bb that hangs is killed after LEASH_TOOL_TIMEOUT_MS and the proof is reported unverified, readably', () => {
    const policy = createSpendingPolicy({ name: 'hang', maxPerTxCents: 500, merchants: [{ name: 'openai' }], policySalt: '818181', spendSalt: '828282' });
    const proof = generatePaymentProof({ policy, merchantName: 'openai', amountCents: 300, nonce: '8001' });
    const hung = path.join(dir, 'bb-hangs');
    fs.writeFileSync(hung, '#!/bin/sh\nexec sleep 20\n', { mode: 0o755 });
    const saved = { BB: process.env.BB, T: process.env.LEASH_TOOL_TIMEOUT_MS };
    process.env.BB = hung;
    process.env.LEASH_TOOL_TIMEOUT_MS = '1500';
    const t0 = Date.now();
    try {
      const v = verifyPaymentProof({ proofHex: proof.proofHex, publicInputsHex: proof.publicInputsHex });
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(v.valid).toBe(false);
      expect(v.error).toMatch(/bb verify timed out after 1500 ms/);
    } finally {
      process.env.BB = saved.BB;
      if (saved.BB === undefined) delete process.env.BB;
      process.env.LEASH_TOOL_TIMEOUT_MS = saved.T;
      if (saved.T === undefined) delete process.env.LEASH_TOOL_TIMEOUT_MS;
    }
  }, 30_000);
});

describe('Express gateway surface', () => {
  it('sends no CORS allow-origin to a foreign origin (the console calls its own routes same-origin)', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const pre = await fetch(`${base}/verify`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  it('refuses a JSON body far larger than a proof (413) before parsing it', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proofHex: '0x' + 'ab'.repeat(300_000), publicInputsHex: '0x00' }),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ success: false, error: 'Body too large (limit 128kb)' });
    });
  });

  it('answers malformed JSON, unknown routes and every response in JSON, without naming the framework', async () => {
    await withServer(async (base) => {
      const bad = await fetch(`${base}/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
      expect(bad.status).toBe(400);
      expect(bad.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await bad.json()).toEqual({ success: false, error: 'Body is not valid JSON' });
      const missing = await fetch(`${base}/api/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ success: false, error: 'No route for GET /api/nope' });
      const health = await fetch(`${base}/api/health`);
      expect(health.headers.get('x-powered-by')).toBeNull();
      expect(missing.headers.get('x-powered-by')).toBeNull();
    });
  });

  it('valid JSON that is not an object (null, a string) is named as such, not as invalid JSON', async () => {
    await withServer(async (base) => {
      for (const body of ['null', '"x"', '42']) {
        const r = await fetch(`${base}/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        expect(r.status, body).toBe(400);
        expect(await r.json(), body).toEqual({ success: false, error: 'Request body must be a JSON object.' });
      }
    });
  });

  it('a malformed policy id or nonce in a read route is a 400, not an empty 200 or a 404 that echoes it', async () => {
    await withServer(async (base) => {
      const cases: [string, RegExp][] = [
        ['/api/spend/notanid', /^policyId must be 0x \+ 64 hex/],
        ['/api/spend/0x00', /^policyId must be 0x \+ 64 hex/],
        ['/api/receipts?policyId=zzz', /^policyId must be 0x \+ 64 hex/],
        ['/api/receipts/abc', /^nonce must be a decimal integer/],
        ['/api/receipts/007', /^nonce must be a decimal integer/],
        [`/api/receipts/1?policyId=0x${'g'.repeat(64)}`, /^policyId must be 0x \+ 64 hex/],
      ];
      for (const [url, error] of cases) {
        const r = await fetch(`${base}${url}`);
        expect(r.status, url).toBe(400);
        const j = await r.json();
        expect(j.success, url).toBe(false);
        expect(j.error, url).toMatch(error);
      }
      // Well-formed but unknown: still the honest empty answers.
      const id = `0x${'ab'.repeat(32)}`;
      expect(await (await fetch(`${base}/api/spend/${id}`)).json()).toEqual({ policyId: id, spend: null });
      expect((await fetch(`${base}/api/receipts/123456`)).status).toBe(404);
      expect(await (await fetch(`${base}/api/receipts?policyId=${id}`)).json()).toEqual({ receipts: [] });
    });
  });
});
