/**
 * The hosted console (scripts/build-vercel.mjs sets NEXT_PUBLIC_LEASH_VERIFY_ONLY=1) has no owner device:
 * policy secrets and the prover never leave the owner's machine, so this build commits and proves nothing
 * and sends none of those requests. What it does live is ask the verify-only gateway to bb-verify the
 * committed fixture proof (served beside the page at /fixtures/base/) and list the gateway's receipts.
 */
export const VERIFY_ONLY = process.env.NEXT_PUBLIC_LEASH_VERIFY_ONLY === '1';

export const OWNER_DEVICE_ONLY =
  'This gateway is verify-only: proving runs on the owner device (leash-mcp, or the console with LEASH_OWNER_DEVICE=1).';

/** An error that is missing configuration, not a policy decision (the API answered `kind: "setup"`). */
export class SetupError extends Error {
  readonly kind = 'setup';
}

export const isSetupError = (err: unknown) =>
  err instanceof SetupError || /not configured|Setup required/i.test(String((err as Error)?.message ?? err));
