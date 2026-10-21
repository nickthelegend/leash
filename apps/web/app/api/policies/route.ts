import { NextRequest, NextResponse } from 'next/server';
import {
  createSpendingPolicy,
  getDefaultPolicy,
} from '@leash/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const defaultPolicy = getDefaultPolicy();
  return NextResponse.json({
    defaultPolicy,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, maxPerTxCents, merchants, salt } = body;

    if (!name || !maxPerTxCents || !merchants) {
      return NextResponse.json(
        { error: 'Missing required fields: name, maxPerTxCents, merchants' },
        { status: 400 }
      );
    }

    const policy = createSpendingPolicy({ name, maxPerTxCents: Number(maxPerTxCents), merchants, policySalt: salt });

    return NextResponse.json({
      success: true,
      policy,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
