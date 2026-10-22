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
    });
  });
});
