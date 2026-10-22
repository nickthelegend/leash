import { NextRequest, NextResponse } from 'next/server';
import { sharedGateway } from '@leash/core';
import { errorResponse, publicBaseUrl, readJsonBody } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Release a proven payment through PayPal (the only pay route; the Express gateway has none).
 * Body: { owner, proofHex, publicInputsHex, paypalMerchantId }. Amount, nonce, payee, epoch and the
 * spend commitments all come from the proof's public inputs, which bb verifies.
 *  - amount <= the owner's approval threshold and a vaulted wallet: captured now (agent mode)
 *  - otherwise: AWAITING_APPROVAL with the buyer's approve link; POST /api/pay/capture afterwards
 * Without PayPal credentials: 503 "Setup required (PAYPAL_CLIENT_ID)" and nothing is consumed.
 */
export async function POST(req: NextRequest) {
  try {
    const read = await readJsonBody(req);
    if (read.response) return read.response;
    const { owner, proofHex, publicInputsHex, paypalMerchantId } = read.body as Record<string, any>;
    const base = publicBaseUrl(req);
    const receipt = await sharedGateway().pay({
      owner,
      proofHex,
      publicInputsHex,
      paypalMerchantId,
      returnUrl: `${base}/?paypal=return#audit`,
      cancelUrl: `${base}/?paypal=cancel#audit`,
    });
    const ok = receipt.status !== 'FAILED';
    return NextResponse.json(
      {
        success: ok,
        verified: true,
        consumed: true,
        captured: receipt.status === 'COMPLETED',
        receipt,
        ...(ok ? {} : { error: `Proof verified and consumed, but PayPal failed: ${receipt.error}` }),
      },
      { status: ok ? 200 : 502 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
