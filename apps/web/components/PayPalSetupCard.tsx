'use client';

import React from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';

interface PayPalSetupCardProps {
  /** A real PayPal order id from the gateway audit log, if a capture has completed. */
  orderId?: string;
  orderStatus?: string;
  className?: string;
}

/**
 * Honest status of the PayPal release path. Without a captured order from the gateway this always
 * reads "Setup required": no sandbox order has run yet, and nothing here pretends otherwise.
 */
export function PayPalSetupCard({ orderId, orderStatus, className = '' }: PayPalSetupCardProps) {
  if (orderId) {
    return (
      <div
        className={`rounded-panel bg-cobalt-800 p-5 sm:p-6 text-white ring-1 ring-inset ring-cobalt-line ${className}`}
        role="status"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-lg font-medium tracking-tighter2">PayPal sandbox</span>
          <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-ok-soft text-ok text-[13px] font-medium">
            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Order captured
          </span>
        </div>
        <p className="mt-3 text-sm text-white/70">
          The gateway captured a PayPal order after a verified proof in this session.
        </p>
        <dl className="mt-4 grid gap-2 text-sm">
          <div className="flex justify-between gap-3 rounded-2xl bg-cobalt-700 px-4 py-3">
            <dt className="text-white/60">Order ID</dt>
            <dd className="mono text-sun text-[13px] text-right">{orderId}</dd>
          </div>
          {orderStatus && (
            <div className="flex justify-between gap-3 rounded-2xl bg-cobalt-700 px-4 py-3">
              <dt className="text-white/60">Status</dt>
              <dd className="mono text-[13px]">{orderStatus}</dd>
            </div>
          )}
        </dl>
      </div>
    );
  }

  return (
    <div
      className={`rounded-panel bg-cobalt-800 p-5 sm:p-6 text-white ring-1 ring-inset ring-sun/40 ${className}`}
      role="note"
      aria-label="PayPal sandbox: setup required"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-lg font-medium tracking-tighter2">PayPal sandbox</span>
        <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-sun text-sun-ink text-[13px] font-medium">
          <KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> Setup required
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-white/75">
        <span className="font-medium text-white">BLOCKED.</span> No PayPal sandbox order has run yet. The
        release step needs sandbox credentials:
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <code className="mono rounded-full bg-cobalt-700 px-3 py-1.5 text-[12.5px] text-sun">PAYPAL_CLIENT_ID</code>
        <code className="mono rounded-full bg-cobalt-700 px-3 py-1.5 text-[12.5px] text-sun">PAYPAL_CLIENT_SECRET</code>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-white/60">
        Until they are set, proofs still verify, but the gateway reports the release as not configured and
        logs the payment as NOT PAID. It never fakes an order.
      </p>
    </div>
  );
}
