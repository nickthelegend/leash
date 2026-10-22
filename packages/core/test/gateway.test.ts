import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { paypalPayee, policyIdOf } from '../src/crypto/evm.js';
import { GatewayError, PayGateway } from '../src/gateway/payGateway.js';
import { proofKeccak, Receipt } from '../src/gateway/receipts.js';
import { createGatewayApp } from '../src/gateway/server.js';
import { PayPalService } from '../src/paypal/paypal.js';
import { createSpendingPolicy } from '../src/policy/policy.js';
import { generatePaymentProof } from '../src/prover/prover.js';
import { currentEpoch } from '../src/spend/spendState.js';

// Real nargo + bb proofs against the verify-only gateway. PayPal has no credentials here, so every
// path that would reach PayPal must stop at "Setup required" without consuming anything.
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const MERCHANT = 'ABCDEFGHJKLMN';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-gw-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const policy = createSpendingPolicy({
  name: 'gateway test',
  maxPerTxCents: 500,
  dailyCapCents: 1000,
  merchants: [{ name: 'paypal-shop', paypalMerchantId: MERCHANT }, { name: 'openai' }],
  policySalt: '424242',
  spendSalt: '434343',
});
const policyId = policyIdOf(OWNER, policy.policyCommitment);
const noKeys = new PayPalService({ clientId: '', clientSecret: '' });
const gw = new PayGateway({ dir, paypal: noKeys });
const urls = { returnUrl: 'http://localhost:3000/r', cancelUrl: 'http://localhost:3000/c' };

const prove = (nonce: string, opts: { merchant?: string; amount?: number; epoch?: number } = {}) =>
  generatePaymentProof({
    policy,
    merchantName: opts.merchant ?? 'paypal-shop',
    amountCents: opts.amount ?? 300,
    nonce,
    spend: { epoch: opts.epoch ?? currentEpoch(), prevSpendCommit: '0', spentBeforeCents: 0 },
  });

async function payError(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayError);
    return e as GatewayError;
  }
  throw new Error('expected the gateway to refuse');
}

describe('PayGateway (verify-only, real bb)', () => {
  const proof = prove('7001');

  it('binds a PayPal merchant into the proof: recipient = paypalPayee(merchant id)', () => {
    expect(proof.publicInputs.recipient).toBe(paypalPayee(MERCHANT).toLowerCase());
  });

  it('refuses a policy that is not registered for this owner', async () => {
    const e = await payError(gw.pay({ owner: OWNER, ...proof, paypalMerchantId: MERCHANT, ...urls }));
    expect(e.status).toBe(404);
  });

  it('registers public data only', () => {
    const reg = gw.register({ owner: OWNER, policyCommitment: policy.policyCommitment, approvalThresholdCents: 200 }, { trustedOwnerDevice: true });
    expect(reg.policyId).toBe(policyId);
    expect(Object.keys(reg).sort()).toEqual(['approvalThresholdCents', 'createdAt', 'owner', 'policyCommitment', 'policyId', 'vaultId', 'version'].sort());
  });

  it('verified proof + no PayPal keys: 503 Setup required (PAYPAL_CLIENT_ID), nothing consumed', async () => {
    const e = await payError(gw.pay({ owner: OWNER, ...proof, paypalMerchantId: MERCHANT, ...urls }));
    expect(e.status).toBe(503);
    expect(e.message).toBe('Proof verified; nothing consumed. Setup required (PAYPAL_CLIENT_ID)');
    expect(gw.receipts.isNonceUsed(policyId, '7001')).toBe(false);
    expect(gw.spendState(policyId)).toBeUndefined();
  });

  it('rejects a proof whose payee is not the named PayPal merchant', async () => {
    const e = await payError(gw.pay({ owner: OWNER, ...proof, paypalMerchantId: 'ABCDEFGHJKLMP', ...urls }));
    expect(e.status).toBe(403);
    expect(e.message).toMatch(/Payee mismatch/);
  });

  it('rejects an EVM-payee proof presented as a PayPal payment', async () => {
    const evm = prove('7002', { merchant: 'openai' });
    const e = await payError(gw.pay({ owner: OWNER, ...evm, paypalMerchantId: MERCHANT, ...urls }));
    expect(e.status).toBe(403);
  });

  it('rejects a tampered proof with bb', async () => {
    const bad = `0x${(proof.proofHex[2] === 'a' ? 'b' : 'a')}${proof.proofHex.slice(3)}`;
    const e = await payError(gw.pay({ owner: OWNER, proofHex: bad, publicInputsHex: proof.publicInputsHex, paypalMerchantId: MERCHANT, ...urls }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/Invalid ZK proof/);
  });

  it('rejects a proof for another day', async () => {
    const old = prove('7003', { epoch: currentEpoch() - 1 });
    const e = await payError(gw.pay({ owner: OWNER, ...old, paypalMerchantId: MERCHANT, ...urls }));
    expect(e.message).toMatch(/Wrong epoch/);
  });

  it('rejects a stale prev once the gateway holds a spend commitment for today', async () => {
    // Seed the gateway's stored commitment (as if another payment landed first).
    fs.writeFileSync(path.join(dir, 'spend.json'), JSON.stringify({ [policyId]: { epoch: currentEpoch(), commit: proof.publicInputs.new_spend_commit } }));
    const e = await payError(gw.pay({ owner: OWNER, ...prove('7004'), paypalMerchantId: MERCHANT, ...urls }));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/Stale spend commitment/);
    fs.rmSync(path.join(dir, 'spend.json'));
  });

  it('refuses an unknown receipt capture', async () => {
    const e = await payError(gw.capture(policyId, '999'));
    expect(e.status).toBe(404);
  });
});

