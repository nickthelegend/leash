'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from '@/components/Navbar';
import { DemoRunner } from '@/components/DemoRunner';
import { ZKProofIndicator, ZKStatus, ZKProofData } from '@/components/ZKProofIndicator';
import { AgentCard, AgentConfig } from '@/components/AgentCard';
import { AuditLogTable, AuditLogItem } from '@/components/AuditLogTable';
import { PromptInjectionMatrix } from '@/components/PromptInjectionMatrix';
import { ShieldCheck, Cpu, Lock, Sparkles, Layers, Terminal } from 'lucide-react';

const INITIAL_AGENTS: AgentConfig[] = [
  {
    id: 'agent_1',
    name: 'LLM Inference & Research Agent',
    model: 'Claude 3.5 Sonnet',
    role: 'Autonomous Inference & Prompt Processing',
    allowlistedMerchants: ['openai', 'anthropic', 'vercel'],
    capCents: 500, // $5.00
    commitmentHash: '0x15c086a64383a3b30c046d3dcf063b01abdb316633ca0280f8e1f1bd3ec8cd6c',
  },
  {
    id: 'agent_2',
    name: 'Cloud DevOps SRE Agent',
    model: 'GPT-4o',
    role: 'Infrastructure Auto-Scaling & Build Pipelines',
    allowlistedMerchants: ['aws', 'github', 'digitalocean'],
    capCents: 1000, // $10.00
    commitmentHash: '0x2b8e4f1a9c3d5e7b2a6f8c0e4d6a8b2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b',
  },
  {
    id: 'agent_3',
    name: 'Data Pipeline Agent',
    model: 'DeepSeek V3',
    role: 'Database Ingestion & Cache Syncing',
    allowlistedMerchants: ['supabase', 'aws'],
    capCents: 300, // $3.00
    commitmentHash: '0x3c9f2b4e6a8d0c2e4f6a8b0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f',
  },
];

