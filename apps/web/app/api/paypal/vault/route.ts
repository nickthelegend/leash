import { NextRequest, NextResponse } from 'next/server';
import { paypalService, sharedGateway } from '@leash/core';
import { consoleOwner, errorResponse, ownerDeviceOnly, publicBaseUrl, readJsonBody } from '@/lib/server';

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
  const blocked = ownerDeviceOnly(req);
  if (blocked) return blocked;
  try {
    const read = await readJsonBody(req);
    if (read.response) return read.response;
    const body = read.body as Record<string, any>;
    // The console stores a vault id and threshold only for its own owner's policies; any other owner
    // changes them through the gateway's owner-signed (EIP-191) POST /api/policies.
    if (body.action === 'confirm' && String(body.owner ?? '').toLowerCase() !== consoleOwner().toLowerCase()) {
      return NextResponse.json(
        { success: false, error: `owner must be this console's owner (${consoleOwner()}); other owners sign a registration at the gateway's POST /api/policies` },
        { status: 403 }
      );
    }
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
