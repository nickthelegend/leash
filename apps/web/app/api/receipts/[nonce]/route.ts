import { NextRequest, NextResponse } from 'next/server';
import { consoleReceipts, errorResponse } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/receipts/:nonce[?policyId=]: nonces are unique per policy, so several may match without policyId. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ nonce: string }> }) {
  try {
    const { nonce } = await ctx.params;
    const policyId = req.nextUrl.searchParams.get('policyId')?.toLowerCase();
    const hits = consoleReceipts().filter((r) => r.nonce === nonce && (!policyId || r.policyId === policyId));
    if (hits.length === 0) return NextResponse.json({ error: 'No receipt for that nonce' }, { status: 404 });
    return NextResponse.json(hits.length === 1 ? { receipt: hits[0] } : { receipts: hits });
  } catch (err) {
    return errorResponse(err);
  }
}
