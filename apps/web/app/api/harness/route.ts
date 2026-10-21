import { NextResponse } from 'next/server';
import { runInjectionHarness, getDefaultPolicy } from '@leash/core';
import { ownerDeviceOnly } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Policy-violation matrix: proves each case, so it runs on the owner device only. */
export async function GET() {
  const blocked = ownerDeviceOnly();
  if (blocked) return blocked;
  try {
    const summary = await runInjectionHarness(getDefaultPolicy());
    return NextResponse.json({
      success: true,
      summary,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err.message,
      },
      { status: 500 }
    );
  }
}
