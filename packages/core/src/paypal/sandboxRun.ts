/**
 * The one live PayPal sandbox order (`pnpm paypal:e2e`), run through the same verify-only PayGateway the
 * console and leash-mcp use, so it exercises the whole architecture rather than the PayPal client alone:
 *   register (in-process, owner device) -> prove (nargo + bb) -> gateway.pay (bb verify, nonce, spend
 *   chain, payee binding, PayPal OAuth, consume, Orders v2 create with custom_id = keccak(policyId, nonce))
 *   -> buyer approves (human mode) -> gateway.capture (COMPLETED for exactly the proven cents) -> receipt.
 * Agent mode (vaultId) registers the vault id with a threshold at the amount, so the create call captures.
 * Without PayPal credentials gateway.pay throws 503 "Proof verified; nothing consumed. Setup required (…)".
 */
import { PayGateway } from '../gateway/payGateway.js';
import { Receipt } from '../gateway/receipts.js';
import { policyIdOf } from '../crypto/evm.js';
import { createSpendingPolicy } from '../policy/policy.js';
import { generatePaymentProof } from '../prover/prover.js';
import { currentEpoch } from '../spend/spendState.js';
import { verifyPaymentProof } from '../verifier/verifier.js';
import { leashCustomId } from './paypal.js';

export interface SandboxRunOptions {
  gateway: PayGateway;
  /** Policy owner (registration key); no signature is needed in-process on the owner device. */
  owner: string;
  /** PAYPAL_PAYEE_MERCHANT_ID: the sandbox business account the proof binds as payee. */
  merchantId: string;
  amountCents?: number;
  nonce?: string;
  /** Vault v3 payment token: agent mode (no buyer step). */
  vaultId?: string;
  returnUrl?: string;
  cancelUrl?: string;
  /** Human mode: called with the approve link; resolve once the sandbox buyer approved. */
  approve: (approveUrl: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface SandboxRunResult {
  policyId: string;
  nonce: string;
  receipt: Receipt;
}

export async function runPayPalSandboxOrder(o: SandboxRunOptions): Promise<SandboxRunResult> {
  const log = o.log ?? (() => undefined);
  const amountCents = o.amountCents ?? 300;
  const nonce = o.nonce ?? `${Date.now()}`;
  const policy = createSpendingPolicy({
    name: 'paypal sandbox e2e',
    maxPerTxCents: 500,
    dailyCapCents: 1500,
    merchants: [{ name: 'sandbox-merchant', paypalMerchantId: o.merchantId }],
  });
  const reg = o.gateway.register(
    { owner: o.owner, policyCommitment: policy.policyCommitment, approvalThresholdCents: o.vaultId ? amountCents : 0, vaultId: o.vaultId },
    { trustedOwnerDevice: true }
  );
  const policyId = reg.policyId;
  if (policyId !== policyIdOf(o.owner, policy.policyCommitment)) throw new Error('registration policyId mismatch');
  log(`register  policy ${policyId} (owner ${o.owner}, threshold ${reg.approvalThresholdCents} cents${o.vaultId ? ', vaulted wallet' : ''})`);

  const proof = generatePaymentProof({
    policy,
    merchantName: 'sandbox-merchant',
    amountCents,
    nonce,
    spend: { epoch: currentEpoch(), prevSpendCommit: '0', spentBeforeCents: 0 },
  });
  const v = verifyPaymentProof({ proofHex: proof.proofHex, publicInputsHex: proof.publicInputsHex, expectedAmount: amountCents, expectedNonce: nonce });
  if (!v.valid) throw new Error(`proof did not verify: ${v.error}`);
  log(`proof     verified by bb (${proof.durationMs} ms prove), ${amountCents} cents, payee ${proof.publicInputs.recipient}`);
  log(`nonce     ${nonce}`);
  log(`custom_id ${leashCustomId(policyId, nonce)}`);

  let receipt = await o.gateway.pay({
    owner: o.owner,
    proofHex: proof.proofHex,
    publicInputsHex: proof.publicInputsHex,
    paypalMerchantId: o.merchantId,
    returnUrl: o.returnUrl ?? 'https://example.com/leash/return',
    cancelUrl: o.cancelUrl ?? 'https://example.com/leash/cancel',
  });
  if (receipt.status === 'FAILED') throw new Error(`gateway: PayPal order failed after the proof was consumed: ${receipt.error} (resubmit the same proof to retry)`);
  log(`order     ${receipt.paypalOrderId} ${receipt.status}`);
  if (receipt.status === 'AWAITING_APPROVAL') {
    log(`approve   ${receipt.approveUrl}`);
    await o.approve(receipt.approveUrl!);
    receipt = await o.gateway.capture(policyId, nonce);
  }
  if (receipt.status !== 'COMPLETED') throw new Error(`order ${receipt.paypalOrderId} is ${receipt.status}, not COMPLETED`);
  log(`capture   ${receipt.captureId} COMPLETED ${receipt.amountCents} cents`);
  return { policyId, nonce, receipt };
}
