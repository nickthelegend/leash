import { NextRequest, NextResponse } from 'next/server';
import { NONCE_RE, POLICY_ID_RE } from '@leash/core';
import { consoleReceipts, errorResponse } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/receipts/:nonce[?policyId=]: nonces are unique per policy, so several may match without policyId. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ nonce: string }> }) {
  try {
    const { nonce } = await ctx.params;
    if (!NONCE_RE.test(nonce)) {
      return NextResponse.json({ success: false, error: 'nonce must be a decimal integer string without leading zeros (1-30 digits)' }, { status: 400 });
    }
    const raw = req.nextUrl.searchParams.get('policyId');
    if (raw !== null && !POLICY_ID_RE.test(raw)) {
      return NextResponse.json({ success: false, error: 'policyId must be 0x + 64 hex (keccak256(owner, commitment))' }, { status: 400 });
    }
    const policyId = raw?.toLowerCase();
    const hits = consoleReceipts().filter((r) => r.nonce === nonce && (!policyId || r.policyId === policyId));
    if (hits.length === 0) return NextResponse.json({ error: 'No receipt for that nonce' }, { status: 404 });
    return NextResponse.json(hits.length === 1 ? { receipt: hits[0] } : { receipts: hits });
  } catch (err) {
    return errorResponse(err);
  }
}
