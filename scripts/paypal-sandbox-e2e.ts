#!/usr/bin/env tsx
/**
 * End-to-end PayPal sandbox run: proof -> verify -> create order -> buyer approval -> capture.
 *   pnpm paypal:e2e                      human mode: prints the approve link, waits for Enter, captures
 *   pnpm paypal:e2e -- --vault <id>      agent mode: charges a vaulted wallet (Vault v3 payment token)
 * Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_PAYEE_MERCHANT_ID (the sandbox business
 * account that receives the money). Without them it prints "Setup required (…)" and exits 1.
 * Prints the policyId, nonce, custom_id, order id and capture id; never prints credentials.
 */
import readline from 'readline';
import {
  createSpendingPolicy,
  currentEpoch,
  generatePaymentProof,
  leashCustomId,
  PayPalService,
  policyIdOf,
  verifyPaymentProof,
} from '../packages/core/src/index.js';

const OWNER = process.env.LEASH_POLICY_OWNER_ADDRESS ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const amountCents = Number(process.env.LEASH_E2E_AMOUNT_CENTS ?? 300);
const vaultIdx = process.argv.indexOf('--vault');
const vaultId = vaultIdx >= 0 ? process.argv[vaultIdx + 1] : undefined;

async function main(): Promise<void> {
  const pp = new PayPalService();
  const missing = [...pp.missing(), ...(process.env.PAYPAL_PAYEE_MERCHANT_ID ? [] : ['PAYPAL_PAYEE_MERCHANT_ID'])];
  if (missing.length) {
    console.error(`Setup required (${missing[0]})${missing.length > 1 ? ` — also missing: ${missing.slice(1).join(', ')}` : ''}`);
    process.exit(1);
  }
  const merchantId = process.env.PAYPAL_PAYEE_MERCHANT_ID!;

  const policy = createSpendingPolicy({
    name: 'paypal sandbox e2e',
    maxPerTxCents: 500,
    dailyCapCents: 1500,
    merchants: [{ name: 'sandbox-merchant', paypalMerchantId: merchantId }],
  });
  const nonce = `${Date.now()}`;
  const proof = generatePaymentProof({
    policy,
    merchantName: 'sandbox-merchant',
    amountCents,
    nonce,
    spend: { epoch: currentEpoch(), prevSpendCommit: '0', spentBeforeCents: 0 },
  });
  const v = verifyPaymentProof({ proofHex: proof.proofHex, publicInputsHex: proof.publicInputsHex });
  if (!v.valid) throw new Error(`proof did not verify: ${v.error}`);
  const policyId = policyIdOf(OWNER, policy.policyCommitment);
  console.log(`proof     verified by bb (${proof.durationMs} ms prove), ${amountCents} cents, payee ${proof.publicInputs.recipient}`);
  console.log(`policyId  ${policyId}`);
  console.log(`nonce     ${nonce}`);
  console.log(`custom_id ${leashCustomId(policyId, nonce)}`);

  const proven = { policyId, nonce, amountCents, payeeMerchantId: merchantId };
  if (vaultId) {
    const order = await pp.createOrder(proven, { kind: 'vault', vaultId });
    console.log(`order     ${order.orderId} ${order.status}`);
    console.log(`capture   ${order.capture!.captureId} COMPLETED ${order.capture!.amountCents} cents`);
    return;
  }
  const order = await pp.createOrder(proven, {
    kind: 'human',
    returnUrl: 'https://example.com/leash/return',
    cancelUrl: 'https://example.com/leash/cancel',
  });
  console.log(`order     ${order.orderId} ${order.status}`);
  console.log(`approve   ${order.approveUrl}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((done) => rl.question('Approve with a sandbox buyer account, then press Enter to capture… ', () => done()));
  rl.close();
  const cap = await pp.captureOrder(order.orderId, proven);
  console.log(`capture   ${cap.captureId} COMPLETED ${cap.amountCents} cents (${cap.currency})`);
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
