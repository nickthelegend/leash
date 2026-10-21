import { NextRequest, NextResponse } from 'next/server';
import { generatePaymentProof, getDefaultPolicy, PolicyViolation, SpendingPolicy } from '@leash/core';
import { ownerDeviceOnly } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner-device prover (the console on the owner's machine). Disabled on a verify-only deployment. */
export async function POST(req: NextRequest) {
  const blocked = ownerDeviceOnly();
  if (blocked) return blocked;
  try {
    const body = await req.json();
    const { policy, merchantName, amountCents, nonce, useEvmTarget, recipient, spend } = body;

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
      recipient: typeof recipient === 'string' ? recipient : undefined,
      spend: spend && typeof spend === 'object' ? spend : undefined,
      useEvmTarget: Boolean(useEvmTarget),
    });

    return NextResponse.json({
      success: true,
      ...proofResult,
    });
  } catch (caught) {
    const err = caught as { message?: string; name?: string; rule?: string } | undefined;
    // Setup problems (missing recipient, bb/nargo, keys) are not policy decisions: report them
    // as 503 "setup" so the UI never shows them as a circuit block.
    const message = String(err?.message ?? caught);
    const isSetup = !(caught instanceof PolicyViolation || err?.name === 'PolicyViolation');
    return NextResponse.json(
      {
        success: false,
        kind: isSetup ? 'setup' : 'constraint',
        rule: err?.rule,
        error: message.split('\n')[0],
      },
      { status: isSetup ? 503 : 422 }
    );
  }
}
