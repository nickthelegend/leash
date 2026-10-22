import { NextRequest, NextResponse } from 'next/server';
import {
  verifyPaymentProof,
  VerifierDependencyError,
  VerifierKeyError,
  proofInputProblem,
  publicVerifierErrorMessage,
  publicVerifierHealth,
} from '@leash/core';
import { readJsonBody } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const health = publicVerifierHealth();
    return NextResponse.json(health, {
      status: health.status === 'ok' ? 200 : 503,
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: 'error',
        error: String((err as Error)?.message ?? err),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const read = await readJsonBody(req);
    if (read.response) return read.response;
    const body = read.body as Record<string, any>;
    const {
      proofHex,
      publicInputsHex,
      expectedCommitment,
      expectedAmount,
      expectedMerchantHash,
      expectedNonce,
      expectedRecipient,
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
    const problem = proofInputProblem(proofHex, publicInputsHex, Boolean(useEvmTarget));
    if (problem) return NextResponse.json({ success: false, valid: false, error: problem }, { status: 400 });

    const result = verifyPaymentProof({
      proofHex,
      publicInputsHex,
      expectedCommitment,
      expectedAmount,
      expectedMerchantHash,
      expectedNonce,
      expectedRecipient,
      useEvmTarget: Boolean(useEvmTarget),
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (caught) {
    const err = (caught ?? {}) as { message?: string; name?: string; code?: string };
    if (
      caught instanceof VerifierDependencyError ||
      caught instanceof VerifierKeyError ||
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
          error: publicVerifierErrorMessage(err),
        },
        { status: 503 }
      );
    }

    console.error('[LEASH Next API] Verification exception:', caught);
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
