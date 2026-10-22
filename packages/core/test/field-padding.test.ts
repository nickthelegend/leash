import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parsePolicyBundleOutput } from '../src/crypto/hasher.js';
import { PayGateway } from '../src/gateway/payGateway.js';
import { PayPalService } from '../src/paypal/paypal.js';
import { createSpendingPolicy } from '../src/policy/policy.js';
import { generatePaymentProof } from '../src/prover/prover.js';
import { verifyPaymentProof } from '../src/verifier/verifier.js';

// nargo prints fields without leading zero bytes. Fields are below 0x3064…, so about 1 random policy
// in 49 has a commitment whose first byte is 0x00; it must still be 0x + 64 hex, or the gateway refuses
// to register it (the console's "Policy commitment unavailable") and the verifier's commitment check
// fails. policySalt 18 gives such a policy (0x00ea…): a real nargo run, no fixture.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-pad-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('field values from nargo are 32-byte words', () => {
  it('pads minimal hex from the policy circuit output', () => {
    const out = 'PolicyBundle { merkle_root: 0x1, policy_commitment: 0xABC, leaves: [0x0f, 0x10], layer1: [], layer2: [], layer3: [], merchant_hashes: [0x2] }';
    const b = parsePolicyBundleOutput(out);
    expect(b.policy_commitment).toBe(`0x${'0'.repeat(61)}abc`);
    expect(b.merkle_root).toBe(`0x${'0'.repeat(63)}1`);
    expect(b.leaves).toEqual([`0x${'0'.repeat(62)}0f`, `0x${'0'.repeat(62)}10`]);
    expect(b.merchant_hashes).toEqual([`0x${'0'.repeat(63)}2`]);
  });

  it('a policy whose commitment starts with a zero byte registers, proves and verifies', () => {
    const policy = createSpendingPolicy({
      name: 'leading zero',
      maxPerTxCents: 500,
      dailyCapCents: 1500,
      merchants: ['openai', 'anthropic'],
      policySalt: 18n,
      spendSalt: 7n,
    });
    expect(policy.policyCommitment).toMatch(/^0x00[0-9a-f]{62}$/);

    const gw = new PayGateway({ dir, paypal: new PayPalService({ clientId: '', clientSecret: '' }) });
    const reg = gw.register(
      { owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', policyCommitment: policy.policyCommitment, approvalThresholdCents: 300 },
      { trustedOwnerDevice: true }
    );
    expect(reg.policyCommitment).toBe(policy.policyCommitment);

    const proof = generatePaymentProof({ policy, merchantName: 'openai', amountCents: 300, nonce: 41 });
    expect(proof.publicInputs.policy_commitment).toBe(policy.policyCommitment);
    const v = verifyPaymentProof({
      proofHex: proof.proofHex,
      publicInputsHex: proof.publicInputsHex,
      expectedCommitment: policy.policyCommitment,
      expectedAmount: 300,
      expectedNonce: 41,
    });
    expect(v.valid, v.error).toBe(true);
  }, 120_000);
});
