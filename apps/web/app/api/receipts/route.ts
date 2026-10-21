import { NextRequest, NextResponse } from 'next/server';
import { sharedGateway } from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** All receipts (newest first), or one policy's with ?policyId=. Public data only. */
export async function GET(req: NextRequest) {
  const policyId = req.nextUrl.searchParams.get('policyId')?.toLowerCase();
  const all = sharedGateway().receipts.list();
  return NextResponse.json({ receipts: policyId ? all.filter((r) => r.policyId === policyId) : all });
}
