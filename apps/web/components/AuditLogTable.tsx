'use client';

import React from 'react';
import { CheckCircle2, XCircle, Clock, Shield, RefreshCw } from 'lucide-react';
import { truncateHash } from '@/lib/utils';

export interface AuditLogItem {
  id: string;
  timestamp: string;
  policyCommitment: string;
  amountCents: number;
  merchantIdHash: string;
  nonce: string;
  proofVerified: boolean;
  status: 'COMPLETED' | 'REJECTED';
  rejectionReason?: string;
  paypalOrderId?: string;
  paypalStatus?: string;
  durationMs: number;
}

interface AuditLogTableProps {
  logs: AuditLogItem[];
  onRefresh?: () => void;
  isLoading?: boolean;
}

export function AuditLogTable({
  logs,
  onRefresh,
  isLoading = false,
}: AuditLogTableProps) {
  return (
    <div className="rounded-2xl glass-panel border border-white/10 overflow-hidden">
      <div className="p-4 sm:p-5 flex items-center justify-between border-b border-white/10">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white tracking-tight">
              Gateway Settlement & Audit Log
            </h3>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Zero-Knowledge Protected
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Public ledger reveals only cryptographic commitments, hashes, and nonces. Private rules remain confidential.
          </p>
        </div>

        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors border border-white/10 disabled:opacity-40"
            title="Refresh logs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs font-mono">
          <thead className="bg-white/[0.02] text-gray-400 uppercase text-[10px] tracking-wider border-b border-white/5">
            <tr>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 px-4">Time</th>
              <th className="py-3 px-4">Nonce</th>
              <th className="py-3 px-4">Amount</th>
              <th className="py-3 px-4">Policy Commitment</th>
              <th className="py-3 px-4">Merchant Hash</th>
              <th className="py-3 px-4">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-gray-300">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-gray-500 text-xs">
                  No settlement records yet. Execute a demo transaction above.
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr
                  key={log.id}
                  className="hover:bg-white/[0.02] transition-colors"
                >
                  <td className="py-3 px-4">
                    {log.status === 'COMPLETED' ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                        <CheckCircle2 className="w-3 h-3" /> VERIFIED
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-500/10 text-red-400 border border-red-500/30"
                        title={log.rejectionReason}
                      >
                        <XCircle className="w-3 h-3" /> BLOCKED
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-gray-400 text-[11px]">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="py-3 px-4 text-gray-300">{log.nonce}</td>
                  <td className="py-3 px-4 font-bold text-white">
                    ${(log.amountCents / 100).toFixed(2)}
                  </td>
                  <td className="py-3 px-4 text-emerald-400" title={log.policyCommitment}>
                    {truncateHash(log.policyCommitment, 6, 4)}
                  </td>
                  <td className="py-3 px-4 text-gray-400" title={log.merchantIdHash}>
                    {truncateHash(log.merchantIdHash, 6, 4)}
                  </td>
                  <td className="py-3 px-4 text-gray-400">{log.durationMs}ms</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
