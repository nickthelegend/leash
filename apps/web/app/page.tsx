'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from '@/components/Navbar';
import { LandingHero, LandingSections, SiteFooter } from '@/components/Landing';
import { LeashLogo, LeashMark } from '@/components/Logo';
import { PayPalSetupCard } from '@/components/PayPalSetupCard';
import { DemoRunner } from '@/components/DemoRunner';
import { ZKProofIndicator, ZKStatus, ZKProofData } from '@/components/ZKProofIndicator';
import { AgentCard, AgentConfig } from '@/components/AgentCard';
import { AuditLogTable, AuditLogItem } from '@/components/AuditLogTable';
import { PromptInjectionMatrix } from '@/components/PromptInjectionMatrix';

const INITIAL_AGENTS: AgentConfig[] = [
  {
    id: 'agent_1',
    name: 'LLM Inference & Research Agent',
    model: 'Claude 3.5 Sonnet',
    role: 'Autonomous Inference & Prompt Processing',
    allowlistedMerchants: ['openai', 'anthropic', 'vercel'],
    capCents: 500, // $5.00
    commitmentHash: '',
  },
  {
    id: 'agent_2',
    name: 'Cloud DevOps SRE Agent',
    model: 'GPT-4o',
    role: 'Infrastructure Auto-Scaling & Build Pipelines',
    allowlistedMerchants: ['aws', 'github', 'digitalocean'],
    capCents: 1000, // $10.00
    commitmentHash: '',
  },
  {
    id: 'agent_3',
    name: 'Data Pipeline Agent',
    model: 'DeepSeek V3',
    role: 'Database Ingestion & Cache Syncing',
    allowlistedMerchants: ['supabase', 'aws'],
    capCents: 300, // $3.00
    commitmentHash: '',
  },
];

