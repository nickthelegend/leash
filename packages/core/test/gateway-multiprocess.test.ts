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
