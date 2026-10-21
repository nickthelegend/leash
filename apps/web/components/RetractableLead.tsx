'use client';

import React from 'react';
import { RUN, short } from '@/lib/recordedRun';

/** Retractable-lead housing: casing, coiled spool, brake button, grip. Static drawing. */
export function LeadHousing({ className = '', locked = false }: { className?: string; locked?: boolean }) {
  return (
    <svg viewBox="0 0 170 120" className={className} aria-hidden="true" focusable="false">
      <rect x="18" y="78" width="104" height="38" rx="19" fill="#0a1a4a" />
      <rect x="38" y="88" width="64" height="18" rx="9" fill="currentColor" />
      <circle cx="78" cy="54" r="52" fill="#0a1a4a" />
      <circle cx="78" cy="54" r="36" fill="none" stroke="#fff6d6" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />
      <circle cx="78" cy="54" r="27" fill="none" stroke="#fff6d6" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.45" />
      <circle cx="78" cy="54" r="11" fill="#ffd84d" />
      <rect x="62" y="-2" width="32" height="12" rx="6" fill={locked ? '#d6452f' : '#ffd84d'} stroke="#0a1a4a" strokeWidth="2" />
      <rect x="126" y="49" width="44" height="10" rx="3" fill="#0a1a4a" />
    </svg>
  );
}

const SCALE = RUN.dailyCapCents; // the cord's full length is the day's cap
const pct = (cents: number) => `${(cents / SCALE) * 100}%`;
const TICKS = [0, 100, 200, 300, 400, 500, 600, 700];

/**
 * The retractable lead from the recorded run. The cord's full length is the private daily cap
 * (700 cents, a caption in the recording, never on chain); it paid out 300 cents once, to the bound
 * payee, from the policy escrow. The cord paying out is the page's one animation; it plays once when
 * scrolled into view and not at all under prefers-reduced-motion.
 */
export function RetractableLead() {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = React.useState<'static' | 'armed' | 'go'>('static');

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.85) return; // already visible: no replay
    setPhase('armed');
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPhase('go');
          io.disconnect();
        }
      },
      { threshold: 0.6 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const paid = RUN.release.amountCents;

  return (
    <figure className="rl" data-phase={phase} ref={ref} aria-labelledby="rl-cap">
      <div className="rl-row">
        <LeadHousing className="rl-housing" />
        <div className="rl-track">
          <div className="rl-rail" aria-hidden="true" />
          <div className="rl-cord" style={{ width: pct(paid) }} aria-hidden="true" />
          <div className="rl-clip" style={{ left: pct(paid) }}>
            <span className="rl-hook" aria-hidden="true" />
            <span className="rl-clip-label">
              <b>{paid} cents</b>
              <span className="mono">{short(RUN.payee)}</span>
            </span>
          </div>
          <div className="rl-stop rl-stop-tx" style={{ left: pct(RUN.perPaymentCapCents) }}>
            <span>500 per payment</span>
          </div>
          <div className="rl-stop rl-stop-day" style={{ left: '100%' }}>
            <span>700 / day · lock</span>
          </div>
          <ol className="rl-ticks" aria-hidden="true">
            {TICKS.map((t) => (
              <li key={t} style={{ left: pct(t) }} className={[0, 300, 500, 700].includes(t) ? 'k' : ''}>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <figcaption id="rl-cap" className="rl-cap">
        <span>
          Paid out <b>{paid} of {RUN.dailyCapCents} cents</b> on day {RUN.release.epoch}
        </span>
        <span>
          Stops <b>500 per payment · 700 per day</b>
        </span>
        <span>
          Escrow <b>{RUN.escrowFundedWei} → {RUN.escrowLeftWei} wei</b>
        </span>
        <span>
          Tx <b className="mono">{short(RUN.release.txHash, 6, 4)}</b> · block {RUN.release.block}
        </span>
      </figcaption>
    </figure>
  );
}
