'use client';

import React, { useState } from 'react';
import { Play, Timer, ShieldCheck, ShieldAlert, Loader2, Check } from 'lucide-react';

interface DemoRunnerProps {
  onRunLegitDemo: () => Promise<void>;
  onRunAttackDemo: () => Promise<void>;
  isRunning?: boolean;
}

export function DemoRunner({
  onRunLegitDemo,
  onRunAttackDemo,
  isRunning = false,
}: DemoRunnerProps) {
  const [step, setStep] = useState<'idle' | 'legit' | 'attack' | 'complete'>('idle');
  const [elapsedMs, setElapsedMs] = useState<number>(0);

  const execute10SecondDemo = async () => {
    setStep('legit');
    const t0 = Date.now();
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - t0);
    }, 50);

    try {
      // Step 1: Run legitimate payment
      await onRunLegitDemo();

      // Step 2: Run injection attack
      setStep('attack');
      await onRunAttackDemo();

      setStep('complete');
    } finally {
      clearInterval(interval);
      setElapsedMs(Date.now() - t0);
    }
  };

  const busy = isRunning || step === 'legit' || step === 'attack';

  const phases = [
    {
      key: 'legit' as const,
      icon: ShieldCheck,
      title: 'Legit payment',
      amount: '300 cents ($3.00) to openai',
      body: 'Within the cap and on the allowlist. A real Noir proof is generated, then verified by bb before the release step runs.',
    },
    {
      key: 'attack' as const,
      icon: ShieldAlert,
      title: 'Injection attack',
      amount: '50,000 cents ($500.00) to openai',
      body: 'An injected prompt tries to drain $500. Rule R2 asserts amount <= max_per_tx, so witness generation fails and no proof exists.',
    },
  ];

  const phaseState = (key: 'legit' | 'attack') => {
    if (step === key) return 'running';
    if (step === 'complete' || (key === 'legit' && step === 'attack')) return 'done';
    return 'idle';
  };

  return (
    <div className="rounded-panel bg-cobalt-800 p-5 sm:p-7 ring-1 ring-inset ring-cobalt-line h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center h-7 px-3 rounded-full bg-sun text-sun-ink text-[13px] font-medium">
          10-second demo
        </span>
        <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-cobalt-700 text-white/75 text-[13px] mono">
          <Timer className="w-3.5 h-3.5" aria-hidden="true" />
          {elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(2)}s` : 'not run yet'}
        </span>
      </div>

      <h2 className="mt-4 text-[28px] sm:text-[34px] leading-[1.05] font-medium tracking-tightest">
        One honest payment, one attack
      </h2>
      <p className="mt-3 text-[15px] leading-relaxed text-white/70 max-w-[52ch]">
        Runs both through the real prover and verifier, one after the other. The proof panel and the audit log
        show what actually happened.
      </p>

      <ol className="mt-5 grid gap-3">
        {phases.map((p, i) => {
          const st = phaseState(p.key);
          const Icon = p.icon;
          return (
            <li
              key={p.key}
              className={`rounded-2xl p-4 transition-colors ${
                st === 'running' ? 'bg-cobalt-600' : st === 'done' ? 'bg-cobalt-700' : 'bg-cobalt-700/60'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="grid place-items-center w-7 h-7 shrink-0 rounded-full bg-cobalt-900 mono text-[12px] text-sun">
                    {i + 1}
                  </span>
                  <Icon className="w-4 h-4 shrink-0 text-white/80" aria-hidden="true" />
                  <span className="font-medium tracking-tighter2">{p.title}</span>
                </div>
                <span className="text-[12px] text-white/70 shrink-0">
                  {st === 'running' ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 motion-safe:animate-spin" aria-hidden="true" /> Running
                    </span>
                  ) : st === 'done' ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5" aria-hidden="true" /> Ran
                    </span>
                  ) : (
                    'Waiting'
                  )}
                </span>
              </div>
              <div className="mt-2 mono text-[12.5px] text-sun">{p.amount}</div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-white/65">{p.body}</p>
            </li>
          );
        })}
      </ol>

      <div className="mt-auto pt-5">
        <button
          type="button"
          onClick={execute10SecondDemo}
          disabled={busy}
          className="btn btn-accent w-full sm:w-auto"
          aria-live="polite"
        >
          {busy ? (
            <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          <span>
            {step === 'legit'
              ? 'Proving the legit payment…'
              : step === 'attack'
              ? 'Trying the attack…'
              : step === 'complete'
              ? 'Run the demo again'
              : 'Run the 10-second demo'}
          </span>
        </button>
      </div>
    </div>
  );
}
