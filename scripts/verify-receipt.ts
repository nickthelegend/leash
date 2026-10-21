#!/usr/bin/env tsx
/**
 * Re-check a LEASH receipt without trusting whoever issued it:
 *   1. the stored proof's keccak matches receipt.proofKeccak
 *   2. bb verify accepts the proof with this checkout's verification key (vk_hash compared too)
 *   3. the proof's public inputs match the receipt (amount, nonce, merchant hash, payee, spend commit,
 *      and policyId = keccak(owner, commitment) when --owner is given)
 *   4. PayPal (when PAYPAL_CLIENT_ID/SECRET are set): GET /v2/checkout/orders/{id} carries
 *      custom_id == keccak(policyId, nonce) and, if captured, the proven amount. Without keys this step
 *      prints "Setup required (PAYPAL_CLIENT_ID)" and the script exits 2 (partially verified).
 *
 * Usage: pnpm verify:receipt <nonce> [--policy <policyId>] [--owner <0x…>] [--store <dir>]
 * Stores searched by default: <LEASH_HOME>/gateway (PayPal receipts) and <LEASH_HOME> (on-chain).
 */
import path from 'path';
import {
  decodePublicInputs,
  leashCustomId,
  leashHome,
  PayPalService,
  policyIdOf,
  proofKeccak,
  ReceiptStore,
  valueToCents,
  verifyPaymentProof,
  vkHash,
} from '../packages/core/src/index.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const nonce = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!nonce) {
  console.error('usage: verify-receipt <nonce> [--policy <policyId>] [--owner <0x…>] [--store <dir>]');
  process.exit(64);
}

const stores = flag('--store') ? [flag('--store')!] : [path.join(leashHome(), 'gateway'), leashHome()];
let found: { store: ReceiptStore; r: ReturnType<ReceiptStore['get']> } | undefined;
for (const dir of stores) {
  const store = new ReceiptStore(dir);
  const hits = store.byNonce(nonce).filter((r) => !flag('--policy') || r.policyId === flag('--policy')!.toLowerCase());
  if (hits.length > 1) {
    console.error(`nonce ${nonce} has ${hits.length} receipts in ${dir}; pass --policy <policyId>`);
    process.exit(64);
  }
  if (hits.length === 1) {
    found = { store, r: hits[0] };
    break;
  }
}
if (!found?.r) {
  console.error(`FAIL no receipt for nonce ${nonce} in ${stores.join(', ')}`);
  process.exit(1);
}
const r = found.r;
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

console.log(`receipt  ${r.rail} ${r.status}  policy ${r.policyId}  nonce ${r.nonce}  ${r.amountCents} cents`);
const proof = found.store.loadProof(r.proofKeccak);
check(Boolean(proof), `proof bytes stored for ${r.proofKeccak}`);
if (proof) {
  check(proofKeccak(proof.proofHex) === r.proofKeccak, 'proof keccak matches the receipt');
  const evm = proof.proofTarget === 'evm';
  check(vkHash(evm ? 'evm' : 'default') === r.vkHash, `vk_hash ${r.vkHash} is this checkout's ${evm ? 'EVM' : 'default'} key`);
  const v = verifyPaymentProof({ proofHex: proof.proofHex, publicInputsHex: proof.publicInputsHex, useEvmTarget: evm });
  check(v.valid, `bb verify${v.valid ? '' : `: ${v.error}`}`);
  const pi = decodePublicInputs(Buffer.from(proof.publicInputsHex.replace(/^0x/, ''), 'hex'));
  check(pi.amount === String(r.amountCents), `amount ${pi.amount} cents`);
  check(pi.nonce === r.nonce, `nonce ${pi.nonce}`);
  check(pi.merchant_id_hash === r.merchantIdHash, 'salted merchant hash');
  check(pi.recipient === r.recipient.toLowerCase(), `payee ${pi.recipient}`);
  check(pi.new_spend_commit === r.newSpendCommit && Number(pi.epoch) === r.epoch, `spend commitment for day ${pi.epoch}`);
  const owner = flag('--owner');
  if (owner) check(policyIdOf(owner, pi.policy_commitment) === r.policyId, 'policyId = keccak(owner, commitment)');
}

async function paypalCheck(): Promise<number> {
  if (r.rail !== 'paypal' || !r.paypalOrderId) return 0;
  check(r.custom_id === leashCustomId(r.policyId, r.nonce), 'receipt custom_id = keccak(policyId, nonce)');
  const pp = new PayPalService();
  const status = pp.setupStatus();
  if (!status.configured) {
    console.log(`SKIP PayPal order ${r.paypalOrderId}: ${status.message}`);
    return 2;
  }
  const order = await pp.getOrder(r.paypalOrderId);
  const unit = order.purchase_units?.[0];
  check(unit?.custom_id === leashCustomId(r.policyId, r.nonce), `PayPal custom_id ${unit?.custom_id}`);
  const cap = unit?.payments?.captures?.[0];
  if (r.status === 'COMPLETED') {
    check(cap?.status === 'COMPLETED' && cap?.id === r.captureId, `PayPal capture ${cap?.id} ${cap?.status}`);
    check(cap ? valueToCents(String(cap.amount?.value)) === r.amountCents : false, `PayPal captured ${cap?.amount?.value} ${cap?.amount?.currency_code}`);
  }
  return 0;
}

paypalCheck()
  .then((partial) => {
    if (failures) {
      console.log(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log(partial ? '\nproof verified; PayPal side not checked (Setup required)' : '\nreceipt verified');
    process.exit(partial);
  })
  .catch((e) => {
    console.error(`FAIL ${e.message}`);
    process.exit(1);
  });
