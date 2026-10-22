'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from '@/components/Navbar';
import { LandingHero, LandingSections, SiteFooter } from '@/components/Landing';
import { PayPalSetupCard } from '@/components/PayPalSetupCard';
import { DemoRunner } from '@/components/DemoRunner';
import { ZKProofIndicator, ZKStatus, ZKProofData } from '@/components/ZKProofIndicator';
import { AgentCard, AgentConfig } from '@/components/AgentCard';
import { AuditLogTable, AuditLogItem } from '@/components/AuditLogTable';
import { PromptInjectionMatrix } from '@/components/PromptInjectionMatrix';
import type { MerchantLeaf, Receipt } from '@leash/core';

/** What the console needs from a committed policy (the full object goes back to the owner-device prover). */
type CommittedPolicy = { policyCommitment: string; maxPerTxCents: number; merchantLeaves?: Pick<MerchantLeaf, 'name' | 'paypalMerchantId'>[] };

// Example policies for the owner device. Names describe what each would pay for; no model is claimed.
const INITIAL_AGENTS: AgentConfig[] = [
  {
    id: 'agent_1',
    name: 'Research agent',
    model: 'Example policy',
    role: 'Pays for inference',
    allowlistedMerchants: ['openai', 'anthropic', 'vercel'],
    capCents: 500, // $5.00
    commitmentHash: '',
  },
  {
    id: 'agent_2',
    name: 'DevOps agent',
    model: 'Example policy',
    role: 'Pays for CI and hosting',
    allowlistedMerchants: ['aws', 'github', 'digitalocean'],
    capCents: 1000, // $10.00
    commitmentHash: '',
  },
  {
    id: 'agent_3',
    name: 'Data agent',
    model: 'Example policy',
    role: 'Pays for storage and sync',
    allowlistedMerchants: ['supabase', 'aws'],
    capCents: 300, // $3.00
    commitmentHash: '',
  },
];

/** Allowlist name the server gives the PayPal sandbox merchant (apps/web/app/api/policies/route.ts). */
const PAYPAL_MERCHANT = 'paypal-sandbox-merchant';

