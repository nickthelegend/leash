import { NextRequest, NextResponse } from 'next/server';
import { sharedGateway } from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The gateway's latest spend commitment for a policy (public; the spent total stays hidden). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ policyId: string }> }) {
  const { policyId } = await ctx.params;
  return NextResponse.json({ policyId: policyId.toLowerCase(), spend: sharedGateway().spendState(policyId) ?? null });
}
