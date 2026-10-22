'use client';

import React, { useEffect, useState } from 'react';

/**
 * What PayPal sent the browser back with. Orders v2 appends ?token=<order id> (and PayerID) to the
 * return / cancel URL the gateway set (/?paypal=return#audit); Vault v3 appends
 * ?approval_token_id=<setup token id> to /?vault=return#audit.
 */
export type PayPalReturnState =
  | { kind: 'order-return'; orderId: string }
  | { kind: 'order-cancel'; orderId?: string }
  | { kind: 'vault-return'; setupTokenId: string }
  | { kind: 'vault-cancel' };

const ORDER_ID = /^[A-Z0-9]{1,36}$/;
const TOKEN_ID = /^[0-9A-Za-z_-]{1,64}$/;

export function readPayPalReturn(search: string): PayPalReturnState | null {
  const q = new URLSearchParams(search);
  const token = q.get('token') ?? '';
  if (q.get('paypal') === 'return' && ORDER_ID.test(token)) return { kind: 'order-return', orderId: token };
  if (q.get('paypal') === 'cancel') return { kind: 'order-cancel', orderId: ORDER_ID.test(token) ? token : undefined };
  const setup = q.get('approval_token_id') ?? '';
  if (q.get('vault') === 'return' && TOKEN_ID.test(setup)) return { kind: 'vault-return', setupTokenId: setup };
  if (q.get('vault') === 'cancel') return { kind: 'vault-cancel' };
  return null;
}

export interface ReturnReceipt {
  policyId?: string;
  nonce: string;
  paypalOrderId?: string;
  status: string;
}

export interface VaultTarget {
  id: string;
  name: string;
  policyCommitment: string;
  approvalThresholdCents: number;
}

interface Props {
  receipts: ReturnReceipt[];
  /** the console's committed policies the vaulted wallet can be saved for */
  targets: VaultTarget[];
  owner: string | null;
  onCapture: (policyId: string, nonce: string) => Promise<void>;
}

/** Banner shown when PayPal sends the buyer (or the owner, for agent mode) back to the console. */
export function PayPalReturnBanner({ receipts, targets, owner, onCapture }: Props) {
  const [state, setState] = useState<PayPalReturnState | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [target, setTarget] = useState('');

  useEffect(() => {
    setState(readPayPalReturn(window.location.search));
  }, []);
  useEffect(() => {
    if (!target && targets[0]) setTarget(targets[0].id);
  }, [target, targets]);

  if (!state) return null;
  const close = () => {
    setState(null);
    // Drop the PayPal query so a reload doesn't show the banner again; keep the #audit anchor.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  };

  let title: string;
  let body: React.ReactNode;
  if (state.kind === 'order-return') {
    const r = receipts.find((x) => x.paypalOrderId === state.orderId);
    title = `Back from PayPal: order ${state.orderId}`;
    if (!r || !r.policyId) {
      body = <p>No receipt on this console has order {state.orderId}, so there is nothing to capture here.</p>;
    } else if (r.status === 'COMPLETED' || r.status === 'CAPTURE_PENDING') {
      body = <p>Already captured: the receipt for nonce {r.nonce} is {r.status}.</p>;
    } else {
      body = (
        <>
          <p>
            The buyer returned from PayPal for the receipt with nonce <span className="mono">{r.nonce}</span>. Capture
            it now: it counts as paid only if PayPal reports the capture COMPLETED for exactly the proven cents.
          </p>
          <button
            type="button"
            className="btn btn-accent mt-3"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onCapture(r.policyId!, r.nonce);
              setBusy(false);
            }}
          >
            {busy ? 'Capturing…' : `Capture order ${state.orderId}`}
          </button>
        </>
      );
    }
  } else if (state.kind === 'order-cancel') {
    title = 'PayPal order cancelled';
    body = <p>The buyer cancelled{state.orderId ? ` order ${state.orderId}` : ''} at PayPal. Nothing was captured.</p>;
  } else if (state.kind === 'vault-cancel') {
    title = 'Agent mode not saved';
    body = <p>The PayPal wallet approval was cancelled. No vault id was stored.</p>;
  } else {
    const chosen = targets.find((t) => t.id === target);
    title = 'Back from PayPal: wallet approved for agent mode';
    body = (
      <>
        <p>
          Setup token <span className="mono">{state.setupTokenId}</span>. Save the vaulted wallet for one policy: payments
          up to its approval threshold are then charged without the buyer.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-[14px]">
            <span className="sr-only">Policy</span>
            <select
              className="rounded-[10px] bg-cobalt-800 px-3 py-2 text-[14px] text-white"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Policy to save the wallet for"
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} (threshold {t.approvalThresholdCents} cents)
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy || !chosen || !owner}
            onClick={async () => {
              if (!chosen || !owner) return;
              setBusy(true);
              setResult(null);
              try {
                const res = await fetch('/api/paypal/vault', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'confirm',
                    setupTokenId: state.setupTokenId,
                    owner,
                    policyCommitment: chosen.policyCommitment,
                    approvalThresholdCents: chosen.approvalThresholdCents,
                  }),
                });
                const data = await res.json().catch(() => ({}));
                setResult(
                  data.success
                    ? { ok: true, text: `Saved: vault id ${data.policy?.vaultId} for ${chosen.name}.` }
                    : { ok: false, text: data.error || `Saving failed (HTTP ${res.status})` }
                );
              } catch (e) {
                setResult({ ok: false, text: String((e as Error).message ?? e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save for agent mode'}
          </button>
        </div>
        {result && (
          <p role={result.ok ? 'status' : 'alert'} className={`mt-3 break-words ${result.ok ? 'text-white' : 'text-no'}`}>
            {result.text}
          </p>
        )}
      </>
    );
  }

  return (
    <section aria-label="PayPal return" className="mb-4 rounded-2xl border-2 border-dashed border-sun/60 bg-cobalt-900 px-4 py-4 sm:px-5 text-[14.5px] text-white/85">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-[17px] font-semibold tracking-tighter2 text-white break-words min-w-0">{title}</h3>
        <button type="button" className="btn btn-line !min-h-0 !py-1 !px-3 text-[13px]" onClick={close}>
          Dismiss
        </button>
      </div>
      <div className="mt-2 break-words">{body}</div>
    </section>
  );
}

/** Console button: start agent mode (Vault v3 setup token, then PayPal's approve page). */
export function SaveForAgentMode() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-4">
      <button
        type="button"
        className="btn btn-line"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch('/api/paypal/vault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setup' }) });
            const data = await res.json().catch(() => ({}));
            if (data.success && typeof data.approveUrl === 'string') {
              window.location.assign(data.approveUrl);
              return;
            }
            setError(data.error || `PayPal did not return an approve link (HTTP ${res.status})`);
          } catch (e) {
            setError(String((e as Error).message ?? e));
          }
          setBusy(false);
        }}
      >
        {busy ? 'Opening PayPal…' : 'Save PayPal for agent mode'}
      </button>
      {error && (
        <p role="alert" className="pp-small !opacity-100 break-words">
          {error}
        </p>
      )}
    </div>
  );
}
