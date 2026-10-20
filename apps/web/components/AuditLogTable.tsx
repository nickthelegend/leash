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
  status: 'COMPLETED' | 'REJECTED' | 'FAILED';
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

function StatusPill({ log }: { log: AuditLogItem }) {
  if (log.status === 'COMPLETED') {
    return (
      <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[12px] font-medium bg-ok-soft text-ok whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Paid
      </span>
    );
  }
  if (log.status === 'FAILED') {
    return (
      <span
        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[12px] font-medium bg-sun text-sun-ink whitespace-nowrap"
        title={log.rejectionReason}
      >
        <Clock className="w-3.5 h-3.5" aria-hidden="true" /> Not paid
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[12px] font-medium bg-no-soft text-no whitespace-nowrap"
      title={log.rejectionReason}
    >
      <XCircle className="w-3.5 h-3.5" aria-hidden="true" /> Blocked
    </span>
  );
}

function releaseText(log: AuditLogItem): string {
  if (log.paypalOrderId) return log.paypalOrderId;
  if (log.status === 'FAILED') {
    return /not configured/i.test(log.rejectionReason || '') ? 'PayPal: setup required' : 'PayPal: not completed';
  }
  return '—';
}

export function AuditLogTable({
  logs,
  onRefresh,
  isLoading = false,
}: AuditLogTableProps) {
  return (
    <div className="rounded-panel bg-cobalt-800 ring-1 ring-inset ring-cobalt-line overflow-hidden">
      <div className="p-5 sm:p-7 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="text-[26px] sm:text-[32px] leading-[1.05] font-medium tracking-tightest">
            Settlement and audit log
          </h2>
          <p className="mt-2 text-[14px] text-white/65 max-w-[62ch]">
            The gateway records commitments, hashes and nonces only. The private rules never appear here.
          </p>
        </div>

        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="btn btn-ghost-light btn-sm shrink-0 self-start sm:self-auto"
          >
            <RefreshCw className={isLoading ? 'motion-safe:animate-spin' : ''} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        )}
      </div>

      {logs.length === 0 ? (
        <div className="mx-5 sm:mx-7 mb-6 rounded-2xl border border-dashed border-white/15 px-5 py-10 text-center">
          <Shield className="mx-auto w-6 h-6 text-white/40" aria-hidden="true" />
          <p className="mt-3 font-medium">{isLoading ? 'Waiting for the first result…' : 'No settlement records yet'}</p>
          <p className="mt-1 text-[13.5px] text-white/55">
            Run the 10-second demo or pay from an agent card. Every attempt, paid or blocked, lands here.
          </p>
        </div>
      ) : (
        <>
          {/* Phone: stacked rows */}
          <ul className="md:hidden divide-y divide-white/[0.07] border-t border-white/[0.07]">
            {logs.map((log) => (
              <li key={log.id} className="px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <StatusPill log={log} />
                  <span className="text-[12px] text-white/55">{new Date(log.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-3">
                  <span className="text-[22px] font-medium tracking-tighter2">
                    {log.amountCents} <span className="text-[13px] text-white/55">cents</span>
                  </span>
                  <span className="mono text-[12px] text-white/55">{log.durationMs}ms</span>
                </div>
                <dl className="mt-2 grid gap-1 text-[12.5px]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/50">Nonce</dt>
                    <dd className="mono break-all text-right">{log.nonce}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/50">Commitment</dt>
                    <dd className="mono text-sun" title={log.policyCommitment}>
                      {truncateHash(log.policyCommitment, 6, 4) || '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/50">Release</dt>
                    <dd className="mono text-right break-all">{releaseText(log)}</dd>
                  </div>
                </dl>
                {log.rejectionReason && (
                  <p className="mt-2 text-[12px] text-white/55 break-words">{log.rejectionReason}</p>
                )}
              </li>
            ))}
          </ul>

          {/* Tablet and up: table */}
          <div className="hidden md:block overflow-x-auto border-t border-white/[0.07]">
            <table className="w-full text-left text-[13px]">
              <thead className="text-white/50 text-[12px]">
                <tr>
                  <th scope="col" className="py-3 pl-7 pr-4 font-normal">Status</th>
                  <th scope="col" className="py-3 px-4 font-normal">Time</th>
                  <th scope="col" className="py-3 px-4 font-normal">Nonce</th>
                  <th scope="col" className="py-3 px-4 font-normal">Amount (cents)</th>
                  <th scope="col" className="py-3 px-4 font-normal">Policy commitment</th>
                  <th scope="col" className="py-3 px-4 font-normal">Merchant hash</th>
                  <th scope="col" className="py-3 px-4 font-normal">Release</th>
                  <th scope="col" className="py-3 pl-4 pr-7 font-normal text-right">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.07]">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-white/[0.03] transition-colors">
                    <td className="py-3.5 pl-7 pr-4">
                      <StatusPill log={log} />
                    </td>
                    <td className="py-3.5 px-4 text-white/60 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-3.5 px-4 mono text-[12px] text-white/80">{log.nonce}</td>
                    <td className="py-3.5 px-4 font-medium whitespace-nowrap">
                      {log.amountCents}{' '}
                      <span className="text-white/45 font-normal">(${(log.amountCents / 100).toFixed(2)})</span>
                    </td>
                    <td className="py-3.5 px-4 mono text-[12px] text-sun" title={log.policyCommitment}>
                      {truncateHash(log.policyCommitment, 6, 4) || '—'}
                    </td>
                    <td className="py-3.5 px-4 mono text-[12px] text-white/60" title={log.merchantIdHash}>
                      {truncateHash(log.merchantIdHash, 6, 4) || '—'}
                    </td>
                    <td className="py-3.5 px-4 mono text-[12px] text-white/70" title={log.rejectionReason || log.paypalStatus}>
                      {releaseText(log)}
                    </td>
                    <td className="py-3.5 pl-4 pr-7 mono text-[12px] text-white/60 text-right">{log.durationMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