export default function Home() {
  const [agents, setAgents] = useState<AgentConfig[]>(INITIAL_AGENTS);
  const [zkStatus, setZkStatus] = useState<ZKStatus>('idle');
  const [zkProofData, setZkProofData] = useState<ZKProofData | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  // Receipts come from the gateway (persisted); refusals and setup stops are this session's only.
  const [receiptLogs, setReceiptLogs] = useState<AuditLogItem[]>([]);
  const [localLogs, setLocalLogs] = useState<AuditLogItem[]>([]);
  const logs = [...localLogs, ...receiptLogs].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const setLogs = (f: (prev: AuditLogItem[]) => AuditLogItem[]) => setLocalLogs(f);
  const [isLoading, setIsLoading] = useState(false);
  const [nonceCounter, setNonceCounter] = useState(1001);
  const [owner, setOwner] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/receipts');
      if (res.ok) {
        const data = await res.json();
        setReceiptLogs(
          (data.receipts ?? []).map((r: any) => ({
            id: `${r.policyId}:${r.nonce}`,
            timestamp: r.ts,
            policyCommitment: r.policyId,
            policyId: r.policyId,
            amountCents: r.amountCents,
            merchantIdHash: r.merchantIdHash,
            nonce: r.nonce,
            proofVerified: true,
            status: r.status,
            rejectionReason: r.error,
            paypalOrderId: r.paypalOrderId,
            paypalStatus: r.captureId ? `capture ${r.captureId}` : r.status,
            approveUrl: r.approveUrl,
            durationMs: 0,
          }))
        );
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    fetch('/api/policies')
      .then((r) => r.json())
      .then((d) => setOwner(d.owner ?? null))
      .catch(() => setOwner(null));
  }, [fetchLogs]);

  const capture = useCallback(
    async (policyId: string, nonce: string) => {
      setCaptureError(null);
      const res = await fetch('/api/pay/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyId, nonce }),
      });
      const data = await res.json();
      if (!data.success) setCaptureError(data.error || `Capture failed (HTTP ${res.status})`);
      await fetchLogs();
    },
    [fetchLogs]
  );

  // Owner-device record of today's spend chain per agent policy (prev commitment + total that opens it).
  const spendRef = React.useRef<Record<string, { epoch: number; spentCents: number; commit: string }>>({});
  const spendFor = (agentId: string) => {
    const epoch = Math.floor(Date.now() / 86_400_000);
    const s = spendRef.current[agentId];
    return s && s.epoch === epoch
      ? { epoch, prevSpendCommit: s.commit, spentBeforeCents: s.spentCents }
      : { epoch, prevSpendCommit: '0', spentBeforeCents: 0 };
  };

  // Commit each agent's policy (cap + allowlist) server-side; the commitment is real Pedersen output.
  const policiesRef = React.useRef<Record<string, unknown>>({});
  const [policyError, setPolicyError] = useState<string | null>(null);
  const commitPolicy = useCallback(async (agent: AgentConfig) => {
    const res = await fetch('/api/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agent.name,
        maxPerTxCents: agent.capCents,
        dailyCapCents: agent.capCents * 3,
        approvalThresholdCents: Math.min(300, agent.capCents),
        merchants: agent.allowlistedMerchants,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.policy) {
      throw new Error(data.error || `Policy commit failed (HTTP ${res.status})`);
    }
    policiesRef.current[agent.id] = data.policy;
    setAgents((prev) =>
      prev.map((a) =>
        a.id === agent.id && a.capCents === data.policy.maxPerTxCents
          ? { ...a, commitmentHash: data.policy.policyCommitment }
          : a
      )
    );
    return data.policy;
  }, []);

  useEffect(() => {
    Promise.all(INITIAL_AGENTS.map(commitPolicy)).catch((e: Error) =>
      setPolicyError(e.message)
    );
  }, [commitPolicy]);

  // Handle spending dial adjustments
  const handleCapChange = (agentId: string, newCapCents: number) => {
    setAgents((prev) =>
      prev.map((agent) => {
        if (agent.id === agentId) {
          const next = { ...agent, capCents: newCapCents, commitmentHash: '' };
          delete policiesRef.current[agentId];
          delete spendRef.current[agentId];
          commitPolicy(next).catch((e: Error) => setPolicyError(e.message));
          return next;
        }
        return agent;
      })
    );
  };

  // Execute payment through real Noir prover & Barretenberg verifier
  const executePayment = async (
    agentId: string,
    merchantName: string,
    amountCents: number,
    label?: string
  ) => {
    const targetAgent = agents.find((a) => a.id === agentId) || agents[0];
    setActiveAgentId(targetAgent.id);
    setIsLoading(true);
    setZkStatus('proving');
    setZkProofData(null);

    const startedAt = Date.now();
    const nonce = `${startedAt}${nonceCounter}`;
    setNonceCounter((prev) => prev + 1);

    try {
      const policy: any =
        policiesRef.current[targetAgent.id] ?? (await commitPolicy(targetAgent));
      const spend = spendFor(targetAgent.id);
      // 1. Owner-device prover: real UltraHonk proof (needs the policy secrets, never sent to the gateway)
      const proveRes = await fetch('/api/prove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policy,
          merchantName,
          amountCents,
          nonce,
          spend,
        }),
      });

      const proveData = await proveRes.json();

      if (!proveData.success && proveData.kind === 'setup') {
        // Missing configuration is not a policy decision: show it, but don't log a BLOCKED payment.
        setZkStatus('rejected');
        setZkProofData({ setupError: true, rejectionReason: proveData.error || `Prover unavailable (HTTP ${proveRes.status})` });
        setIsLoading(false);
        return;
      }

      if (!proveData.success) {
        // Circuit violation (e.g. over cap or unlisted merchant)
        setZkStatus('rejected');
        setZkProofData({
          rejectionReason: proveData.error || `Prover failed (HTTP ${proveRes.status})`,
        });

        const newLog: AuditLogItem = {
          id: `log_${Date.now()}`,
          timestamp: new Date().toISOString(),
          policyCommitment: targetAgent.commitmentHash,
          amountCents,
          merchantIdHash: '',
          nonce,
          proofVerified: false,
          status: 'REJECTED',
          rejectionReason: proveData.error,
          durationMs: Date.now() - startedAt,
        };
        setLogs((prev) => [newLog, ...prev]);
        setIsLoading(false);
        return;
      }

      // 2. Gateway & Verifier service cryptographically verifies proof via Barretenberg
      const verifyRes = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proofHex: proveData.proofHex,
          publicInputsHex: proveData.publicInputsHex,
          expectedCommitment: proveData.publicInputs.policy_commitment,
          expectedAmount: amountCents,
          expectedMerchantHash: proveData.publicInputs.merchant_id_hash,
          expectedNonce: nonce,
        }),
      });

      const verifyData = await verifyRes.json();

      if (verifyData.success && verifyData.valid) {
        // Cryptographically verified! Pulse green!
        setZkStatus('verified');
        setZkProofData({
          proofHex: proveData.proofHex,
          publicInputsHex: proveData.publicInputsHex,
          durationMs: verifyData.durationMs,
          extractedPublicInputs: verifyData.extractedPublicInputs,
          verifiedAt: new Date().toLocaleTimeString(),
        });

        // 2. Release through the verify-only gateway: it re-verifies, checks the spend chain and the
        // PayPal payee, then creates the order (approve link above the threshold, vault capture below).
        const leaf = policy.merchantLeaves?.find((m: any) => m.name === merchantName.trim().toLowerCase());
        const payRes = await fetch('/api/pay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner,
            proofHex: proveData.proofHex,
            publicInputsHex: proveData.publicInputsHex,
            paypalMerchantId: leaf?.paypalMerchantId,
          }),
        });
        const payData = await payRes.json();

        if (payData.consumed) {
          // The gateway accepted the spend update: advance this device's daily total.
          spendRef.current[targetAgent.id] = {
            epoch: spend.epoch,
            spentCents: spend.spentBeforeCents + amountCents,
            commit: proveData.publicInputs.new_spend_commit,
          };
          await fetchLogs();
        } else {
          // Nothing consumed (e.g. Setup required): record the stop for this session only.
          setLogs((prev) => [
            {
              id: `log_${Date.now()}`,
              timestamp: new Date().toISOString(),
              policyCommitment: proveData.publicInputs.policy_commitment,
              amountCents,
              merchantIdHash: proveData.publicInputs.merchant_id_hash,
              nonce,
              proofVerified: true,
              status: 'FAILED',
              rejectionReason: payData.error || `Payment release failed (HTTP ${payRes.status})`,
              durationMs: Date.now() - startedAt,
            },
            ...prev,
          ]);
          setZkProofData((prev) => ({ ...(prev ?? {}), releaseNote: payData.error || `HTTP ${payRes.status}` }));
        }
      } else {
        setZkStatus('rejected');
        setZkProofData({
          rejectionReason:
            verifyData.error || `Verifier rejected the proof (HTTP ${verifyRes.status})`,
        });
      }
    } catch (err: any) {
      setZkStatus('rejected');
      const message = String(err?.message ?? err);
      setZkProofData({
        setupError: /not configured/i.test(message),
        rejectionReason: message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Demo helpers for DemoRunner
  const runLegitDemo = async () => {
    await executePayment(agents[0].id, 'openai', 300, 'Legit inference spend');
  };

  const runAttackDemo = async () => {
    await executePayment(agents[0].id, 'openai', 50000, 'Cap override injection');
  };

  // Derived from the gateway receipts only; nothing here is invented.
  const paidLogs = logs.filter((l) => l.status === 'COMPLETED');
  const awaitingCount = logs.filter((l) => l.status === 'AWAITING_APPROVAL').length;
  const releasedCents = paidLogs.reduce((sum, l) => sum + (Number(l.amountCents) || 0), 0);
  const notPaidCount = logs.filter((l) => l.status === 'FAILED').length;
  const blockedCount = logs.filter((l) => l.status === 'REJECTED').length;
  const latestOrder = paidLogs.find((l) => l.paypalOrderId);
  const releasedWhole = Math.floor(releasedCents / 100).toLocaleString('en-US');
  const releasedFraction = String(releasedCents % 100).padStart(2, '0');

  const consoleLinks = [
    { href: '#run', label: 'Run' },
    { href: '#fleet', label: 'Fleet' },
    { href: '#harness', label: 'Harness' },
    { href: '#audit', label: 'Audit log' },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <LandingHero />
      <LandingSections paypalOrderId={latestOrder?.paypalOrderId} paypalStatus={latestOrder?.paypalStatus} />

      {/* Console: the app frame */}
      <main id="console" className="bg-sun px-3 sm:px-6 lg:px-10 pt-12 sm:pt-16 pb-12 scroll-mt-0" aria-label="LEASH console">
        <div className="mx-auto max-w-[1400px] rounded-[28px] sm:rounded-frame bg-cobalt-900 text-white p-4 sm:p-7 lg:p-9">
          {/* Frame nav */}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <LeashLogo href="#console" className="text-white" />
            <nav aria-label="Console" className="order-3 w-full md:order-none md:w-auto">
              <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
                {consoleLinks.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} className="text-white/75 hover:text-sun no-underline transition-colors">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline-flex items-center gap-2 h-10 px-4 rounded-full bg-cobalt-800 text-[13px] text-white/75">
                <span className="mono">bb verify</span> · local gateway
              </span>
              <a href="#run" className="btn btn-accent btn-sm">
                Run demo
              </a>
            </div>
          </div>

          {policyError && (
            <div role="alert" className="mt-6 rounded-2xl bg-no-soft px-4 py-3 text-[14px] text-no break-words">
              Policy commitment unavailable: {policyError}
            </div>
          )}

          {/* Overview: balance-style number + PayPal status */}
          <section aria-label="Session overview" className="mt-8 grid gap-4 lg:grid-cols-[1.45fr_1fr]">
            <div className="rounded-panel bg-cobalt-800 p-5 sm:p-7 ring-1 ring-inset ring-cobalt-line">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <LeashMark className="w-10 h-10" />
                  <span className="text-[20px] sm:text-[24px] font-medium tracking-tighter2">Released after a proof</span>
                </div>
                <span className="inline-flex items-center h-7 px-3 rounded-full bg-cobalt-700 text-[12.5px] text-white/70">
                  This gateway session
                </span>
              </div>
              <div className="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <div className="font-medium tracking-tightest leading-none text-[56px] sm:text-[76px]" aria-label={`$${releasedWhole}.${releasedFraction} released`}>
                  <span className="text-white/45">$</span>
                  {releasedWhole}
                  <span className="text-white/35">.{releasedFraction}</span>
                </div>
                <span className="inline-flex items-center h-8 px-3 rounded-full bg-sun-soft text-sun text-[13px]">
                  {releasedCents} cents through PayPal
                </span>
              </div>
              <dl className="mt-7 grid grid-cols-3 gap-3">
                <div className="rounded-2xl bg-cobalt-700 p-3 sm:p-4">
                  <dt className="text-[12px] text-white/60">Paid</dt>
                  <dd className="mt-1 text-[24px] sm:text-[28px] font-medium tracking-tighter2">{paidLogs.length}</dd>
                </div>
                <div className="rounded-2xl bg-cobalt-700 p-3 sm:p-4">
                  <dt className="text-[12px] text-white/60">Verified, not paid</dt>
                  <dd className="mt-1 text-[24px] sm:text-[28px] font-medium tracking-tighter2">
                    {notPaidCount + awaitingCount}
                  </dd>
                </div>
                <div className="rounded-2xl bg-cobalt-700 p-3 sm:p-4">
                  <dt className="text-[12px] text-white/60">Blocked</dt>
                  <dd className="mt-1 text-[24px] sm:text-[28px] font-medium tracking-tighter2">{blockedCount}</dd>
                </div>
              </dl>
              <p className="mt-4 text-[12.5px] text-white/50">
                Counted from the gateway&rsquo;s receipts. A verified proof only counts as paid once PayPal reports the
                capture COMPLETED for exactly the proven cents.
              </p>
            </div>
            <PayPalSetupCard orderId={latestOrder?.paypalOrderId} orderStatus={latestOrder?.paypalStatus} />
          </section>

          {/* Demo + live proof status */}
          <section id="run" aria-label="Demo and live proof status" className="mt-4 grid gap-4 lg:grid-cols-2 scroll-mt-6">
            <DemoRunner onRunLegitDemo={runLegitDemo} onRunAttackDemo={runAttackDemo} isRunning={isLoading} />
            <ZKProofIndicator
              status={zkStatus}
              proofData={zkProofData}
              agentName={agents.find((a) => a.id === activeAgentId)?.name}
            />
          </section>

          {/* Agents & spending dials */}
          <section id="fleet" aria-label="Agent spending limit dials" className="mt-12 scroll-mt-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-5">
              <div>
                <h2 className="text-[30px] sm:text-[40px] leading-[1.02] font-medium tracking-tightest">
                  Agent fleet and spending dials
                </h2>
                <p className="mt-2 text-[14px] text-white/65 max-w-[64ch]">
                  Turn a dial to change that agent&rsquo;s per-transaction cap; the policy is re-committed on the
                  server. Only the commitment is shown, the rules stay secret.
                </p>
              </div>
              <span className="inline-flex items-center h-8 px-3 rounded-full bg-cobalt-800 text-[13px] text-white/70 self-start sm:self-auto">
                {agents.length} agents
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onCapChange={handleCapChange}
                  onTriggerPayment={executePayment}
                  isLoading={isLoading}
                  activeAgentId={activeAgentId}
                />
              ))}
            </div>
          </section>

          {/* Prompt Injection Matrix */}
          <section id="harness" aria-label="Prompt injection harness" className="mt-12 scroll-mt-6">
            <PromptInjectionMatrix />
          </section>

          {/* Settlement Audit Log */}
          <section id="audit" aria-label="Settlement audit log" className="mt-4 scroll-mt-6">
            {captureError && (
              <div role="alert" className="mb-3 rounded-2xl bg-no-soft px-4 py-3 text-[14px] text-no break-words">
                {captureError}
              </div>
            )}
            <AuditLogTable logs={logs} onRefresh={fetchLogs} onCapture={capture} isLoading={isLoading} />
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
