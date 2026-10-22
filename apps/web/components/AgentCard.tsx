'use client';

import React from 'react';
import { Check, Copy } from 'lucide-react';
import { SpendingLimitDial } from './SpendingLimitDial';

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
  /** Today's total from this device's spend chain (only advanced when the gateway consumed a payment). */
  spentTodayCents: number;
  dailyCapCents: number;
  onCapChange: (agentId: string, newCapCents: number) => void;
  onTriggerPayment: (agentId: string, merchant: string, amountCents: number) => void;
  isLoading?: boolean;
  activeAgentId?: string | null;
  /**
   * The PayPal sandbox merchant ('paypal-sandbox-merchant') when PAYPAL_PAYEE_MERCHANT_ID is set: the
   * server adds it to every committed policy, and Pay / Tug pay it so the gateway can release through
   * PayPal. Otherwise Pay uses the agent's first allowlisted merchant.
   */
  paypalMerchant?: string | null;
}

/** An agent's policy as a yellow tag: the commitment engraved, the spool (cap), today's cord, the allowlist. */
export function AgentCard({
  agent,
  spentTodayCents,
  dailyCapCents,
  onCapChange,
  onTriggerPayment,
  isLoading = false,
  activeAgentId,
  paypalMerchant,
}: AgentCardProps) {
  const [copied, setCopied] = React.useState(false);
  const isActive = activeAgentId === agent.id;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(agent.commitmentHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const legitAmount = Math.min(300, agent.capCents);
  const merchant = paypalMerchant || agent.allowlistedMerchants[0] || 'openai';
  const allowlist = paypalMerchant ? [...agent.allowlistedMerchants, paypalMerchant] : agent.allowlistedMerchants;
  const cordPct = Math.min(100, (spentTodayCents / dailyCapCents) * 100);
  const hex = agent.commitmentHash.replace(/^0x/, '');

  return (
    <article className={`tag-card flex flex-col ${isActive ? 'is-active' : ''}`} aria-labelledby={`${agent.id}-h`}>
      <span className="tag-card-hole" aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={`${agent.id}-h`} className="text-[21px] font-semibold leading-tight tracking-tighter2">
            {agent.name}
          </h4>
          <p className="mt-0.5 text-[13.5px] text-[#3a4470]">
            {agent.role}
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!agent.commitmentHash}
          className="grid place-items-center w-9 h-9 shrink-0 rounded-[10px] bg-cobalt-900/10 hover:bg-cobalt-900/20 transition-colors disabled:opacity-40"
          aria-label={copied ? 'Commitment copied' : 'Copy the full commitment'}
        >
          {copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
        </button>
      </div>

      {/* Engraved commitment: the only public part of the policy */}
      <div className="mt-4 rounded-[14px] border border-dashed border-cobalt-900/40 px-3 py-2.5">
        <div className="text-[11px] mono uppercase tracking-[0.08em] text-[#3a4470]">Engraved commitment</div>
        {agent.commitmentHash ? (
          <p className="mt-1 mono text-[12.5px] leading-[1.45] font-medium break-all" title={agent.commitmentHash}>
            0x{hex.slice(0, 32)}
            <br />
            {hex.slice(32)}
          </p>
        ) : (
          <p className="mt-1 text-[13px] text-[#3a4470]" role="status">
            Committing on the server…
          </p>
        )}
      </div>

      <div className="mt-4">
        <SpendingLimitDial
          valueCents={agent.capCents}
          onChange={(c) => onCapChange(agent.id, c)}
          agentName={agent.name}
          disabled={isLoading}
        />
      </div>

      {/* Today's cord on this device */}
      <div className="mt-4">
        <div className="flex justify-between gap-3 text-[12.5px] mb-1.5">
          <span>Cord paid out today</span>
          <span className="mono">
            {spentTodayCents} / {dailyCapCents} cents
          </span>
        </div>
        <div
          className="cx-cord"
          role="meter"
          aria-label={`${agent.name}: paid out today`}
          aria-valuemin={0}
          aria-valuemax={dailyCapCents}
          aria-valuenow={spentTodayCents}
        >
          <i style={{ width: `${cordPct}%` }} />
        </div>
      </div>

      <div className="mt-4">
        <div className="text-[12.5px] mb-1.5">Allowlist · payee bound per merchant</div>
        <div className="flex flex-wrap gap-1.5">
          {allowlist.map((m) => (
            <span key={m} className="inline-flex items-center h-7 px-2.5 rounded-[7px] mono text-[12px] bg-cobalt-900 text-sun">
              {m}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-auto pt-5 text-[12.5px] text-[#3a4470] break-words">
        Pay and Tug pay <span className="mono font-medium">{merchant}</span>
        {paypalMerchant ? ' on the PayPal rail' : ''}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onTriggerPayment(agent.id, merchant, legitAmount)}
          disabled={isLoading}
          className="btn btn-dark btn-sm !px-3 w-full"
        >
          Pay {legitAmount} cents
        </button>
        <button
          type="button"
          onClick={() => onTriggerPayment(agent.id, merchant, 50000)}
          disabled={isLoading}
          className="btn btn-line btn-sm !px-3 w-full"
        >
          Tug $500
        </button>
      </div>
    </article>
  );
}