describe('Express gateway is verify-only', () => {
  const app = createGatewayApp(gw);

  it('GET /api/policies exposes no merchants, caps or salts; there is no /api/prove or /api/pay', async () => {
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await fetch(`http://localhost:${port}/api/policies`);
      const body = JSON.stringify(await res.json());
      expect(body).toContain(policy.policyCommitment);
      for (const secret of ['merchants', 'maxPerTxCents', 'dailyCapCents', 'policySalt', 'spendSalt', 'paypal-shop', '424242']) {
        expect(body).not.toContain(secret);
      }
      expect((await fetch(`http://localhost:${port}/api/prove`, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`http://localhost:${port}/api/pay`, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`http://localhost:${port}/api/receipts/7001`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

/** A port nothing listens on (bound, then released). */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe('PayPal failures before consumption cost the agent nothing; a FAILED attempt can be retried', () => {
  // Real local failures, no PayPal stand-in: a port with no listener, and a server that accepts and never answers.
  const freshGateway = (paypal: PayPalService) => {
    const d = fs.mkdtempSync(path.join(dir, 'gw-'));
    const g = new PayGateway({ dir: d, paypal });
    g.register({ owner: OWNER, policyCommitment: policy.policyCommitment, approvalThresholdCents: 0 }, { trustedOwnerDevice: true });
    return g;
  };

  it('configured but PayPal unreachable: 502 "PayPal authentication failed", nonce and spend untouched', async () => {
    const pp = new PayPalService({ clientId: 'x', clientSecret: 'y', baseUrl: `http://127.0.0.1:${await closedPort()}` });
    const g = freshGateway(pp);
    const p = prove('7101');
    const e = await payError(g.pay({ owner: OWNER, ...p, paypalMerchantId: MERCHANT, ...urls }));
    expect(e.status).toBe(502);
    expect(e.message).toMatch(/^Proof verified; nothing consumed\. PayPal authentication failed: ECONNREFUSED/);
    expect(g.receipts.isNonceUsed(policyId, '7101')).toBe(false);
    expect(g.spendState(policyId)).toBeUndefined();
  });

  it('a PayPal that never answers times out (no hung request) and nothing is consumed', async () => {
    const sockets: net.Socket[] = [];
    const silent = http.createServer(() => undefined); // accepts, never responds
    silent.on('connection', (s) => sockets.push(s));
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    try {
      const pp = new PayPalService({ clientId: 'x', clientSecret: 'y', baseUrl: `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}`, timeoutMs: 300 });
      const g = freshGateway(pp);
      const t0 = Date.now();
      const e = await payError(g.pay({ owner: OWNER, ...prove('7102'), paypalMerchantId: MERCHANT, ...urls }));
      expect(e.status).toBe(502);
      expect(e.message).toContain('PayPal authentication failed: no answer within 300 ms');
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(g.receipts.isNonceUsed(policyId, '7102')).toBe(false);
      expect(g.spendState(policyId)).toBeUndefined();
    } finally {
      sockets.forEach((s) => s.destroy());
      silent.close();
    }
  });

  it('resubmitting the proof of a FAILED attempt retries it instead of answering 409 "Nonce already used"', async () => {
    const g = freshGateway(noKeys);
    const p = prove('7103');
    // State an earlier attempt leaves when PayPal failed after consumption: FAILED receipt + advanced spend.
    const failed: Receipt = {
      policyId,
      nonce: '7103',
      amountCents: 300,
      merchantIdHash: p.publicInputs.merchant_id_hash,
      recipient: p.publicInputs.recipient,
      epoch: Number(p.publicInputs.epoch),
      newSpendCommit: p.publicInputs.new_spend_commit,
      proofKeccak: proofKeccak(p.proofHex),
      vkHash: 'test',
      proofTarget: 'default',
      rail: 'paypal',
      status: 'FAILED',
      error: 'PayPal POST /v2/checkout/orders failed (500) INTERNAL_SERVER_ERROR',
      ts: new Date().toISOString(),
    };
    g.receipts.put(failed);
    fs.writeFileSync(path.join(g.dir, 'spend.json'), JSON.stringify({ [policyId]: { epoch: failed.epoch, commit: failed.newSpendCommit } }));
    // Same proof: passes the nonce and spend checks and reaches PayPal (here: Setup required).
    const e = await payError(g.pay({ owner: OWNER, ...p, paypalMerchantId: MERCHANT, ...urls }));
    expect(e.status).toBe(503);
    expect(e.message).toContain('Setup required (PAYPAL_CLIENT_ID)');
    expect(g.receipts.get(policyId, '7103')).toMatchObject({ status: 'FAILED', error: failed.error }); // untouched
    expect(g.spendState(policyId)!.commit).toBe(failed.newSpendCommit); // not advanced twice
    // Another proof for the same nonce is still a replay
    const other = prove('7103', { amount: 200 });
    const replay = await payError(g.pay({ owner: OWNER, ...other, paypalMerchantId: MERCHANT, ...urls }));
    expect(replay.status).toBe(409);
    expect(replay.message).toBe('Nonce already used for this policy');
  });
});
