import { describe, expect, it } from 'vitest';
import { getDefaultPolicy } from '../src/policy/policy.js';
import { assertNonce, generatePaymentProof, proverToml } from '../src/prover/prover.js';

// The nonce reaches nargo's Prover.toml; it must be a canonical decimal (what the public input reads
// back as), and no value may break out of its TOML string.
describe('prover inputs', () => {
  const policy = getDefaultPolicy({ demo: true });

  it('accepts canonical decimal nonces only', () => {
    for (const ok of ['0', '7', '3001', '1761200000000123', '9'.repeat(30)]) expect(assertNonce(ok)).toBe(ok);
    expect(assertNonce(3001)).toBe('3001');
    for (const bad of ['', '03001', '0x0bb9', '-1', '1.5', ' 1', '1"\nmax_per_tx = "1', '9'.repeat(31)]) {
      expect(() => assertNonce(bad), bad).toThrow(/nonce must be a decimal integer string without leading zeros/);
    }
  });

  it('refuses an injected or non-canonical nonce before nargo runs', () => {
    for (const nonce of ['1"\nmax_per_tx = "1', '0x0bb9', '03001']) {
      expect(() => generatePaymentProof({ policy, merchantName: 'openai', amountCents: 100, nonce }), nonce).toThrow(
        /^nonce must be a decimal integer string without leading zeros/
      );
    }
  });

  it('writes every value as one escaped TOML string (booleans bare)', () => {
    const toml = proverToml([
      ['nonce', '1"\nmax_per_tx = "1'],
      ['amount', 300],
      ['merkle_path_indices', [true, false]],
      ['merkle_path_elements', ['0x01', '2']],
    ]);
    expect(toml.split('\n')).toEqual([
      'nonce = "1\\"\\nmax_per_tx = \\"1"',
      'amount = "300"',
      'merkle_path_indices = [true, false]',
      'merkle_path_elements = ["0x01", "2"]',
    ]);
    expect(toml).not.toMatch(/^max_per_tx/m);
  });
});
