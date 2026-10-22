#!/usr/bin/env tsx
/**
 * Agent mode, set up once by the owner (PayPal Vault v3), from the command line:
 *   pnpm paypal:vault [-- --commitment 0x… --threshold 300 --owner 0x…]
 *   1. POST /v3/vault/setup-tokens -> prints the approve link; open it and approve with the sandbox buyer.
 *   2. PayPal returns to <LEASH_PUBLIC_URL or http://127.0.0.1:3000>/?vault=return&approval_token_id=…;
 *      press Enter here (or paste that approval_token_id).
 *   3. POST /v3/vault/payment-tokens -> prints the vault id (payment token) for `pnpm paypal:e2e -- --vault <id>`.
 *   With --commitment, also registers the vault id and threshold for that policy at this device's gateway
 *   (<LEASH_HOME>/gateway, in-process on the owner device, like the console's "Save for agent mode").
 * Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox), from .env.local at the repo root or the
 * environment. Without them it prints "Setup required (…)" and exits 1; no PayPal call is made.
 * Never prints credentials.
 */
import readline from 'readline';
import { PayGateway, PayPalService } from '../packages/core/src/index.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const missing = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'].filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    console.error(`Setup required (${missing[0]})${missing.length > 1 ? ` — also missing: ${missing.slice(1).join(', ')}` : ''}`);
    console.error('No PayPal call was made. Put the sandbox app credentials in .env.local (see `pnpm paypal:e2e` for the checklist).');
    process.exit(1);
  }
  const pp = new PayPalService();
  if (pp.environment !== 'sandbox') throw new Error('paypal:vault runs against the sandbox only (PAYPAL_ENVIRONMENT=sandbox)');
  const base = (process.env.LEASH_PUBLIC_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const setup = await pp.createVaultSetupToken({ returnUrl: `${base}/?vault=return#audit`, cancelUrl: `${base}/?vault=cancel#audit` });
  console.log(`setup token ${setup.setupTokenId} ${setup.status}`);
  if (!setup.approveUrl) throw new Error(`setup token ${setup.setupTokenId} has no approve link`);
  console.log(`approve     ${setup.approveUrl}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((done) =>
    rl.question('Approve with the sandbox buyer, then press Enter (or paste the approval_token_id from the return URL): ', done)
  );
  rl.close();
  const setupTokenId = answer.trim() || setup.setupTokenId;
  const { vaultId, customerId } = await pp.createVaultPaymentToken(setupTokenId);
  console.log(`vault id    ${vaultId}${customerId ? ` (customer ${customerId})` : ''}`);

  const commitment = arg('commitment');
  if (commitment) {
    const owner = arg('owner') ?? process.env.LEASH_POLICY_OWNER_ADDRESS ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const threshold = Number(arg('threshold') ?? 300);
    const reg = new PayGateway({ paypal: pp }).register({ owner, policyCommitment: commitment, approvalThresholdCents: threshold, vaultId }, { trustedOwnerDevice: true });
    console.log(`registered  policy ${reg.policyId}: payments up to ${reg.approvalThresholdCents} cents charge this wallet`);
  }
  console.log(`\nnext: pnpm paypal:e2e -- --vault ${vaultId}`);
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
