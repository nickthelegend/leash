'use client';

import React from 'react';
import { Bot, Shield, Check, Copy, AlertOctagon, Zap, ArrowRight } from 'lucide-react';
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

  return (
    <div
      className={`relative rounded-2xl glass-panel p-5 transition-all duration-300 flex flex-col justify-between ${
        isThisAgentActive
          ? 'border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.15)] ring-1 ring-emerald-500/30'
          : 'hover:border-white/20'
      }`}
    >
      <div>
        {/* Agent Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500/20 to-cyan-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-white text-sm tracking-tight">
                  {agent.name}
                </h3>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                  Protected
                </span>
              </div>
              <p className="text-xs text-gray-400">
                {agent.model} • <span className="text-gray-300">{agent.role}</span>
              </p>
            </div>
          </div>
        </div>

        {/* Commitment Hash Pill (Shows secret policy is committed publicly) */}
        <div className="mb-4 bg-black/40 rounded-xl p-2.5 border border-white/5 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-1.5 text-gray-400">
            <Shield className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] text-gray-400">Commitment:</span>
            <span className="text-emerald-300 font-semibold" title={agent.commitmentHash}>
              {truncateHash(agent.commitmentHash, 6, 4)}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCopyCommitment}
            className="text-gray-400 hover:text-white transition-colors p-1 rounded hover:bg-white/5"
            title="Copy full commitment hash"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* Spending Limit Dial */}
        <div className="my-2">
          <SpendingLimitDial
            valueCents={agent.capCents}
            onChange={(newCap) => onCapChange(agent.id, newCap)}
            agentName={agent.name}
            disabled={isLoading}
          />
        </div>

        {/* Merchant Allowlist Chips (Rule R1) */}
        <div className="mt-4 pt-3 border-t border-white/5">
          <div className="flex items-center justify-between text-[11px] text-gray-400 mb-2">
            <span>Rule R1: Merkle Allowlist</span>
            <span className="text-[10px] text-emerald-400/80 font-mono">
              {agent.allowlistedMerchants.length} authorized
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {agent.allowlistedMerchants.map((merchant) => (
              <span
                key={merchant}
                className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-white/5 text-gray-300 border border-white/10"
              >
                {merchant}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Action Buttons for Testing Agent */}
      <div className="mt-5 pt-3 border-t border-white/5 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() =>
            onTriggerPayment(
              agent.id,
              agent.allowlistedMerchants[0] || 'openai',
              Math.min(300, agent.capCents),
              `Legit: $${(Math.min(300, agent.capCents) / 100).toFixed(2)} to ${agent.allowlistedMerchants[0] || 'openai'}`
            )
          }
          disabled={isLoading}
          className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 active:bg-emerald-500/30 border border-emerald-500/30 text-emerald-300 text-xs font-semibold transition-all disabled:opacity-50"
        >
          <Zap className="w-3.5 h-3.5 text-emerald-400" />
          <span>Pay ${(Math.min(300, agent.capCents) / 100).toFixed(2)}</span>
        </button>

        <button
          type="button"
          onClick={() =>
            onTriggerPayment(
              agent.id,
              agent.allowlistedMerchants[0] || 'openai',
              50000, // $500.00
              `Injection: Drain $500.00 to ${agent.allowlistedMerchants[0] || 'openai'}`
            )
          }
          disabled={isLoading}
          className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 active:bg-red-500/30 border border-red-500/30 text-red-300 text-xs font-semibold transition-all disabled:opacity-50"
        >
          <AlertOctagon className="w-3.5 h-3.5 text-red-400" />
          <span>Test $500 Attack</span>
        </button>
      </div>
    </div>
  );
}
