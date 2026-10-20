'use client';

import React from 'react';
import { Bot, Shield, Check, Copy, AlertOctagon, Zap } from 'lucide-react';
import { SpendingLimitDial } from './SpendingLimitDial';
import { truncateHash } from '@/lib/utils';

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  role: string;
  allowlistedMerchants: string[];
  capCents: number;
  commitmentHash: string;
}

interface AgentCardProps {
  agent: AgentConfig;
  onCapChange: (agentId: string, newCapCents: number) => void;
  onTriggerPayment: (
    agentId: string,
    merchant: string,
    amountCents: number,
    label: string
  ) => void;
  isLoading?: boolean;
  activeAgentId?: string | null;
}

export function AgentCard({
  agent,
  onCapChange,
  onTriggerPayment,
  isLoading = false,
  activeAgentId,
}: AgentCardProps) {
  const [copied, setCopied] = React.useState(false);
  const isThisAgentActive = activeAgentId === agent.id;

  const handleCopyCommitment = () => {
    navigator.clipboard.writeText(agent.commitmentHash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const legitAmount = Math.min(300, agent.capCents);
  const merchant = agent.allowlistedMerchants[0] || 'openai';

  return (
    <article
      className={`rounded-panel bg-cobalt-800 p-5 sm:p-6 flex flex-col justify-between ring-1 ring-inset transition-shadow ${
        isThisAgentActive ? 'ring-sun/70' : 'ring-cobalt-line'
      }`}
      aria-label={agent.name}
    >
      <div>
        {/* Agent Header */}
        <div className="flex items-start gap-3">
          <span className="grid place-items-center w-10 h-10 shrink-0 rounded-full bg-cream text-cobalt-900">
            <Bot className="w-5 h-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="font-medium text-[17px] leading-tight tracking-tighter2">{agent.name}</h3>
            <p className="mt-1 text-[13px] text-white/60">
              {agent.model} · {agent.role}
            </p>
          </div>
        </div>

        {/* Commitment: the only public part of the policy */}
        <div className="mt-4 flex items-center justify-between gap-2 rounded-2xl bg-cobalt-700 pl-4 pr-1.5 py-1.5">
          <div className="flex items-center gap-2 min-w-0 text-[13px]">
            <Shield className="w-3.5 h-3.5 shrink-0 text-sun" aria-hidden="true" />
            <span className="text-white/60 shrink-0">Commitment</span>
            {agent.commitmentHash ? (
              <span className="mono text-[12.5px] text-sun truncate" title={agent.commitmentHash}>
                {truncateHash(agent.commitmentHash, 6, 4)}
              </span>
            ) : (
              <span className="text-white/50 text-[12.5px]">committing…</span>
            )}
          </div>
          <button
            type="button"
            onClick={handleCopyCommitment}
            disabled={!agent.commitmentHash}
            className="grid place-items-center w-8 h-8 shrink-0 rounded-full text-white/70 hover:text-white hover:bg-cobalt-600 transition-colors disabled:opacity-40"
            aria-label={copied ? 'Commitment copied' : 'Copy full commitment hash'}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-ok" aria-hidden="true" />
            ) : (
              <Copy className="w-3.5 h-3.5" aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Spending Limit Dial */}
        <div className="mt-3">
          <SpendingLimitDial
            valueCents={agent.capCents}
            onChange={(newCap) => onCapChange(agent.id, newCap)}
            agentName={agent.name}
            disabled={isLoading}
          />
        </div>

        {/* Merchant Allowlist Chips (Rule R1) */}
        <div className="mt-5">
          <div className="flex items-center justify-between text-[12.5px] text-white/60 mb-2">
            <span>Rule R1 · Merkle allowlist</span>
            <span>{agent.allowlistedMerchants.length} merchants</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {agent.allowlistedMerchants.map((m) => (
              <span
                key={m}
                className="inline-flex items-center h-7 px-3 rounded-full mono text-[12px] bg-cobalt-700 text-white/85"
              >
                {m}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-5 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() =>
            onTriggerPayment(
              agent.id,
              merchant,
              legitAmount,
              `Legit: $${(legitAmount / 100).toFixed(2)} to ${merchant}`
            )
          }
          disabled={isLoading}
          className="btn btn-accent btn-sm !px-3 !gap-1.5 w-full"
        >
          <Zap aria-hidden="true" />
          <span>Pay ${(legitAmount / 100).toFixed(2)}</span>
        </button>

        <button
          type="button"
          onClick={() =>
            onTriggerPayment(
              agent.id,
              merchant,
              50000, // $500.00
              `Injection: Drain $500.00 to ${merchant}`
            )
          }
          disabled={isLoading}
          className="btn btn-ghost-light btn-sm !px-3 !gap-1.5 w-full"
        >
          <AlertOctagon aria-hidden="true" />
          <span>$500 attack</span>
        </button>
      </div>
    </article>
  );
}
