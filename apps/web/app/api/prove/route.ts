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
    return NextResponse.json(
      {
        success: false,
        error: err.message,
      },
      { status: 400 }
    );
  }
}
