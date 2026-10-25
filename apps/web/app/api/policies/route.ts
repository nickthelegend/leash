import { NextRequest, NextResponse } from 'next/server';
import { createSpendingPolicy, paypalService, sharedGateway } from '@leash/core';
import { consoleOwner, errorResponse, ownerDeviceEnabled, ownerDeviceOnly, readJsonBody } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public view: registrations (owner, commitment, approval threshold). No merchants, caps or salts. */
export async function GET() {
  return NextResponse.json({
    owner: consoleOwner(),
    ownerDevice: ownerDeviceEnabled(),
    paypal: paypalService.setupStatus(),
    paypalPayeeMerchantId: process.env.PAYPAL_PAYEE_MERCHANT_ID ?? null,
    policies: sharedGateway().policies(),
  });
}

/**
 * Owner device only: create a policy (random salts), return it (secrets included) to the owner's
 * browser, and register only its public commitment and approval threshold with the gateway.
 */
export async function POST(req: NextRequest) {
  const blocked = ownerDeviceOnly(req);
  if (blocked) return blocked;
  try {
    const read = await readJsonBody(req);
    if (read.response) return read.response;
    const { name, maxPerTxCents, dailyCapCents, merchants, approvalThresholdCents } = read.body;
    if (name === undefined || maxPerTxCents === undefined || merchants === undefined) {
      return NextResponse.json({ success: false, error: 'Missing required fields: name, maxPerTxCents, merchants' }, { status: 400 });
    }
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ success: false, error: 'name must be a non-empty string' }, { status: 400 });
    }
    if (name.length > 80) {
      return NextResponse.json({ success: false, error: 'name must be at most 80 characters' }, { status: 400 });
    }
    if (!Array.isArray(merchants)) {
      return NextResponse.json({ success: false, error: 'merchants must be a list of merchant names or { name, payee } entries.' }, { status: 400 });
    }
    // Caps go to createSpendingPolicy as sent: it refuses anything but a positive safe integer (PolicyInputError -> 400).
    const list = [...merchants];
    const pp = process.env.PAYPAL_PAYEE_MERCHANT_ID;
    if (pp) list.push({ name: 'paypal-sandbox-merchant', paypalMerchantId: pp });
    const policy = createSpendingPolicy({
      name,
      maxPerTxCents,
      dailyCapCents: dailyCapCents ?? undefined,
      merchants: list,
    });
    // In-process on the owner device (this route is owner-device only), so no network signature.
    // Ephemeral: the console makes fresh example policies per load; unused ones are pruned after a day.
    const registration = sharedGateway().register(
      { owner: consoleOwner(), policyCommitment: policy.policyCommitment, approvalThresholdCents: Number(approvalThresholdCents ?? 300) },
      { trustedOwnerDevice: true, ephemeral: true }
    );
    return NextResponse.json({ success: true, policy, registration });
  } catch (err) {
    return errorResponse(err);
  }
}
