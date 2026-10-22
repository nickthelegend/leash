#!/usr/bin/env tsx
/**
 * End-to-end PayPal sandbox run through the verify-only gateway (packages/core/src/paypal/sandboxRun.ts):
 *   register -> prove -> gateway.pay (verify, nonce, spend chain, payee, consume, create order)
 *   -> buyer approval -> gateway.capture (COMPLETED for exactly the proven cents) -> receipt
 *   -> pnpm verify:receipt on that nonce (re-runs bb verify and, with keys, fetches the order).
 *   pnpm paypal:e2e                      human mode: prints the approve link, waits for Enter, captures
 *   pnpm paypal:e2e -- --vault <id>      agent mode: charges a vaulted wallet (Vault v3 payment token)
 * Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_PAYEE_MERCHANT_ID (the sandbox business
 * account that receives the money), from .env.local at the repo root or the environment. Without them
 * it prints "Setup required (…)", a numbered checklist of what to create in the PayPal Developer
 * Dashboard, and exits 1. Receipts go to <LEASH_HOME>/gateway, where verify:receipt looks.
 * Prints the policyId, nonce, custom_id, order id and capture id; never prints credentials.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import readline from 'readline';
import { missingPayPalE2eEnv, PayGateway, PayPalService, paypalSandboxChecklist, runPayPalSandboxOrder } from '../packages/core/src/index.js';

const OWNER = process.env.LEASH_POLICY_OWNER_ADDRESS ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const amountCents = Number(process.env.LEASH_E2E_AMOUNT_CENTS ?? 300);
const vaultIdx = process.argv.indexOf('--vault');
const vaultId = vaultIdx >= 0 ? process.argv[vaultIdx + 1] : undefined;

async function main(): Promise<void> {
  const missing = missingPayPalE2eEnv();
  if (missing.length) {
    console.error(`Setup required (${missing[0]})${missing.length > 1 ? ` — also missing: ${missing.slice(1).join(', ')}` : ''}`);
    console.error('\nNo PayPal call was made. To run the live sandbox order, create these in the PayPal Developer Dashboard:\n');
    for (const line of paypalSandboxChecklist(missing)) console.error(line);
    process.exit(1);
  }
  const pp = new PayPalService();
  if (pp.environment !== 'sandbox') throw new Error('paypal:e2e runs against the sandbox only (PAYPAL_ENVIRONMENT=sandbox)');

  const { policyId, nonce } = await runPayPalSandboxOrder({
    gateway: new PayGateway({ paypal: pp }),
    owner: OWNER,
    merchantId: process.env.PAYPAL_PAYEE_MERCHANT_ID!,
    amountCents,
    vaultId,
    log: (line) => console.log(line),
    approve: async () => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise<void>((done) => rl.question('Approve with a sandbox buyer account, then press Enter to capture… ', () => done()));
      rl.close();
    },
  });

  console.log(`\npnpm verify:receipt ${nonce} --policy ${policyId} --owner ${OWNER}`);
  const v = spawnSync(process.execPath, [require.resolve('tsx/cli'), path.join(__dirname, 'verify-receipt.ts'), nonce, '--policy', policyId, '--owner', OWNER], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(v.status ?? 1);
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