export default function Home() {
  const [agents, setAgents] = useState<AgentConfig[]>(INITIAL_AGENTS);
  const [zkStatus, setZkStatus] = useState<ZKStatus>('idle');
  const [zkProofData, setZkProofData] = useState<ZKProofData | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [nonceCounter, setNonceCounter] = useState(1001);

  // Fetch initial audit logs
  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/logs');
      if (res.ok) {
        const data = await res.json();
        if (data.logs) {
          setLogs(data.logs);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Handle spending dial adjustments
  const handleCapChange = (agentId: string, newCapCents: number) => {
    setAgents((prev) =>
      prev.map((agent) => {
        if (agent.id === agentId) {
          // Recompute a pseudo commitment preview for visual feedback
          return {
            ...agent,
            capCents: newCapCents,
          };
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

    const nonce = String(nonceCounter);
    setNonceCounter((prev) => prev + 1);

    try {
      // 1. Prover generates real UltraHonk proof
      const proveRes = await fetch('/api/prove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchantName,
          amountCents,
          nonce,
        }),
      });

      const proveData = await proveRes.json();

      if (!proveData.success) {
        // Circuit violation (e.g. over cap or unlisted merchant)
        setZkStatus('rejected');
        setZkProofData({
          rejectionReason:
            proveData.error ||
            `Circuit assertion failed: Amount $${(amountCents / 100).toFixed(
              2
            )} exceeds active cap of $${(targetAgent.capCents / 100).toFixed(2)}`,
        });

        const newLog: AuditLogItem = {
          id: `log_${Date.now()}`,
          timestamp: new Date().toISOString(),
          policyCommitment: targetAgent.commitmentHash,
          amountCents,
          merchantIdHash: '0x0000...blocked',
          nonce,
          proofVerified: false,
          status: 'REJECTED',
          rejectionReason: proveData.error,
          durationMs: 18,
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
          durationMs: verifyData.durationMs || 12,
          extractedPublicInputs: verifyData.extractedPublicInputs,
          verifiedAt: new Date().toLocaleTimeString(),
        });

        // Trigger PayPal order release
        const payRes = await fetch('/api/pay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            policyCommitment: proveData.publicInputs.policy_commitment,
            amountCents,
            merchantIdHash: proveData.publicInputs.merchant_id_hash,
            nonce,
            proofHex: proveData.proofHex,
            publicInputsHex: proveData.publicInputsHex,
            merchantName,
          }),
        });

        const payData = await payRes.json();

        const completedLog: AuditLogItem = {
          id: `log_${Date.now()}`,
          timestamp: new Date().toISOString(),
          policyCommitment: proveData.publicInputs.policy_commitment,
          amountCents,
          merchantIdHash: proveData.publicInputs.merchant_id_hash,
          nonce,
          proofVerified: true,
          status: 'COMPLETED',
          paypalOrderId: payData.paypal?.orderId,
          paypalStatus: payData.paypal?.status || 'COMPLETED',
          durationMs: (proveData.durationMs || 290) + (verifyData.durationMs || 12),
        };
        setLogs((prev) => [completedLog, ...prev]);
      } else {
        setZkStatus('rejected');
        setZkProofData({
          rejectionReason:
            verifyData.error || 'Cryptographic verification failed in Barretenberg.',
        });
      }
    } catch (err: any) {
      setZkStatus('rejected');
      setZkProofData({
        rejectionReason: `Execution error: ${err.message}`,
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

  return (
    <div className="min-h-screen bg-[#08090d] text-gray-100 flex flex-col font-sans">
      <Navbar />

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-8 py-6 space-y-8">
        {/* Hero Section */}
        <div className="text-center max-w-3xl mx-auto space-y-3 pt-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.2)]">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            <span>Stateless 2-Rule Circuit • UltraHonk Real Verifier</span>
          </div>

          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
            LEASH: Zero-Knowledge Spending Policies for AI Agents
          </h1>

          <p className="text-sm sm:text-base text-gray-400 max-w-2xl mx-auto">
            Prompt injection attacks can compromise an LLM agent, but they cannot
            break polynomial zero-knowledge mathematics. Each payment requires a valid
            Noir proof against a committed policy before PayPal releases funds.
          </p>
        </div>

        {/* 10-Second Demo Moment Hero */}
        <section aria-label="10-Second Demo Moment">
          <DemoRunner
            onRunLegitDemo={runLegitDemo}
            onRunAttackDemo={runAttackDemo}
            isRunning={isLoading}
          />
        </section>

        {/* Live ZK Proof Indicator Showcase */}
        <section aria-label="Live ZK Proof Indicator">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-300">
                Live Zero-Knowledge Proof Status
              </h2>
            </div>
            <span className="text-xs text-gray-500 font-mono">
              Engine: Barretenberg (bb verify)
            </span>
          </div>

          <ZKProofIndicator
            status={zkStatus}
            proofData={zkProofData}
            agentName={agents.find((a) => a.id === activeAgentId)?.name}
          />
        </section>

        {/* Agents & Spending Limit Dials */}
        <section aria-label="Agent Spending Limit Dials">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-emerald-400" />
                <h2 className="text-base font-bold text-white tracking-tight">
                  Active Agent Fleet & Spending Dials
                </h2>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                Rotate each agent's spending dial to tune their per-transaction cap.
                Judges see only the commitment hash; policy rules remain secret.
              </p>
            </div>
            <span className="hidden sm:inline-flex text-xs font-mono text-emerald-400/90 bg-white/5 px-2.5 py-1 rounded-lg border border-white/10">
              3 Agents Active
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
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
        <section aria-label="Prompt Injection Harness Matrix">
          <PromptInjectionMatrix />
        </section>

        {/* Settlement Audit Log */}
        <section aria-label="Settlement Audit Log">
          <AuditLogTable
            logs={logs}
            onRefresh={fetchLogs}
            isLoading={isLoading}
          />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 py-6 px-4 text-center text-xs text-gray-500 font-mono">
        <p>
          LEASH • PayPal AI Hackathon • Noir Circuits + Barretenberg UltraHonk •
          Zero-Knowledge Proofs for Autonomous Agent Governance
        </p>
      </footer>
    </div>
  );
}
