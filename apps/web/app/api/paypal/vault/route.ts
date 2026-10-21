import { NextRequest, NextResponse } from 'next/server';
import { paypalService, sharedGateway } from '@leash/core';
import { errorResponse, ownerDeviceOnly, publicBaseUrl } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ paypal: paypalService.setupStatus() });
}

/**
 * Agent mode, set up once by the owner (PayPal Vault v3):
 *   { action: 'setup' }                                         -> approve link for the owner
 *   { action: 'confirm', setupTokenId, owner, policyCommitment,
 *     approvalThresholdCents }                                  -> payment token stored as the policy's vault_id
 * Owner device only: storing a vault id and threshold decides whether payments are charged without
 * the buyer, so a verify-only deployment refuses it (remote owners use the gateway's signed
 * POST /api/policies instead).
 */
export async function POST(req: NextRequest) {
  const blocked = ownerDeviceOnly();
  if (blocked) return blocked;
  try {
    const body = await req.json();
    const setup = paypalService.setupStatus();
    if (!setup.configured) return NextResponse.json({ success: false, error: setup.message }, { status: 503 });
    const base = publicBaseUrl(req);
    if (body.action === 'setup') {
      const t = await paypalService.createVaultSetupToken({ returnUrl: `${base}/?vault=return#audit`, cancelUrl: `${base}/?vault=cancel#audit` });
      return NextResponse.json({ success: true, ...t });
    }
    if (body.action === 'confirm') {
      const { vaultId } = await paypalService.createVaultPaymentToken(String(body.setupTokenId ?? ''));
      const policy = sharedGateway().register(
        {
          owner: body.owner,
          policyCommitment: body.policyCommitment,
          approvalThresholdCents: Number(body.approvalThresholdCents ?? 0),
          vaultId,
        },
        { trustedOwnerDevice: true }
      );
      return NextResponse.json({ success: true, policy });
    }
    return NextResponse.json({ success: false, error: "action must be 'setup' or 'confirm'" }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}
