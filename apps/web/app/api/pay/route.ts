import { NextRequest, NextResponse } from 'next/server';
import {
  verifyPaymentProof,
  nonceStore,
  paypalService,
  policyIdOf,
  isAddress,
  PayPalSetupRequired,
} from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const baseUrl = (req: NextRequest) => process.env.LEASH_PUBLIC_URL ?? req.nextUrl.origin;

/**
 * Verify the proof, then create a PayPal order for exactly the proven amount (intent CAPTURE,
 * payee.merchant_id, custom_id = keccak(policyId, nonce)). The buyer approves via the returned link;
 * POST /api/pay/capture then captures and checks COMPLETED + amount. Nothing is logged as paid
 * before that capture.
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const body = await req.json();
    const { owner, policyCommitment, amountCents, merchantIdHash, nonce, proofHex, publicInputsHex, paypalMerchantId } = body;

    if (!policyCommitment || amountCents === undefined || !merchantIdHash || !nonce || !proofHex || !publicInputsHex) {
      return NextResponse.json(
        { success: false, error: 'Missing required parameters: policyCommitment, amountCents, merchantIdHash, nonce, proofHex, publicInputsHex' },
        { status: 400 }
      );
    }
    if (!isAddress(owner)) {
      return NextResponse.json({ success: false, error: 'owner must be the 0x address that owns the policy' }, { status: 400 });
    }

    const nonceStr = nonce.toString();
    const amountNum = Number(amountCents);
    const policyId = policyIdOf(owner, policyCommitment);

    if (nonceStore.isNonceUsed(nonceStr)) {
      return NextResponse.json({ success: false, error: 'Nonce replay detected. Nonce has already been consumed.', nonce: nonceStr }, { status: 400 });
    }

    const verifyResult = verifyPaymentProof({
      proofHex,
      publicInputsHex,
      expectedCommitment: policyCommitment,
      expectedAmount: amountNum,
      expectedMerchantHash: merchantIdHash,
      expectedNonce: nonceStr,
    });
    if (!verifyResult.valid) {
      nonceStore.addAuditEntry({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        policyCommitment,
        amountCents: amountNum,
        merchantIdHash,
        nonce: nonceStr,
        proofVerified: false,
        status: 'REJECTED',
        rejectionReason: verifyResult.error || 'Invalid ZK proof',
        durationMs: Date.now() - startTime,
      });
      return NextResponse.json({ success: false, error: `Invalid ZK proof: ${verifyResult.error}`, nonce: nonceStr }, { status: 400 });
    }

    nonceStore.recordNonce(nonceStr);

    try {
      const order = await paypalService.createOrder(
        { policyId, nonce: nonceStr, amountCents: amountNum, payeeMerchantId: String(paypalMerchantId ?? '') },
        { kind: 'human', returnUrl: `${baseUrl(req)}/?paypal=return#audit`, cancelUrl: `${baseUrl(req)}/?paypal=cancel#audit` }
      );
      nonceStore.addAuditEntry({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        policyCommitment,
        amountCents: amountNum,
        merchantIdHash,
        nonce: nonceStr,
        proofVerified: true,
        status: 'FAILED',
        rejectionReason: 'Awaiting buyer approval and capture',
        paypalOrderId: order.orderId,
        paypalStatus: order.status,
        durationMs: Date.now() - startTime,
      });
      return NextResponse.json({ success: true, verified: true, captured: false, nonce: nonceStr, policyId, paypal: { orderId: order.orderId, status: order.status, approveUrl: order.approveUrl } });
    } catch (err: any) {
      const setup = err instanceof PayPalSetupRequired;
      nonceStore.addAuditEntry({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        policyCommitment,
        amountCents: amountNum,
        merchantIdHash,
        nonce: nonceStr,
        proofVerified: true,
        status: 'FAILED',
        rejectionReason: err.message,
        durationMs: Date.now() - startTime,
      });
      return NextResponse.json(
        { success: false, verified: true, nonce: nonceStr, error: `Proof verified, but no payment was made: ${err.message}`, paypal: { configured: !setup } },
        { status: setup ? 503 : 502 }
      );
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: `Payment release exception: ${err.message}` }, { status: 500 });
  }
}
