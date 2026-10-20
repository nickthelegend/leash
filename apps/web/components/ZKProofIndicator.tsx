'use client';

import React from 'react';
import { ShieldCheck, ShieldAlert, Lock, Loader2, KeyRound } from 'lucide-react';
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
  setupError?: boolean;
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
  const isSetup = isRejected && Boolean(proofData?.setupError);
  const isBlocked = isRejected && !isSetup;

  const pill = isVerified
    ? { label: 'Verified', cls: 'bg-ok-soft text-ok' }
    : isSetup
    ? { label: 'Setup required', cls: 'bg-sun text-sun-ink' }
    : isBlocked
    ? { label: 'Blocked', cls: 'bg-no-soft text-no' }
    : isProving
    ? { label: 'Proving', cls: 'bg-cobalt-600 text-white' }
    : { label: 'Standby', cls: 'bg-cobalt-700 text-white/70' };

  const Icon = isVerified ? ShieldCheck : isSetup ? KeyRound : isBlocked ? ShieldAlert : isProving ? Loader2 : Lock;

  const headline = isVerified
    ? 'UltraHonk proof verified'
    : isSetup
    ? 'Setup required: not configured'
    : isBlocked
    ? 'Payment blocked, nothing released'
    : isProving
    ? 'Generating the proof…'
    : 'Waiting for a spending request';

  const sub = isVerified
    ? proofData?.durationMs !== undefined
      ? `bb verified the proof in ${proofData.durationMs}ms. The release step runs next.`
      : 'bb verified the proof. The release step runs next.'
    : isRejected
    ? proofData?.rejectionReason || 'The request was refused. No money moved.'
    : isProving
    ? 'Solving the Pedersen commitment, allowlist path and per-transaction cap constraints.'
    : 'Run the demo or pay from an agent card. The cap and the merchant stay hidden; only rule compliance is proven.';

  const iconWrap = isVerified
    ? 'bg-ok-soft text-ok'
    : isSetup
    ? 'bg-sun text-sun-ink'
    : isBlocked
    ? 'bg-no-soft text-no'
    : 'bg-cobalt-700 text-white/70';

  return (
    <div
      className="rounded-panel bg-cobalt-800 p-5 sm:p-7 ring-1 ring-inset ring-cobalt-line h-full flex flex-col"
      aria-live="polite"
      aria-busy={isProving}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] text-white/60">Proof status</div>
          <div className="text-lg font-medium tracking-tighter2 truncate">{status === 'idle' ? 'Noir · Barretenberg' : agentName}</div>
        </div>
        <span className={`inline-flex items-center h-7 px-3 rounded-full text-[13px] font-medium ${pill.cls}`}>
          {pill.label}
        </span>
      </div>

      <div className="mt-6 flex items-start gap-4">
        <span className={`grid place-items-center w-14 h-14 shrink-0 rounded-2xl ${iconWrap}`}>
          <Icon className={`w-7 h-7 ${isProving ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[22px] sm:text-[26px] leading-[1.1] font-medium tracking-tighter2">{headline}</h3>
          <p
            className={`mt-2 text-[14px] leading-relaxed break-words ${
              isBlocked ? 'text-no' : isSetup ? 'text-white/80' : 'text-white/65'
            }`}
          >
            {sub}
          </p>
        </div>
      </div>

      {isVerified && proofData?.extractedPublicInputs && (
        <dl className="mt-6 grid gap-2 text-[13.5px]">
          <div className="flex justify-between gap-3 rounded-2xl bg-cobalt-700 px-4 py-3">
            <dt className="text-white/60">Commitment</dt>
            <dd className="mono text-sun text-[12.5px]" title={proofData.extractedPublicInputs.policy_commitment}>
              {truncateHash(proofData.extractedPublicInputs.policy_commitment, 8, 6)}
            </dd>
          </div>
          <div className="flex justify-between gap-3 rounded-2xl bg-cobalt-700 px-4 py-3">
            <dt className="text-white/60">Amount (cents)</dt>
            <dd className="mono text-[12.5px]">
              {proofData.extractedPublicInputs.amount}{' '}
              <span className="text-white/55">
                (${(Number(proofData.extractedPublicInputs.amount) / 100).toFixed(2)})
              </span>
            </dd>
          </div>
          <div className="flex justify-between gap-3 rounded-2xl bg-cobalt-700 px-4 py-3">
            <dt className="text-white/60">Merchant hash</dt>
            <dd className="mono text-[12.5px]" title={proofData.extractedPublicInputs.merchant_id_hash}>
              {truncateHash(proofData.extractedPublicInputs.merchant_id_hash, 6, 4)}
            </dd>
          </div>
          <div className="flex justify-between gap-3 rounded-2xl bg-cobalt-700 px-4 py-3">
            <dt className="text-white/60">Nonce</dt>
            <dd className="mono text-[12.5px] break-all text-right">{proofData.extractedPublicInputs.nonce}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2 px-1 pt-1 text-[12px] text-white/55">
            <span>bb verify: passed</span>
            <span>
              {proofData.durationMs !== undefined ? `${proofData.durationMs}ms` : ''}
              {proofData.verifiedAt ? ` · ${proofData.verifiedAt}` : ''}
            </span>
          </div>
        </dl>
      )}

      {isRejected && (
        <div
          className={`mt-6 rounded-2xl px-4 py-3 text-[13px] leading-relaxed ${
            isSetup ? 'bg-sun-soft text-white/85' : 'bg-no-soft text-no'
          }`}
          role="alert"
        >
          {isSetup
            ? 'This is missing configuration, not a policy decision. Nothing was paid.'
            : 'Refused before any money moved. The reason above is the exact error from the prover, verifier or gateway.'}
        </div>
      )}
    </div>
  );
}
