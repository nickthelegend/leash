import { NextRequest, NextResponse } from 'next/server';
import { GatewayError } from '@leash/core';

/**
 * Proving needs the policy secrets, so it only runs on the owner's device: `next dev` on the owner's
 * machine, or LEASH_OWNER_DEVICE=1. A production deployment (`next start`) is a verify-only gateway
 * unless that flag is set; LEASH_OWNER_DEVICE=0 turns proving off in dev too.
 */
export function ownerDeviceEnabled(): boolean {
  if (process.env.LEASH_OWNER_DEVICE === '1') return true;
  if (process.env.LEASH_OWNER_DEVICE === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

export function ownerDeviceOnly(): NextResponse | null {
  if (ownerDeviceEnabled()) return null;
  return NextResponse.json(
    { success: false, kind: 'setup', error: 'This gateway is verify-only: proving runs on the owner device (leash-mcp, or the console with LEASH_OWNER_DEVICE=1).' },
    { status: 403 }
  );
}

/** Address that owns the console's policies (defaults to Anvil dev account #0). */
export function consoleOwner(): string {
  return process.env.LEASH_CONSOLE_OWNER ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
}

export function publicBaseUrl(req: NextRequest): string {
  return process.env.LEASH_PUBLIC_URL ?? req.nextUrl.origin;
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof GatewayError || (err as any)?.name === 'GatewayError') {
    const e = err as GatewayError;
    return NextResponse.json({ success: false, error: e.message, ...e.extra }, { status: e.status });
  }
  return NextResponse.json({ success: false, error: String((err as Error)?.message ?? err) }, { status: 500 });
}
