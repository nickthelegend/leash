/**
 * One daily cap per policy, across settlement rails.
 *
 * The circuit, LeashPayment and the PayPal gateway each keep their own spend chain (one per rail), so
 * each of them enforces the daily cap for its rail only. leash-mcp is where every rail's spending of a
 * policy meets, so it enforces the total: a payment is refused when what already landed today on all
 * rails plus this amount is above the policy's daily cap.
 *
 * Each rail's spend record lives under its own key in the SpendTracker, so advancing one rail never
 * overwrites another rail's opening (the EVM rail keeps the bare policy id it always used).
 */
export type Rail = 'evm' | 'paypal' | 'proxy';

const RAIL_NAMES: Record<Rail, string> = { evm: 'evm', paypal: 'paypal', proxy: 'paypal-mcp' };

export function railKey(policyId: string, rail: Rail): string {
  return rail === 'evm' ? policyId : `${policyId}-${rail}`;
}

/** Cents landed today per rail (only the rails this policy can use). */
export type RailTotals = Partial<Record<Rail, number>>;

/**
 * The refusal text when this payment fits its own rail but not the policy-wide total, or undefined when
 * it fits. A payment that breaks the cap on its own rail is left to the circuit (Rule R4), so the
 * single-rail wording stays the prover's.
 */
export function crossRailRefusal(opts: {
  rail: Rail;
  totals: RailTotals;
  amountCents: number;
  dailyCapCents: number;
  /** what follows the sentence: "Nothing was proved." / "Nothing was sent." */
  outcome: string;
}): string | undefined {
  const own = opts.totals[opts.rail] ?? 0;
  if (own + opts.amountCents > opts.dailyCapCents) return undefined;
  const spent = Object.values(opts.totals).reduce((a, b) => a + (b ?? 0), 0);
  if (spent + opts.amountCents <= opts.dailyCapCents) return undefined;
  const parts = (Object.keys(opts.totals) as Rail[]).map((r) => `${RAIL_NAMES[r]} ${opts.totals[r]}`).join(', ');
  return `Daily cap reached across rails: ${spent} cents already spent today (${parts}) + ${opts.amountCents} > daily cap ${opts.dailyCapCents} cents. ${opts.outcome}`;
}
