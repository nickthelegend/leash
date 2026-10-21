'use client';

import React from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';

interface PayPalSetupCardProps {
  /** A real PayPal order id from the gateway audit log, if a capture has completed. */
  orderId?: string;
  orderStatus?: string;
  className?: string;
  /** light: on the paper landing; dark: inside the cobalt console. */
  tone?: 'light' | 'dark';
}

const ENV = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_PAYEE_MERCHANT_ID'];

/**
 * Honest status of the PayPal release path. Without a captured order from the gateway this always
 * reads "Setup required": no sandbox order has run yet, and nothing here pretends otherwise.
 */
export function PayPalSetupCard({ orderId, orderStatus, className = '', tone = 'dark' }: PayPalSetupCardProps) {
  const light = tone === 'light';
  if (orderId) {
    return (
      <div className={`pp-card ${light ? 'pp-light' : 'pp-dark'} ${className}`} role="status">
        <div className="pp-top">
          <span className="pp-title">PayPal sandbox</span>
          <span className="pp-pill pp-ok">
            <CheckCircle2 aria-hidden="true" /> Order captured
          </span>
        </div>
        <p className="pp-text">The gateway captured a PayPal order after a verified proof in this session.</p>
        <dl className="pp-dl">
          <div>
            <dt>Order ID</dt>
            <dd className="mono">{orderId}</dd>
          </div>
          {orderStatus && (
            <div>
              <dt>Status</dt>
              <dd className="mono">{orderStatus}</dd>
            </div>
          )}
        </dl>
      </div>
    );
  }

  return (
    <div className={`pp-card ${light ? 'pp-light' : 'pp-dark'} ${className}`} role="note" aria-label="PayPal sandbox: setup required">
      <div className="pp-top">
        <span className="pp-title">PayPal rail</span>
        <span className="pp-pill pp-setup">
          <KeyRound aria-hidden="true" /> Setup required (PAYPAL_CLIENT_ID)
        </span>
      </div>
      <p className="pp-text">
        <b>BLOCKED, not faked.</b> Orders v2 create, approve or vault, and capture are implemented; the live sandbox
        run waits for these keys:
      </p>
      <div className="pp-env">
        {ENV.map((e) => (
          <code key={e} className="mono">
            {e}
          </code>
        ))}
      </div>
      <p className="pp-small">
        Until they are set, proofs still verify but nothing is released on this rail. A payment counts as paid only
        when PayPal reports the capture COMPLETED for exactly the proven cents.
      </p>
    </div>
  );
}
