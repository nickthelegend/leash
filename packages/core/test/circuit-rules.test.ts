import { describe, expect, it } from 'vitest';
import { runInjectionHarness } from '../src/harness/injectionSuite.js';
import { getDefaultPolicy } from '../src/policy/policy.js';
import { generatePaymentProof, PolicyViolation } from '../src/prover/prover.js';
import { currentEpoch, SpendTracker } from '../src/spend/spendState.js';
import { verifyPaymentProof } from '../src/verifier/verifier.js';

// Real nargo + bb, no mocks: each refusal below is the circuit failing to build a witness.
describe('circuit rules through the TypeScript prover', () => {
  const policy = getDefaultPolicy({ demo: true }); // cap 500 per payment, 1500 per day
  const ATTACKER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

  it('refuses an allowlisted merchant with an attacker payee (constraint, not a pre-check)', () => {
    let err: unknown;
    try {
      generatePaymentProof({ policy, merchantName: 'openai', amountCents: 300, nonce: '1', recipient: ATTACKER });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PolicyViolation);
    expect((err as PolicyViolation).rule).toBe('R1_ALLOWLIST_PAYEE');
    expect((err as Error).message).toContain("constraint failed): 'Merchant/payee pair not in allowlist'");
  });

  it('chains the daily cap: 500 + 500 + 500 land, a 4th payment is refused by the circuit', () => {
    const spend = new SpendTracker(false);
    const epoch = currentEpoch();
    for (let i = 0; i < 3; i++) {
      const inputs = spend.inputs(policy.policyCommitment, epoch);
      const p = generatePaymentProof({ policy, merchantName: 'openai', amountCents: 500, nonce: String(100 + i), spend: inputs });
      expect(verifyPaymentProof({ proofHex: p.proofHex, publicInputsHex: p.publicInputsHex }).valid).toBe(true);
      expect(p.publicInputs.prev_spend_commit).toBe(i === 0 ? `0x${'0'.repeat(64)}` : spend.get(policy.policyCommitment)!.commit);
      spend.advance(policy.policyCommitment, { epoch, spentBeforeCents: inputs.spentBeforeCents, amountCents: 500, newSpendCommit: p.publicInputs.new_spend_commit });
    }
    expect(spend.get(policy.policyCommitment)!.spentCents).toBe(1500);
    expect(() =>
      generatePaymentProof({ policy, merchantName: 'openai', amountCents: 1, nonce: '200', spend: spend.inputs(policy.policyCommitment, epoch) })
    ).toThrow(/Amount exceeds daily cap/);
  }, 60_000); // four real proofs and three bb verifies: well over vitest's 5 s default on a CI runner

  it('refuses a forged spend state (understated spent_before)', () => {
    const epoch = currentEpoch();
    const first = generatePaymentProof({ policy, merchantName: 'openai', amountCents: 400, nonce: '300', spend: { epoch, prevSpendCommit: '0', spentBeforeCents: 0 } });
    expect(() =>
      generatePaymentProof({
        policy,
        merchantName: 'openai',
        amountCents: 400,
        nonce: '301',
        spend: { epoch, prevSpendCommit: first.publicInputs.new_spend_commit, spentBeforeCents: 0 },
      })
    ).toThrow(/Stale or forged spend commitment/);
  });
});

describe('policy-violation matrix (26 cases, real proofs)', () => {
  it('blocks every violation, allows every legitimate payment, no errors', async () => {
    const s = await runInjectionHarness(getDefaultPolicy({ demo: true }));
    expect(s.errors).toBe(0);
    expect(s.totalTests).toBe(26);
    expect(s.injectionsBlocked).toBe(s.injectionCount);
    expect(s.legitimatePassed).toBe(4);
    expect(s.allGuaranteesHeld).toBe(true);
    const byId = new Map(s.results.map((r) => [r.testCase.id, r]));
    expect(byId.get(25)!.blockedAt).toBe('CIRCUIT_RULE_R1_PAYEE');
    expect(byId.get(26)!.blockedAt).toBe('CIRCUIT_RULE_R4_DAILY');
    expect(byId.get(19)!.blockedAt).toBe('CIRCUIT_RULE_R2');
  }, 120_000);
});
