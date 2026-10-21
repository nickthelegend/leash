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
  status: 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED';
  paypalOrderId?: string;
  captureId?: string;
  /** keccak256(abi.encode(policyId, nonce)), sent to PayPal as purchase_units[0].custom_id */
  custom_id?: string;
  approveUrl?: string;
  txHash?: string;
  error?: string;
  ts: string;
}

export interface StoredProof {
  proofHex: string;
  publicInputsHex: string;
  proofTarget: 'default' | 'evm';
}

export function proofKeccak(proofHex: string): string {
  return keccak256Hex(proofHex);
}

/**
 * Append-only JSONL receipt log (<LEASH_HOME>/receipts.jsonl). Each update appends the full receipt;
 * the last line for a (policyId, nonce) wins. Survives restarts, replacing the old in-memory nonce
 * store, and keeps nonces per policy.
 */
export class ReceiptStore {
  private cache: Map<string, Receipt> | null = null;

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
    if (this.cache) return this.cache;
    const map = new Map<string, Receipt>();
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as Receipt;
        map.set(ReceiptStore.key(r.policyId, r.nonce), r);
      }
    }
    this.cache = map;
    return map;
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
    fs.appendFileSync(this.file, JSON.stringify(r) + '\n', { mode: 0o600 });
    return r;
  }

  saveProof(p: StoredProof): string {
    const k = proofKeccak(p.proofHex);
    fs.writeFileSync(path.join(this.dir, 'proofs', `${k}.json`), JSON.stringify(p));
    return k;
  }

  loadProof(keccak: string): StoredProof | undefined {
    const f = path.join(this.dir, 'proofs', `${keccak.toLowerCase()}.json`);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as StoredProof) : undefined;
  }
}
