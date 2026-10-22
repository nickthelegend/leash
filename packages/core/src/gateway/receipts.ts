import fs from 'fs';
import path from 'path';
import { keccak256Hex } from '../crypto/evm.js';
import { leashHome } from '../util/paths.js';

/**
 * A payment receipt: everything needed to re-check a release later without trusting the gateway's
 * word. The proof bytes live next to it (proofs/<proofKeccak>.json) so `scripts/verify-receipt.ts`
 * can re-run bb verify; the PayPal ids let it fetch the order and compare custom_id.
 */
export interface Receipt {
  policyId: string;
  nonce: string;
  amountCents: number;
  merchantIdHash: string;
  recipient: string;
  epoch: number;
  newSpendCommit: string;
  /** keccak256 of the raw proof bytes */
  proofKeccak: string;
  /** vk_hash of the key the proof was verified with */
  vkHash: string;
  /** 'default' (bb verify off-chain) or 'evm' (keccak transcript, LeashPayment) */
  proofTarget: 'default' | 'evm';
  rail: 'paypal' | 'evm';
  /**
   * PENDING: the gateway consumed the nonce and is calling PayPal right now (until leaseUntil).
   * CAPTURE_PENDING: PayPal accepted the capture for the proven amount but holds it (not paid yet).
   * FORWARDED: the leash-mcp proxy forwarded a proven call upstream that reported no order status.
   */
  status: 'PENDING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'CAPTURE_PENDING' | 'FAILED' | 'FORWARDED';
  /** PENDING only: after this time a crashed attempt counts as stale and the same proof may retry. */
  leaseUntil?: string;
  paypalOrderId?: string;
  captureId?: string;
  /** keccak256(abi.encode(policyId, nonce)), sent to PayPal as purchase_units[0].custom_id */
  custom_id?: string;
  approveUrl?: string;
  /**
   * leash-mcp proxy only: true once PayPal reported purchase_units[0].payee.merchant_id equal to the
   * allowlisted merchant and purchase_units[0].amount equal to the proven cents in USD (in the
   * create_order or a get_order response). pay_order re-reads the order with get_order before every
   * capture regardless.
   */
  payeeVerified?: boolean;
  txHash?: string;
  error?: string;
  ts: string;
}

export interface StoredProof {
  proofHex: string;
  publicInputsHex: string;
  proofTarget: 'default' | 'evm';
}

/** Write to <file>.<pid>.tmp, then rename over <file>: readers see the old or the new content, never half. */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function proofKeccak(proofHex: string): string {
  return keccak256Hex(proofHex);
}

/**
 * Append-only JSONL receipt log (<LEASH_HOME>/receipts.jsonl). Each update appends the full receipt;
 * the last line for a (policyId, nonce) wins. Survives restarts, replacing the old in-memory nonce
 * store, and keeps nonces per policy.
 *
 * Several processes share one log (the Express gateway and the Next console use the same LEASH_HOME),
 * so the in-memory index is rebuilt whenever the file's size or mtime changed since it was read. A line
 * that is not valid JSON (a write torn by a crash) is skipped with a warning and reported by
 * corruptLines() instead of making every read throw; the next append starts on a fresh line.
 */
export class ReceiptStore {
  private cache: Map<string, Receipt> | null = null;
  private stamp: { size: number; mtimeMs: number } | null = null;
  private bad: number[] = [];
  private warned = new Set<number>();

  constructor(private readonly dir: string = leashHome()) {
    fs.mkdirSync(path.join(dir, 'proofs'), { recursive: true });
  }

  get file(): string {
    return path.join(this.dir, 'receipts.jsonl');
  }

  private static key(policyId: string, nonce: string): string {
    return `${policyId.toLowerCase()}:${nonce}`;
  }

  private load(): Map<string, Receipt> {
    const st = fs.existsSync(this.file) ? fs.statSync(this.file) : undefined;
    if (this.cache && this.stamp && st && st.size === this.stamp.size && st.mtimeMs === this.stamp.mtimeMs) return this.cache;
    if (this.cache && !st && !this.stamp) return this.cache;
    const map = new Map<string, Receipt>();
    const bad: number[] = [];
    if (st) {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        let r: Receipt;
        try {
          r = JSON.parse(line) as Receipt;
        } catch {
          bad.push(i + 1);
          if (!this.warned.has(i + 1)) {
            this.warned.add(i + 1);
            console.warn(`[leash] ${this.file} line ${i + 1} is not valid JSON (a torn write?); skipped`);
          }
          return;
        }
        map.set(ReceiptStore.key(r.policyId, r.nonce), r);
      });
    }
    this.cache = map;
    this.bad = bad;
    this.stamp = st ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    return map;
  }

  /** 1-based line numbers of receipts.jsonl that could not be parsed (skipped). */
  corruptLines(): number[] {
    this.load();
    return [...this.bad];
  }

  isNonceUsed(policyId: string, nonce: string): boolean {
    return this.load().has(ReceiptStore.key(policyId, nonce));
  }

  get(policyId: string, nonce: string): Receipt | undefined {
    return this.load().get(ReceiptStore.key(policyId, nonce));
  }

  /** All receipts for a nonce across policies (a nonce is only unique per policy). */
  byNonce(nonce: string): Receipt[] {
    return [...this.load().values()].filter((r) => r.nonce === nonce);
  }

  byOrderId(orderId: string): Receipt | undefined {
    return [...this.load().values()].find((r) => r.paypalOrderId === orderId);
  }

  list(): Receipt[] {
    return [...this.load().values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  put(r: Receipt): Receipt {
    const map = this.load();
    map.set(ReceiptStore.key(r.policyId, r.nonce), r);
    // After a torn last line, start on a new line so this receipt isn't glued to the fragment.
    fs.appendFileSync(this.file, (this.endsWithoutNewline() ? '\n' : '') + JSON.stringify(r) + '\n', { mode: 0o600 });
    this.stamp = null; // re-read on next access: another process may have appended too
    return r;
  }

  private endsWithoutNewline(): boolean {
    if (!fs.existsSync(this.file)) return false;
    const { size } = fs.statSync(this.file);
    if (size === 0) return false;
    const fd = fs.openSync(this.file, 'r');
    try {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      return b[0] !== 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  saveProof(p: StoredProof): string {
    const k = proofKeccak(p.proofHex);
    writeFileAtomic(path.join(this.dir, 'proofs', `${k}.json`), JSON.stringify(p));
    return k;
  }

  loadProof(keccak: string): StoredProof | undefined {
    const f = path.join(this.dir, 'proofs', `${keccak.toLowerCase()}.json`);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as StoredProof) : undefined;
  }
}
