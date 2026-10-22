import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpendingPolicy } from '../src/policy/policy.js';
import { generatePaymentProof } from '../src/prover/prover.js';
import { repoRoot } from '../src/util/paths.js';

// The nargo Prover.toml files carry the policy secrets (both salts, the caps, the allowlist). They must
// never be written into the repo tree (where `git add -A` would pick up one left by a crash) and must be
// readable by the owner only. Real nargo + bb runs; fs.writeFileSync is only observed, not replaced.
describe('Prover.toml secrets stay out of the repo tree', () => {
  const root = repoRoot()!;
  afterEach(() => vi.restoreAllMocks());

  it('policy registration and proving write their Prover.toml 0600 into a private temp dir that is removed afterwards', () => {
    const seen: { file: string; mode: number; dirMode: number }[] = [];
    const real = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, data: any, opts: any) => {
      real(file, data, opts);
      if (typeof file === 'string' && /Prover[^/]*\.toml$/.test(file)) {
        seen.push({ file, mode: fs.statSync(file).mode & 0o777, dirMode: fs.statSync(path.dirname(file)).mode & 0o777 });
      }
    }) as typeof fs.writeFileSync);

    // computePolicyBundle (policy_circuit) runs inside createSpendingPolicy; then a real proof.
    const policy = createSpendingPolicy({ name: 'secrets', maxPerTxCents: 500, merchants: [{ name: 'openai' }], policySalt: '717171', spendSalt: '727272' });
    const proof = generatePaymentProof({ policy, merchantName: 'openai', amountCents: 300, nonce: '7001' });
    expect(proof.publicInputs.amount).toBe('300');

    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(path.relative(root, s.file).startsWith('..'), `${s.file} is inside the repo`).toBe(true);
      expect(s.file.startsWith(fs.realpathSync(os.tmpdir())) || s.file.startsWith(os.tmpdir())).toBe(true);
      expect(s.mode).toBe(0o600);
      expect(s.dirMode).toBe(0o700);
      expect(fs.existsSync(s.file)).toBe(false);
      expect(fs.existsSync(path.dirname(s.file))).toBe(false);
    }
  }, 120_000);

  it('leaves no Prover_*.toml in circuits/ or packages/core/policy_circuit/', () => {
    for (const d of [path.join(root, 'circuits'), path.join(root, 'packages/core/policy_circuit')]) {
      expect(fs.readdirSync(d).filter((f) => /^Prover_.*\.toml$/.test(f))).toEqual([]);
    }
  });
});
