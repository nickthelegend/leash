import { NextResponse } from 'next/server';
import { runInjectionHarness, getDefaultPolicy } from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
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
