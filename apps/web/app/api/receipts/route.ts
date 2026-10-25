import { NextRequest, NextResponse } from 'next/server';
import { POLICY_ID_RE } from '@leash/core';
import { consoleReceipts, errorResponse } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * All receipts (newest first), or one policy's with ?policyId=. Public data only. On the owner device
 * this includes leash-mcp's on-chain releases from this machine, not just the gateway's PayPal ones.
 */
export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get('policyId');
    if (raw !== null && !POLICY_ID_RE.test(raw)) {
      return NextResponse.json({ success: false, error: 'policyId must be 0x + 64 hex (keccak256(owner, commitment))' }, { status: 400 });
    }
    const policyId = raw?.toLowerCase();
    const all = consoleReceipts();
    return NextResponse.json({ receipts: policyId ? all.filter((r) => r.policyId === policyId) : all });
  } catch (err) {
    return errorResponse(err);
  }
}
