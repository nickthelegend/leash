import { NextRequest, NextResponse } from 'next/server';
import {
  generatePaymentProof,
  getDefaultPolicy,
  SpendingPolicy,
} from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { policy, merchantName, amountCents, nonce, useEvmTarget } = body;

    const activePolicy: SpendingPolicy = policy || getDefaultPolicy();

    if (!merchantName || amountCents === undefined) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing required parameters: merchantName and amountCents',
        },
        { status: 400 }
      );
    }

    const proofResult = generatePaymentProof({
      policy: activePolicy,
      merchantName: String(merchantName),
      amountCents: Number(amountCents),
      nonce: nonce || `${Date.now()}`,
      useEvmTarget: Boolean(useEvmTarget),
    });

    return NextResponse.json({
      success: true,
      ...proofResult,
    });
  } catch (err: any) {
    // Setup problems (missing recipient, bb/nargo, keys) are not policy decisions: report them
    // as 503 "setup" so the UI never shows them as a circuit block.
    const message = String(err?.message ?? err);
    const isSetup = /not configured|not found on PATH|Install via|Generate the key|ENOENT|LEASH_RECIPIENT_ADDRESS/i.test(message);
    return NextResponse.json(
      {
        success: false,
        kind: isSetup ? 'setup' : 'constraint',
        error: message,
      },
      { status: isSetup ? 503 : 422 }
    );
  }
}
