'use client';

import React from 'react';
import { ShieldCheck, ShieldAlert, Cpu, Lock, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react';
import { truncateHash } from '@/lib/utils';

export type ZKStatus = 'idle' | 'proving' | 'verified' | 'rejected';

export interface ZKProofData {
  proofHex?: string;
  publicInputsHex?: string;
  durationMs?: number;
  extractedPublicInputs?: {
    policy_commitment: string;
    amount: string;
    merchant_id_hash: string;
    nonce: string;
  };
  rejectionReason?: string;
  verifiedAt?: string;
}

interface ZKProofIndicatorProps {
  status: ZKStatus;
  proofData?: ZKProofData | null;
  agentName?: string;
}

export function ZKProofIndicator({
  status,
  proofData,
  agentName = 'Agent',
}: ZKProofIndicatorProps) {
  const isVerified = status === 'verified';
  const isProving = status === 'proving';
  const isRejected = status === 'rejected';
  const isIdle = status === 'idle';

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border transition-all duration-500 p-5 glass-panel ${
        isVerified
          ? 'border-emerald-500/80 bg-emerald-950/20 shadow-[0_0_35px_rgba(5,242,146,0.35)]'
          : isRejected
          ? 'border-red-500/70 bg-red-950/20 shadow-[0_0_30px_rgba(239,68,68,0.25)]'
          : isProving
          ? 'border-amber-500/60 bg-amber-950/15 shadow-[0_0_25px_rgba(245,158,11,0.25)]'
          : 'border-white/10 hover:border-white/20'
      }`}
    >
      {/* Background ambient light */}
      {isVerified && (
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-emerald-500/20 rounded-full blur-3xl pointer-events-none" />
      )}
      {isRejected && (
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-red-500/20 rounded-full blur-3xl pointer-events-none" />
      )}

      {/* Header Bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-300">
            Noir ZK Proof Engine
          </span>
        </div>

        {/* Real-time status badge */}
        <div className="flex items-center gap-2">
          {isVerified && (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
          )}
          {isProving && (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
            </span>
          )}
          {isRejected && (
            <span className="relative flex h-3 w-3">
              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
            </span>
          )}
          {isIdle && (
            <span className="relative flex h-2.5 w-2.5 rounded-full bg-gray-500"></span>
          )}

          <span
            className={`text-xs font-mono font-semibold px-2 py-0.5 rounded-md ${
              isVerified
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : isRejected
                ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                : isProving
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'bg-white/5 text-gray-400 border border-white/10'
            }`}
          >
            {isVerified
              ? 'VERIFIED'
              : isRejected
              ? 'BLOCKED'
              : isProving
              ? 'PROVING...'
              : 'STANDBY'}
          </span>
        </div>
      </div>

      {/* Main Visual Indicator Centerpiece */}
      <div className="flex flex-col items-center justify-center py-4 text-center">
        {/* Pulsing circular icon with ripple waves */}
        <div className="relative mb-3 flex items-center justify-center">
          {isVerified && (
            <>
              {/* Radiating Green Pulse Rings */}
              <div className="absolute w-20 h-20 rounded-full border border-emerald-400/50 animate-ping opacity-60 pointer-events-none" />
              <div className="absolute w-28 h-28 rounded-full border border-emerald-500/30 animate-pulse pointer-events-none" />
              <div className="absolute w-36 h-36 rounded-full bg-emerald-500/10 blur-xl pointer-events-none" />
            </>
          )}

          <div
            className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-500 ${
              isVerified
                ? 'bg-gradient-to-br from-emerald-500/30 to-emerald-600/10 border-2 border-emerald-400 text-emerald-400 shadow-[0_0_25px_rgba(5,242,146,0.6)] animate-pulse'
                : isRejected
                ? 'bg-gradient-to-br from-red-500/30 to-red-600/10 border-2 border-red-500 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.5)]'
                : isProving
                ? 'bg-gradient-to-br from-amber-500/30 to-amber-600/10 border-2 border-amber-500 text-amber-400 animate-spin-slow'
                : 'bg-white/5 border border-white/10 text-gray-500'
            }`}
          >
            {isVerified ? (
              <ShieldCheck className="w-9 h-9 text-emerald-400 drop-shadow-[0_0_10px_rgba(5,242,146,0.9)]" />
            ) : isRejected ? (
              <ShieldAlert className="w-9 h-9 text-red-400 drop-shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
            ) : isProving ? (
              <Cpu className="w-8 h-8 text-amber-400" />
            ) : (
              <Lock className="w-7 h-7 text-gray-500" />
            )}
          </div>
        </div>

        {/* Status Headline */}
        <h3
          className={`text-base font-bold transition-colors ${
            isVerified
              ? 'text-emerald-300 drop-shadow-[0_0_8px_rgba(5,242,146,0.5)]'
              : isRejected
              ? 'text-red-400'
              : isProving
              ? 'text-amber-300'
              : 'text-gray-300'
          }`}
        >
          {isVerified
            ? 'UltraHonk Proof Verified for Real'
            : isRejected
            ? 'Payment Blocked: Circuit Constraint Failed'
            : isProving
            ? 'Generating Zero-Knowledge Witness...'
            : 'Awaiting Agent Spending Request'}
        </h3>

        {/* Subtitle / Latency Readout */}
        <p className="text-xs text-gray-400 mt-1 max-w-sm">
          {isVerified && proofData?.durationMs
            ? `Barretenberg verified Noir UltraHonk proof in ${proofData.durationMs}ms. Policy rules hold mathematically.`
            : isRejected && proofData?.rejectionReason
            ? proofData.rejectionReason
            : isProving
            ? 'Solving Pedersen Merkle tree and per-tx cap constraints...'
            : 'Zero-knowledge proofs hide merchant identity and spending cap while proving rule compliance.'}
        </p>
      </div>

      {/* Verified Telemetry Box */}
      {isVerified && proofData?.extractedPublicInputs && (
        <div className="mt-2 pt-3 border-t border-emerald-500/20 bg-emerald-950/30 rounded-xl p-3 text-xs font-mono space-y-1.5">
          <div className="flex justify-between items-center text-gray-400">
            <span>Commitment:</span>
            <span className="text-emerald-300 font-semibold" title={proofData.extractedPublicInputs.policy_commitment}>
              {truncateHash(proofData.extractedPublicInputs.policy_commitment, 8, 6)}
            </span>
          </div>
          <div className="flex justify-between items-center text-gray-400">
            <span>Verified Amount:</span>
            <span className="text-emerald-400 font-bold">
              ${(Number(proofData.extractedPublicInputs.amount) / 100).toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between items-center text-gray-400">
            <span>Merchant Hash:</span>
            <span className="text-gray-300" title={proofData.extractedPublicInputs.merchant_id_hash}>
              {truncateHash(proofData.extractedPublicInputs.merchant_id_hash, 6, 4)}
            </span>
          </div>
          <div className="flex justify-between items-center text-gray-400">
            <span>Replay Nonce:</span>
            <span className="text-gray-300">{proofData.extractedPublicInputs.nonce}</span>
          </div>
          <div className="flex justify-between items-center text-[10px] text-emerald-400/80 pt-1 border-t border-emerald-500/10">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Real bb verify: passed
            </span>
            <span>Duration: {proofData.durationMs || 12}ms</span>
          </div>
        </div>
      )}

      {/* Rejection Diagnostics Box */}
      {isRejected && (
        <div className="mt-2 pt-3 border-t border-red-500/20 bg-red-950/30 rounded-xl p-3 text-xs font-mono space-y-1">
          <div className="flex items-center gap-1.5 text-red-300 font-semibold">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span>Zero-Knowledge Policy Protection Active</span>
          </div>
          <p className="text-[11px] text-red-400/90 leading-relaxed mt-1">
            {proofData?.rejectionReason ||
              'Circuit assertion failed. Proof generation impossible. Zero money moved.'}
          </p>
        </div>
      )}
    </div>
  );
}
