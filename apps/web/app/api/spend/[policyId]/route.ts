import { NextRequest, NextResponse } from 'next/server';
import { POLICY_ID_RE, sharedGateway } from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The gateway's latest spend commitment for a policy (public; the spent total stays hidden). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ policyId: string }> }) {
  const { policyId } = await ctx.params;
  if (!POLICY_ID_RE.test(policyId)) {
    return NextResponse.json({ success: false, error: 'policyId must be 0x + 64 hex (keccak256(owner, commitment))' }, { status: 400 });
  }
  return NextResponse.json({ policyId: policyId.toLowerCase(), spend: sharedGateway().spendState(policyId) ?? null });
}
