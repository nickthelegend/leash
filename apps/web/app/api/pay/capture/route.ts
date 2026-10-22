import { NextRequest, NextResponse } from 'next/server';
import { sharedGateway } from '@leash/core';
import { errorResponse, readJsonBody } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Capture an order the buyer approved. Body: { policyId, nonce }. COMPLETED only for the exact proven cents. */
export async function POST(req: NextRequest) {
  try {
    const read = await readJsonBody(req);
    if (read.response) return read.response;
    const { policyId, nonce } = read.body;
    const receipt = await sharedGateway().capture(String(policyId ?? ''), String(nonce ?? ''));
    return NextResponse.json({ success: true, captured: receipt.status === 'COMPLETED', receipt });
  } catch (err) {
    return errorResponse(err);
  }
}
