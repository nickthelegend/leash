/**
 * What Nick (or a judge) must create in the PayPal Developer Dashboard before the live sandbox run.
 * Printed by `pnpm paypal:e2e` when credentials are missing; pure so it is unit-tested.
 * Names and paths follow developer.paypal.com (checked 2026-10-21):
 *   https://developer.paypal.com/api/rest/                       (Apps & Credentials, Client ID + Secret)
 *   https://developer.paypal.com/tools/sandbox/accounts/         (sandbox business / personal accounts)
 *   https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/
 *                                                                (Vault feature for agent mode)
 *   https://developer.paypal.com/tools/mcp-server/               (PAYPAL_ACCESS_TOKEN for @paypal/mcp)
 */

/** Env vars the live sandbox order needs, in the order they are checked. */
export const PAYPAL_E2E_REQUIRED = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_PAYEE_MERCHANT_ID'] as const;

/** Names of the required variables that are unset or blank in `env`. Never returns values. */
export function missingPayPalE2eEnv(env: Record<string, string | undefined> = process.env): string[] {
  return PAYPAL_E2E_REQUIRED.filter((k) => !env[k]?.trim());
}

/**
 * Numbered checklist for the PayPal Developer Dashboard. `missing` marks which variables are still
 * unset so the reader sees exactly what is left.
 */
export function paypalSandboxChecklist(missing: readonly string[] = PAYPAL_E2E_REQUIRED): string[] {
  const mark = (name: string) => (missing.includes(name) ? `${name}  <- missing` : `${name}  (set)`);
  return [
    '1. Sign in at https://developer.paypal.com with your own PayPal account and open the Dashboard.',
    '2. Testing Tools > Sandbox Accounts: keep the default sandbox Business account (or Create account > Business).',
    '   Open it (View/Edit Account) and copy its 13-character Account ID (merchant id, e.g. ABCDEFGHJKLMN).',
    `   -> ${mark('PAYPAL_PAYEE_MERCHANT_ID')}   (the business account that receives the payment)`,
    '3. Same page: Create account > Personal (the sandbox buyer). Note its email and generated password from',
    '   View/Edit Account; you type them only into sandbox.paypal.com when approving. They never go in .env.',
    '4. Apps & Credentials > Sandbox > Create App (type Merchant), linked to the Business account from step 2.',
    `   Copy Client ID -> ${mark('PAYPAL_CLIENT_ID')}`,
    `   Copy Secret    -> ${mark('PAYPAL_CLIENT_SECRET')}`,
    '5. Agent mode only (pnpm paypal:e2e -- --vault <id>): in the app, Features > Accept payments >',
    '   Advanced options, make sure Vault is checked. The default human-approval run does not need it.',
    '6. Put the values in .env.local at the repo root (gitignored; read by paypal:e2e, the gateway and',
    '   leash-mcp started from the root) and in apps/web/.env.local for the Next console:',
    '     PAYPAL_CLIENT_ID=…  PAYPAL_CLIENT_SECRET=…  PAYPAL_ENVIRONMENT=sandbox  PAYPAL_PAYEE_MERCHANT_ID=…',
    '7. Optional, for the @paypal/mcp proof-gated proxy: PAYPAL_ACCESS_TOKEN from the client-credentials',
    '   call POST https://api-m.sandbox.paypal.com/v1/oauth2/token (grant_type=client_credentials, basic auth',
    '   with the Client ID and Secret). Sandbox tokens expire after a few hours.',
    '8. Run pnpm paypal:e2e: it proves 300 cents, creates the order and prints the approve link. Open it, log in',
    '   as the step-3 buyer, approve, return here and press Enter. It captures and prints the order id and a',
    '   capture COMPLETED for exactly 300 cents. Put that order id and a screenshot of the sandbox business',
    "   account's activity in README.md and HACKATHON_SUBMISSION_FORM.md.",
  ];
}
