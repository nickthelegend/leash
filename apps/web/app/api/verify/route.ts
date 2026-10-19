import { NextRequest, NextResponse } from 'next/server';
import {
  verifyPaymentProof,
  VerifierDependencyError,
  VerifierKeyError,
  checkVerifierHealth,
} from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const health = checkVerifierHealth();
    return NextResponse.json(health, {
      status: health.status === 'ok' ? 200 : 503,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        status: 'error',
        error: err.message,
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      proofHex,
      publicInputsHex,
      expectedCommitment,
      expectedAmount,
      expectedMerchantHash,
      expectedNonce,
      useEvmTarget,
    } = body;

    if (!proofHex || !publicInputsHex) {
      return NextResponse.json(
        {
          success: false,
          valid: false,
          error: 'Missing required parameters: proofHex and publicInputsHex',
        },
        { status: 400 }
      );
    }

    const result = verifyPaymentProof({
      proofHex,
      publicInputsHex,
      expectedCommitment,
      expectedAmount,
      expectedMerchantHash,
      expectedNonce,
      useEvmTarget: Boolean(useEvmTarget),
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    if (
      err instanceof VerifierDependencyError ||
      err instanceof VerifierKeyError ||
      err.name === 'VerifierDependencyError' ||
      err.name === 'VerifierKeyError'
    ) {
      console.error('[LEASH Next API] Fatal verifier error:', err.message);
      return NextResponse.json(
        {
          success: false,
          valid: false,
          fatal: true,
          errorType: err.code || 'FATAL_VERIFIER_ERROR',
          error: err.message,
        },
        { status: 503 }
      );
    }

    console.error('[LEASH Next API] Verification exception:', err);
    return NextResponse.json(
      {
        success: false,
        valid: false,
        error: `Verification error: ${err.message}`,
      },
      { status: 500 }
    );
  }
}
