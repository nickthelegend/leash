import { describe, expect, it } from 'vitest';
import { createSpendingPolicy, PolicyInputError, policyShapeError } from '../src/policy/policy.js';

// A bad policy request is the caller's mistake: it must fail as PolicyInputError (the console answers
// 400 kind "input"), never as a plain Error the console reports as a 500 or a 503 "Prover unavailable".
describe('createSpendingPolicy refuses bad input as PolicyInputError', () => {
  const ok = { name: 'x', maxPerTxCents: 500, merchants: ['openai'] };
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['zero cap', { maxPerTxCents: 0 }, /maxPerTxCents must be a positive integer/],
    ['negative cap', { maxPerTxCents: -5 }, /maxPerTxCents must be a positive integer/],
    ['fractional cap', { maxPerTxCents: 2.5 }, /maxPerTxCents must be a positive integer/],
    ['cap past 2^53', { maxPerTxCents: 1e18 }, /maxPerTxCents must be a positive integer/],
    ['string cap', { maxPerTxCents: '500' }, /maxPerTxCents must be a positive integer/],
    ['daily cap past 2^53', { dailyCapCents: 1e18 }, /dailyCapCents must be a positive integer/],
    ['default daily cap past 2^53', { maxPerTxCents: Math.floor(Number.MAX_SAFE_INTEGER / 2) }, /dailyCapCents must be a positive integer/],
    ['merchants as a string', { merchants: 'openai' }, /merchants must be a list/],
    ['no merchants', { merchants: [] }, /at least one allowlisted merchant/],
    ['merchant that is a number', { merchants: [42] }, /Merchant name must be a non-empty string/],
    ['blank merchant', { merchants: ['  '] }, /Merchant name must be a non-empty string/],
    ['merchant with no payee', { merchants: ['nosuch'] }, /Merchant 'nosuch' has no payee/],
    ['17 merchants', { merchants: Array.from({ length: 17 }, (_, i) => ({ name: `m${i}`, payee: `0x${'1'.repeat(39)}${(i % 10).toString()}` })) }, /up to 16 allowlisted merchants/],
  ];
  for (const [label, patch, message] of cases) {
    it(label, () => {
      let caught: unknown;
      try {
        createSpendingPolicy({ ...ok, ...patch } as never);
      } catch (err) {
        caught = err;
      }
      expect(caught, label).toBeInstanceOf(PolicyInputError);
      expect((caught as Error).message).toMatch(message);
    });
  }
});

describe('policyShapeError: a policy sent back by the console must have every field the prover reads', () => {
  const policy = createSpendingPolicy({ name: 'shape', maxPerTxCents: 500, merchants: ['openai'] });

  it('a real policy passes', () => {
    expect(policyShapeError(policy)).toBeNull();
    expect(policyShapeError(JSON.parse(JSON.stringify(policy)))).toBeNull();
  });

  const broken: [string, (p: any) => unknown, RegExp][] = [
    ['not an object', () => 'policy', /policy must be an object/],
    ['an array', () => [], /policy must be an object/],
    ['commitment only', (p) => ({ policyCommitment: p.policyCommitment }), /maxPerTxCents/],
    ['cap as a string', (p) => ({ ...p, maxPerTxCents: 'abc' }), /maxPerTxCents must be a positive integer/],
    ['salt not a field', (p) => ({ ...p, policySalt: '1"\nmax_per_tx = "1' }), /policySalt must be a field element/],
    ['no merchant leaves', (p) => ({ ...p, merchantLeaves: undefined }), /merchantLeaves must be a list/],
    ['leaf index out of range', (p) => ({ ...p, merchantLeaves: [{ ...p.merchantLeaves[0], leafIndex: 99 }] }), /leafIndex/],
    ['short merchantIds', (p) => ({ ...p, merchantIds: ['1'] }), /merchantIds must be 16 field elements/],
    ['bundle without layers', (p) => ({ ...p, bundle: { leaves: p.bundle.leaves } }), /bundle\.layer1/],
  ];
  for (const [label, mutate, message] of broken) {
    it(label, () => {
      expect(policyShapeError(mutate(JSON.parse(JSON.stringify(policy))))).toMatch(message);
    });
  }
});
