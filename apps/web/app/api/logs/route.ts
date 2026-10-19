import { NextResponse } from 'next/server';
import { nonceStore } from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    logs: nonceStore.getAuditLog(),
  });
}
