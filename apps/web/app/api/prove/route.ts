import { NextRequest, NextResponse } from 'next/server';
import { generatePaymentProof, NONCE_RE, PolicyViolation, SpendingPolicy } from '@leash/core';
import { ownerDeviceOnly, readJsonBody } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner-device prover (the console on the owner's machine). Disabled on a verify-only deployment. */
export async function POST(req: NextRequest) {
  const blocked = ownerDeviceOnly(req);
  if (blocked) return blocked;
  try {
    const read = await readJsonBody(req);
    if (read.response) return read.response;
    const body = read.body as Record<string, any>;
    const { policy, merchantName, amountCents, nonce, useEvmTarget, recipient, spend } = body;

    // The console sends the policy it committed. There is no fallback to the owner's stored policy:
    // a request without one gets no proof.
    if (!policy || typeof policy !== 'object' || typeof policy.policyCommitment !== 'string') {
      return NextResponse.json(
        { success: false, kind: 'input', error: 'Missing required parameter: policy (the committed policy to prove against; there is no default)' },
        { status: 400 }
      );
    }
    const activePolicy = policy as SpendingPolicy;

    if (nonce !== undefined && (typeof nonce !== 'string' || !NONCE_RE.test(nonce))) {
      return NextResponse.json(
        { success: false, kind: 'input', error: 'nonce must be a decimal integer string without leading zeros (1-30 digits)' },
        { status: 400 }
      );
    }

    if (!merchantName || amountCents === undefined) {
      return NextResponse.json(
        {
          success: false,
          kind: 'input',
          error: 'Missing required parameters: merchantName and amountCents',
        },
        { status: 400 }
      );
    }
    // Bad input is the caller's mistake, not a missing prover: 400 kind 'input' (never 503 'setup').
    if (typeof merchantName !== 'string' || !merchantName.trim()) {
      return NextResponse.json({ success: false, kind: 'input', error: 'merchantName must be a non-empty string' }, { status: 400 });
    }
    if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return NextResponse.json({ success: false, kind: 'input', error: 'amountCents must be a positive integer (cents)' }, { status: 400 });
    }
    if (recipient !== undefined && (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient))) {
      return NextResponse.json({ success: false, kind: 'input', error: 'recipient must be a 0x-prefixed 20-byte address' }, { status: 400 });
    }

    const proofResult = generatePaymentProof({
      policy: activePolicy,
      merchantName,
      amountCents,
      nonce: nonce || `${Date.now()}`,
      recipient,
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
