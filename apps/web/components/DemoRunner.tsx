'use client';

import React, { useState } from 'react';
import {
  Play,
  CheckCircle2,
  XCircle,
  Timer,
  Zap,
  ShieldCheck,
  ShieldAlert,
  ArrowRight,
  Flame,
} from 'lucide-react';

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

  return (
    <div className="relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-950/30 via-slate-900/60 to-purple-950/20 p-6 glass-panel shadow-[0_0_40px_rgba(16,185,129,0.15)]">
      {/* Decorative neon accent */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 via-cyan-400 to-purple-500" />

      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        {/* Left: Pitch & Description */}
        <div className="space-y-1.5 max-w-xl">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
              10-Second Demo Moment
            </span>
            <span className="text-xs text-gray-400 font-mono flex items-center gap-1">
              <Timer className="w-3.5 h-3.5" />
              {elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(2)}s` : 'Real-time'}
            </span>
          </div>

          <h2 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">
            See Zero-Knowledge Agent Protection in Action
          </h2>
          <p className="text-sm text-gray-300 leading-relaxed">
            Watch a legitimate agent payment get verified via real Noir UltraHonk
            proof in milliseconds, followed immediately by an injection attack
            blocked dead in its tracks by circuit mathematics.
          </p>
        </div>

        {/* Right: 1-Click Launch Button */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={execute10SecondDemo}
            disabled={isRunning || step === 'legit' || step === 'attack'}
            className="group relative inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl text-sm font-bold text-black bg-gradient-to-r from-emerald-400 to-emerald-300 hover:from-emerald-300 hover:to-emerald-200 active:scale-[0.98] transition-all shadow-[0_0_25px_rgba(5,242,146,0.6)] disabled:opacity-60 cursor-pointer"
          >
            <Play className="w-4 h-4 fill-black transition-transform group-hover:scale-110" />
            <span>
              {step === 'legit'
                ? 'Verifying Legit Proof...'
                : step === 'attack'
                ? 'Blocking Attack In Circuit...'
                : step === 'complete'
                ? 'Re-Run 10-Second Demo'
                : 'Run 10-Second Demo Moment'}
            </span>
          </button>
        </div>
      </div>

      {/* Progress Cards */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-white/10">
        {/* Phase 1: Legitimate Payment */}
        <div
          className={`rounded-xl p-4 border transition-all ${
            step === 'legit'
              ? 'bg-emerald-500/10 border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)]'
              : step === 'complete'
              ? 'bg-emerald-950/20 border-emerald-500/40'
              : 'bg-white/[0.02] border-white/10 opacity-70'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-300">
                Phase 1: Legit Payment ($3.00)
              </span>
            </div>
            {step === 'complete' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" /> Verified
              </span>
            )}
          </div>
          <p className="text-xs text-gray-300">
            Agent pays OpenAI for API inference. Noir proof generated and verified;
            ZK indicator pulses green. PayPal order captured.
          </p>
        </div>

        {/* Phase 2: Prompt Injection Attack */}
        <div
          className={`rounded-xl p-4 border transition-all ${
            step === 'attack'
              ? 'bg-red-500/10 border-red-500 shadow-[0_0_15px_rgba(239,68,68,0.3)]'
              : step === 'complete'
              ? 'bg-red-950/20 border-red-500/40'
              : 'bg-white/[0.02] border-white/10 opacity-70'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-red-400" />
              <span className="text-xs font-bold uppercase tracking-wider text-red-300">
                Phase 2: Injection Attack ($500.00)
              </span>
            </div>
            {step === 'complete' && (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-red-400">
                <XCircle className="w-3.5 h-3.5" /> Blocked
              </span>
            )}
          </div>
          <p className="text-xs text-gray-300">
            Attacker prompt overrides instructions to drain $500.00. Rule R2
            asserts <code>amount &lt;= max_per_tx</code> and fails witness generation.
            Zero funds lost.
          </p>
        </div>
      </div>
    </div>
  );
}
