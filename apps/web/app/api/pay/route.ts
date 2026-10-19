import { NextRequest, NextResponse } from 'next/server';
import {
  verifyPaymentProof,
  nonceStore,
  paypalService,
} from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const body = await req.json();
    const {
      policyCommitment,
      amountCents,
      merchantIdHash,
      nonce,
      proofHex,
      publicInputsHex,
      merchantName,
    } = body;

    if (
      !policyCommitment ||
      amountCents === undefined ||
      !merchantIdHash ||
      !nonce ||
      !proofHex ||
      !publicInputsHex
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Missing required parameters: policyCommitment, amountCents, merchantIdHash, nonce, proofHex, publicInputsHex',
        },
        { status: 400 }
      );
    }

    const nonceStr = nonce.toString();
    const amountNum = Number(amountCents);

    // 1. Replay Protection: Check if nonce was already used
    if (nonceStore.isNonceUsed(nonceStr)) {
      nonceStore.addAuditEntry({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        policyCommitment,
        amountCents: amountNum,
        merchantIdHash,
        nonce: nonceStr,
        proofVerified: false,
        status: 'REJECTED',
        rejectionReason: 'Nonce replay detected: nonce already used',
        durationMs: Date.now() - startTime,
      });

      return NextResponse.json(
        {
          success: false,
          error: 'Nonce replay detected. Nonce has already been consumed.',
          nonce: nonceStr,
        },
        { status: 400 }
      );
    }

    // 2. Cryptographic Proof Verification using Barretenberg
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

      return NextResponse.json(
        {
          success: false,
          error: `Invalid ZK proof: ${verifyResult.error}`,
          nonce: nonceStr,
        },
        { status: 400 }
      );
    }

    // 3. Mark nonce as consumed
    nonceStore.recordNonce(nonceStr);

    // 4. Release payment through PayPal Orders API
    const effectiveMerchant = merchantName || 'Authorized Merchant';
    const paypalResult = await paypalService.executeOrder(
      amountNum,
      effectiveMerchant,
      nonceStr
    );

    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      policyCommitment,
      amountCents: amountNum,
      merchantIdHash,
      nonce: nonceStr,
      proofVerified: true,
      status: 'COMPLETED' as const,
      paypalOrderId: paypalResult.orderId,
      paypalStatus: paypalResult.status,
      durationMs: Date.now() - startTime,
    };
    nonceStore.addAuditEntry(logEntry);

    return NextResponse.json({
      success: true,
      verified: true,
      nonce: nonceStr,
      policyCommitment,
      amountCents: amountNum,
      merchantIdHash,
      paypal: paypalResult,
      durationMs: Date.now() - startTime,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: `Payment release exception: ${err.message}`,
      },
      { status: 500 }
    );
  }
}
