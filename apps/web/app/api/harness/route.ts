import { NextRequest, NextResponse } from 'next/server';
import { runInjectionHarness, getDefaultPolicy } from '@leash/core';
import { ownerDeviceOnly } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Policy-violation matrix: proves each case, so it runs on the owner device only. */
export async function GET(req: NextRequest) {
  const blocked = ownerDeviceOnly(req);
  if (blocked) return blocked;
  try {
    const summary = await runInjectionHarness(getDefaultPolicy());
    return NextResponse.json({
      success: true,
      summary,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: String((err as Error)?.message ?? err),
      },
      { status: 500 }
    );
  }
}
