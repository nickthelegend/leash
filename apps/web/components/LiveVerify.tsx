'use client';

import React, { useState } from 'react';
import { BadgeCheck, Loader2, ShieldCheck, ShieldX } from 'lucide-react';
import type { ZKProofData, ZKStatus } from './ZKProofIndicator';

/** Hex of a file served beside the page (the committed proof fixture). */
async function fetchHex(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return Array.from(new Uint8Array(await res.arrayBuffer()), (b) => b.toString(16).padStart(2, '0')).join('');
}

const PROOF = '/fixtures/base/proof';
const INPUTS = '/fixtures/base/public_inputs';

/**
 * Hosted console only: the committed fixture proof (contracts/test/fixtures/base, a 300-cent payment proven
 * for the EVM target) goes to the live verify-only gateway, which runs bb verify against its own key. Flipping
 * one byte must make the same gateway reject it.
 */
export function LiveVerify({ onResult }: { onResult: (status: ZKStatus, data: ZKProofData | null) => void }) {
  const [busy, setBusy] = useState<'proof' | 'flip' | null>(null);
  const [last, setLast] = useState<string | null>(null);

  const run = async (flip: boolean) => {
    setBusy(flip ? 'flip' : 'proof');
    try {
      let proofHex = await fetchHex(PROOF);
      const publicInputsHex = await fetchHex(INPUTS);
      let note = '';
      if (flip) {
        // One byte in the middle of the proof, XOR 0x01: same length, so only the cryptography can catch it.
        const at = Math.floor(proofHex.length / 4) * 2;
        const b = (parseInt(proofHex.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, '0');
        proofHex = proofHex.slice(0, at) + b + proofHex.slice(at + 2);
        note = `1 byte flipped at offset ${at / 2} of ${proofHex.length / 2}. `;
      }
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proofHex, publicInputsHex, useEvmTarget: true }),
      });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error(`The gateway's answer was not JSON (HTTP ${res.status})`);
      if (data.success && data.valid) {
        onResult('verified', {
          proofHex,
          publicInputsHex,
          durationMs: data.durationMs,
          extractedPublicInputs: data.extractedPublicInputs,
          verifiedAt: new Date().toLocaleTimeString(),
          releaseNote: 'this hosted page only verifies. Releasing needs the owner device and, on the PayPal rail, sandbox keys.',
        });
        setLast(`Verified by the live gateway in ${data.durationMs} ms.`);
      } else {
        const reason = data.error || (data.success ? 'bb verify rejected the proof' : `HTTP ${res.status}`);
        onResult('rejected', { rejectionReason: `${note}${reason}` });
        setLast(`${note}Rejected by the live gateway.`);
      }
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      onResult('rejected', { rejectionReason: `Could not reach the gateway: ${message}` });
      setLast(null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="cx-panel p-5 sm:p-7 h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center h-7 px-3 rounded-[7px] bg-sun text-sun-ink text-[13px] font-medium">
          Live verify
        </span>
        <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-cobalt-700 text-white/75 text-[13px] mono">
          <BadgeCheck className="w-3.5 h-3.5" aria-hidden="true" />
          bb verify · hosted gateway
        </span>
      </div>

      <h2 className="mt-4 text-[28px] sm:text-[34px] leading-[1.05] font-medium tracking-tightest">
        Check a real proof
      </h2>
      <p className="mt-3 text-[15px] leading-relaxed text-white/70 max-w-[52ch]">
        The committed proof of a 300-cent payment (<span className="mono text-[13.5px]">contracts/test/fixtures/base</span>)
        goes to the live gateway, which runs bb verify against its own key. Flip one byte and the same gateway
        rejects it. The walk test and the tags need the owner device, so they don&rsquo;t run on this page.
      </p>

      <div className="mt-auto pt-5 flex flex-wrap gap-2">
        <button type="button" className="btn btn-accent w-full sm:w-auto" disabled={busy !== null} onClick={() => run(false)}>
          {busy === 'proof' ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
          <span>Verify the committed proof</span>
        </button>
        <button type="button" className="btn btn-ghost-light w-full sm:w-auto" disabled={busy !== null} onClick={() => run(true)}>
          {busy === 'flip' ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : <ShieldX aria-hidden="true" />}
          <span>Flip one byte and verify</span>
        </button>
      </div>
      {last && (
        <p className="mt-3 text-[13px] text-white/60" role="status">
          {last}
        </p>
      )}
    </div>
  );
}