export default function Home() {
  const [agents, setAgents] = useState<AgentConfig[]>(INITIAL_AGENTS);
  const [zkStatus, setZkStatus] = useState<ZKStatus>('idle');
  const [zkProofData, setZkProofData] = useState<ZKProofData | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  // Receipts are persisted (gateway + this device's on-chain releases); refusals and setup stops are this session's only.
  const [receiptLogs, setReceiptLogs] = useState<AuditLogItem[]>([]);
  const [localLogs, setLocalLogs] = useState<AuditLogItem[]>([]);
  const logs = [...localLogs, ...receiptLogs].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const setLogs = (f: (prev: AuditLogItem[]) => AuditLogItem[]) => setLocalLogs(f);
  const [isLoading, setIsLoading] = useState(false);
  const [nonceCounter, setNonceCounter] = useState(1001);
  const [owner, setOwner] = useState<string | null>(null);
  // Set when the server has PAYPAL_PAYEE_MERCHANT_ID: every committed policy then lists this merchant
  // with its PayPal merchant id, and the console's payments go to it (the PayPal rail).
  const [paypalMerchant, setPaypalMerchant] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  // Walk log load state: what the last receipts fetch returned, or why it failed (never swallowed).
  const [receiptsStatus, setReceiptsStatus] = useState<{ count: number; at: string } | null>(null);
  const [receiptsError, setReceiptsError] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/receipts');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const receipts = (data.receipts ?? []) as Receipt[];
      setReceiptLogs(
        receipts.map((r) => ({
          id: `${r.rail}:${r.policyId}:${r.nonce}`,
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
          rail: r.rail,
          txHash: r.txHash,
          durationMs: 0,
        }))
      );
      setReceiptsError(null);
      setReceiptsStatus({ count: receipts.length, at: new Date().toLocaleTimeString() });
    } catch (err) {
      setReceiptsError(`Could not load receipts: ${String((err as Error)?.message ?? err)}`);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    fetch('/api/policies')
      .then((r) => r.json())
      .then((d) => {
        setOwner(d.owner ?? null);
        setPaypalMerchant(d.paypalPayeeMerchantId ? PAYPAL_MERCHANT : null);
      })
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
  const policiesRef = React.useRef<Record<string, CommittedPolicy>>({});
  const [policyError, setPolicyError] = useState<string | null>(null);
  const commitPolicy = useCallback(async (agent: AgentConfig): Promise<CommittedPolicy> => {
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
    amountCents: number
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
      const policy: CommittedPolicy =
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
        const leaf = policy.merchantLeaves?.find((m) => m.name === merchantName.trim().toLowerCase());
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
    } catch (err) {
      setZkStatus('rejected');
      const message = String((err as Error)?.message ?? err);
      setZkProofData({
        setupError: /not configured/i.test(message),
        rejectionReason: message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Demo helpers for DemoRunner
  const walkMerchant = paypalMerchant ?? 'openai';
  const runLegitDemo = async () => {
    await executePayment(agents[0].id, walkMerchant, 300);
  };

  const runAttackDemo = async () => {
    await executePayment(agents[0].id, walkMerchant, 50000);
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

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <LandingHero />
      <LandingSections />

      {/* Console: the owner's device, same metaphor (tags, lead, snaps, walk log) */}
      <main id="console" className="cx scroll-mt-0" aria-label="LEASH console">
        <div className="cx-strap" aria-hidden="true" />
        <div className="lz-wrap py-16 sm:py-20">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
            <div>
              <p className="lz-num !text-sun">06 · Console · owner device</p>
              <h2 className="lz-h2 !max-w-[22ch]">Put your own agents on a leash.</h2>
              <p className="mt-4 text-[16px] leading-relaxed text-white/70 max-w-[62ch]">
                Live, not the recording: each tag below is a policy committed by this server just now. Paying proves
                with nargo and bb on this machine, then the verify-only gateway decides what is released.
              </p>
            </div>
            <dl className="flex flex-wrap gap-2 text-[13px]">
              <div className="rounded-[10px] bg-cobalt-900 px-3 py-2">
                <dt className="sr-only">Verifier</dt>
                <dd className="mono text-white/80">bb verify · local gateway</dd>
              </div>
              <div className="rounded-[10px] bg-cobalt-900 px-3 py-2">
                <dt className="inline text-white/55">owner </dt>
                <dd className="inline mono text-sun">{owner ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : 'loading…'}</dd>
              </div>
            </dl>
          </div>

          {policyError && (
            <div role="alert" className="mt-6 rounded-2xl bg-no-soft px-4 py-3 text-[14px] text-no break-words">
              Policy commitment unavailable: {policyError}
            </div>
          )}

          {/* Session lead: what this gateway actually released */}
          <section aria-label="Session overview" className="mt-10 grid gap-4 lg:grid-cols-[1.45fr_1fr]">
            <div className="cx-panel p-5 sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-[18px] sm:text-[20px] font-semibold tracking-tighter2">This session&rsquo;s lead</span>
                <span className="mono text-[12.5px] text-white/55">from the receipts</span>
              </div>
              <div className="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <div
                  className="font-semibold tracking-tightest leading-none text-[52px] sm:text-[72px]"
                  aria-label={`${releasedCents} cents released`}
                >
                  {releasedCents}
                  <span className="text-[20px] sm:text-[24px] font-normal tracking-normal text-white/50"> cents released</span>
                </div>
                <span className="mono text-[13px] text-white/55">${releasedWhole}.{releasedFraction}</span>
              </div>
              <dl className="mt-6 grid grid-cols-3 gap-3">
                <div className="rounded-[14px] bg-cobalt-800 p-3 sm:p-4">
                  <dt className="text-[12px] text-white/60">Paid</dt>
                  <dd className="mt-1 text-[24px] sm:text-[28px] font-semibold tracking-tighter2">{paidLogs.length}</dd>
                </div>
                <div className="rounded-[14px] bg-cobalt-800 p-3 sm:p-4">
                  <dt className="text-[12px] text-white/60">Verified, not paid</dt>
                  <dd className="mt-1 text-[24px] sm:text-[28px] font-semibold tracking-tighter2">
                    {notPaidCount + awaitingCount}
                  </dd>
                </div>
                <div className="rounded-[14px] bg-cobalt-800 p-3 sm:p-4">
                  <dt className="text-[12px] text-white/60">Snapped</dt>
                  <dd className="mt-1 text-[24px] sm:text-[28px] font-semibold tracking-tighter2">{blockedCount}</dd>
                </div>
              </dl>
              <p className="mt-4 text-[12.5px] text-white/50">
                A verified proof only counts as paid once PayPal reports the capture COMPLETED for exactly the proven
                cents, or LeashPayment released them on the local Anvil chain (1 cent settles as 1 wei).
              </p>
            </div>
            <PayPalSetupCard orderId={latestOrder?.paypalOrderId} orderStatus={latestOrder?.paypalStatus} />
          </section>

          {/* Agent tags */}
          <section id="fleet" aria-labelledby="fleet-h" className="mt-14 scroll-mt-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-6">
              <div>
                <h3 id="fleet-h" className="text-[26px] sm:text-[32px] leading-[1.05] font-semibold tracking-tightest">
                  Agent tags
                </h3>
                <p className="mt-2 text-[14px] text-white/65 max-w-[64ch]">
                  Turn a spool to change that agent&rsquo;s lead (its per-payment cap); the policy is re-committed and
                  the tag gets a new hash. The daily cap is three leads long.
                </p>
              </div>
              <span className="mono text-[13px] text-white/55">{agents.length} example policies</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  spentTodayCents={spendFor(agent.id).spentBeforeCents}
                  dailyCapCents={agent.capCents * 3}
                  onCapChange={handleCapChange}
                  onTriggerPayment={executePayment}
                  isLoading={isLoading}
                  activeAgentId={activeAgentId}
                  paypalMerchant={paypalMerchant}
                />
              ))}
            </div>
          </section>

          {/* Walk test + lead state */}
          <section id="run" aria-label="Walk test and proof status" className="mt-14 grid gap-4 lg:grid-cols-2 scroll-mt-6">
            <DemoRunner onRunLegitDemo={runLegitDemo} onRunAttackDemo={runAttackDemo} isRunning={isLoading} merchant={walkMerchant} />
            <ZKProofIndicator
              status={zkStatus}
              proofData={zkProofData}
              agentName={agents.find((a) => a.id === activeAgentId)?.name}
            />
          </section>

          {/* Pull test */}
          <section id="harness" aria-label="Pull test" className="mt-4 scroll-mt-6">
            <PromptInjectionMatrix />
          </section>

          {/* Walk log, this console */}
          <section id="audit" aria-label="Walk log for this console" className="mt-4 scroll-mt-6">
            {captureError && (
              <div role="alert" className="mb-3 rounded-2xl bg-no-soft px-4 py-3 text-[14px] text-no break-words">
                {captureError}
              </div>
            )}
            <AuditLogTable
              logs={logs}
              onRefresh={fetchLogs}
              onCapture={capture}
              isLoading={isLoading}
              loadedReceipts={receiptsStatus}
              loadError={receiptsError}
            />
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
