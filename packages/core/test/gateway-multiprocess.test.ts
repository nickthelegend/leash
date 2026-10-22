import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { PayGateway } from '../src/gateway/payGateway.js';
import { policyIdOf } from '../src/crypto/evm.js';

// The Express gateway and the Next console are separate processes writing the same
// LEASH_HOME/gateway/policies.json. Two real node processes (the built package, dist/) hammer it at once.
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DIST = path.resolve(__dirname, '../dist/gateway/payGateway.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-gw-mp-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GW_DIR: dir, GW_DIST: DIST } });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

describe('policies.json across processes', () => {
  it('two processes registering at once lose nothing: 200 threshold changes on one policy and 200 new registrations all survive', async () => {
    const shared = '0x' + crypto.randomBytes(32).toString('hex');
    new PayGateway({ dir }).register({ owner: OWNER, policyCommitment: shared, approvalThresholdCents: 100 }, { trustedOwnerDevice: true });
    const head = `const { PayGateway } = require(process.env.GW_DIST); const gw = new PayGateway({ dir: process.env.GW_DIR }); const crypto = require('crypto');`;
    await Promise.all([
      // the owner changing the threshold 200 times (each one must keep its version bump)
      run(`${head} for (let i = 0; i < 200; i++) gw.register({ owner: '${OWNER}', policyCommitment: '${shared}', approvalThresholdCents: i }, { trustedOwnerDevice: true });`),
      // the console registering 200 fresh policies at the same time
      run(`${head} for (let i = 0; i < 200; i++) gw.register({ owner: '${OWNER}', policyCommitment: '0x' + crypto.randomBytes(32).toString('hex') }, { trustedOwnerDevice: true });`),
    ]);
    const gw = new PayGateway({ dir });
    expect(gw.policies().length).toBe(201);
    expect(gw.policy(policyIdOf(OWNER, shared))).toMatchObject({ approvalThresholdCents: 199, version: 201 });
    expect(fs.readdirSync(path.join(dir)).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp'))).toEqual([]);
  }, 120_000);

  it('a lock left by a process that died is broken instead of blocking registration', () => {
    const lock = path.join(dir, 'policies.json.lock');
    fs.writeFileSync(lock, '2147483646 2026-10-22T00:00:00.000Z'); // no such pid
    const c = '0x' + crypto.randomBytes(32).toString('hex');
    expect(new PayGateway({ dir }).register({ owner: OWNER, policyCommitment: c }, { trustedOwnerDevice: true }).version).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

// Two gateway processes (the Express gateway and the console share LEASH_HOME/gateway) each get a valid
// proof for the same policy, both built on the same spend commitment (prev 0, different nonces). Both
// pass verification; then both reach the consume step at the same instant (a shared wall-clock barrier
// in getAccessToken). Exactly one may consume; the other must get 409, or the spend chain forks and the
// daily cap is counted twice. No PayPal is reachable: createOrder throws, which leaves the winner's
// receipt FAILED after consumption (the state a PayPal outage leaves); nothing here is a PayPal order.
describe('check-and-consume across processes', () => {
  it('two proofs on the same spend commitment, consumed at once from two processes: exactly one wins each round, the other gets 409', async () => {
    const { createSpendingPolicy } = await import('../src/policy/policy.js');
    const { generatePaymentProof } = await import('../src/prover/prover.js');
    const { currentEpoch } = await import('../src/spend/spendState.js');
    const MERCHANT = 'ABCDEFGHJKLMN';
    const policy = createSpendingPolicy({ name: 'race', maxPerTxCents: 500, dailyCapCents: 1000, merchants: [{ name: 'shop', paypalMerchantId: MERCHANT }], policySalt: '616161', spendSalt: '626262' });
    const ROUNDS = 6;
    const jobs: { dir: string; a: unknown; b: unknown }[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const d = fs.mkdtempSync(path.join(dir, 'race-'));
      new PayGateway({ dir: d }).register({ owner: OWNER, policyCommitment: policy.policyCommitment, approvalThresholdCents: 0 }, { trustedOwnerDevice: true });
      const prove = (nonce: string) => {
        const p = generatePaymentProof({ policy, merchantName: 'shop', amountCents: 300, nonce, spend: { epoch: currentEpoch(), prevSpendCommit: '0', spentBeforeCents: 0 } });
        return { proofHex: p.proofHex, publicInputsHex: p.publicInputsHex, newSpendCommit: p.publicInputs.new_spend_commit };
      };
      jobs.push({ dir: d, a: prove(`${8100 + i * 2}`), b: prove(`${8101 + i * 2}`) });
    }
    const jobsFile = path.join(dir, 'race-jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
    const t0 = Date.now() + 4000;
    const PAYPAL_DIST = path.resolve(__dirname, '../dist/paypal/paypal.js');
    const child = (side: 'a' | 'b') =>
      new Promise<{ round: number; status: number; message?: string }[]>((resolve, reject) => {
        const script = `
          const { PayGateway, GatewayError } = require(process.env.GW_DIST);
          const { PayPalService } = require(process.env.PP_DIST);
          const jobs = JSON.parse(require('fs').readFileSync(process.env.JOBS, 'utf8'));
          let at = 0;
          class Barrier extends PayPalService {
            constructor() { super({ clientId: 'race', clientSecret: 'race' }); }
            async getAccessToken() { await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now()))); return 'race'; }
            async createOrder() { throw new Error('no PayPal in this test'); }
          }
          (async () => {
            const out = [];
            for (let i = 0; i < jobs.length; i++) {
              at = ${t0} + i * 2500;
              const gw = new PayGateway({ dir: jobs[i].dir, paypal: new Barrier() });
              const p = jobs[i][process.env.SIDE];
              try {
                await gw.pay({ owner: '${OWNER}', proofHex: p.proofHex, publicInputsHex: p.publicInputsHex, paypalMerchantId: '${MERCHANT}', returnUrl: 'http://127.0.0.1/r', cancelUrl: 'http://127.0.0.1/c' });
                out.push({ round: i, status: 200 });
              } catch (e) {
                out.push({ round: i, status: e instanceof GatewayError ? e.status : 500, message: e.message });
              }
            }
            process.stdout.write(JSON.stringify(out));
          })();`;
        const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GW_DIST: DIST, PP_DIST: PAYPAL_DIST, JOBS: jobsFile, SIDE: side } });
        let out = '';
        let err = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.on('data', (d) => (err += d));
        c.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}: ${err}`))));
      });
    const [ra, rb] = await Promise.all([child('a'), child('b')]);
    for (let i = 0; i < ROUNDS; i++) {
      const statuses = [ra[i].status, rb[i].status].sort();
      expect(statuses, `round ${i}: ${JSON.stringify([ra[i], rb[i]])}`).toEqual([200, 409]);
      const loser = ra[i].status === 409 ? ra[i] : rb[i];
      expect(loser.message).toBe('Stale spend commitment: another payment landed first');
      const winner = ra[i].status === 200 ? (jobs[i].a as any) : (jobs[i].b as any);
      expect(new PayGateway({ dir: jobs[i].dir }).spendState(policyIdOf(OWNER, policy.policyCommitment))!.commit).toBe(winner.newSpendCommit);
    }
  }, 180_000);
});

// A lock left by a dead process is broken by whoever finds it stale. When several waiters find it stale
// at once, only the stale lock may be removed, never the fresh one another waiter just created.
describe('withFileLock: breaking a stale lock', () => {
  it('four processes that all find the same dead-pid lock never hold the lock at the same time (25 rounds)', async () => {
    const RECEIPTS_DIST = path.resolve(__dirname, '../dist/gateway/receipts.js');
    const d = fs.mkdtempSync(path.join(dir, 'stale-'));
    const file = path.join(d, 'shared.json');
    const ROUNDS = 25;
    const t0 = Date.now() + 2500;
    const worker = (n: number) =>
      new Promise<number>((resolve, reject) => {
        const script = `
          const fs = require('fs');
          const { withFileLock } = require(process.env.R_DIST);
          const file = process.env.FILE, inside = file + '.inside', n = Number(process.env.N);
          const spin = (until) => { while (Date.now() < until) {} };
          let overlaps = 0;
          for (let i = 0; i < ${ROUNDS}; i++) {
            const at = ${t0} + i * 250;
            if (n === 0) { spin(at - 120); fs.writeFileSync(file + '.lock', '2147483646 2026-10-22T00:00:00.000Z'); }
            spin(at);
            withFileLock(file, () => {
              try { fs.closeSync(fs.openSync(inside, 'wx')); } catch (e) { overlaps++; return; }
              spin(Date.now() + 8);
              fs.rmSync(inside, { force: true });
            });
          }
          process.stdout.write(String(overlaps));`;
        const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, R_DIST: RECEIPTS_DIST, FILE: file, N: String(n) } });
        let out = '';
        let err = '';
        c.stdout.on('data', (x) => (out += x));
        c.stderr.on('data', (x) => (err += x));
        c.on('exit', (code) => (code === 0 ? resolve(Number(out)) : reject(new Error(`worker ${n} exited ${code}: ${err}`))));
      });
    const overlaps = await Promise.all([0, 1, 2, 3].map(worker));
    expect(overlaps).toEqual([0, 0, 0, 0]);
    expect(fs.readdirSync(d).filter((f) => f.includes('.lock'))).toEqual([]);
  }, 60_000);
});
