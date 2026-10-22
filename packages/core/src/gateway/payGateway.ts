import fs from 'fs';
import path from 'path';
import { recoverEip191Signer } from '../crypto/eip191.js';
import { isAddress, paypalPayee, PAYPAL_MERCHANT_ID_RE, policyIdOf } from '../crypto/evm.js';
import { leashCustomId, PayPalCapturePending, PayPalService, PayPalSetupRequired, paypalService } from '../paypal/paypal.js';
import { currentEpoch } from '../spend/spendState.js';
import { leashHome } from '../util/paths.js';
import { decodePublicInputs, DecodedPublicInputs, resolveCircuitsDir, verifyPaymentProof } from '../verifier/verifier.js';
import { proofKeccak, Receipt, ReceiptStore, withFileLock, writeFileAtomic } from './receipts.js';

/**
 * The verify-only payment gateway. It never sees a policy's rules or salts: it holds the public
 * registration (owner, commitment, approval threshold, optional PayPal vault id), the latest spend
 * commitment per policy (the same check LeashPayment does on chain), and receipts.
 */
export interface GatewayPolicy {
  policyId: string;
  owner: string;
  policyCommitment: string;
  /** Payments above this many cents wait for the buyer to approve the PayPal order. */
  approvalThresholdCents: number;
  /** PayPal Vault v3 payment token the owner approved once; enables agent-mode capture. */
  vaultId?: string;
  /** Registration version: every change needs a higher one, so an old signed registration can't be replayed. */
  version: number;
  createdAt: string;
  /**
   * Set on the console's throwaway example policies (a fresh one per page load). Pruned once older
   * than a day if they never got a receipt, a spend commitment or a vault id.
   */
  ephemeral?: true;
}

/** How long an unused console (ephemeral) registration is kept. */
export const EPHEMERAL_TTL_MS = 86_400_000;

export interface RegistrationInput {
  owner: string;
  policyCommitment: string;
  approvalThresholdCents?: number;
  vaultId?: string;
}

/**
 * The exact text the owner signs (EIP-191 personal_sign) to register a policy or change its approval
 * threshold or vault id at a gateway. It names the policyId (owner + commitment), every field the
 * registration sets, and a version that must increase with each change.
 */
export function registrationMessage(r: { policyId: string; approvalThresholdCents: number; vaultId?: string; version: number }): string {
  return [
    'LEASH gateway registration',
    `policyId: ${r.policyId.toLowerCase()}`,
    `approvalThresholdCents: ${r.approvalThresholdCents}`,
    `vaultId: ${r.vaultId ?? 'none'}`,
    `version: ${r.version}`,
  ].join('\n');
}

interface SpendRecord {
  epoch: number;
  commit: string;
}

export class GatewayError extends Error {
  constructor(public readonly status: number, message: string, public readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GatewayError';
  }
}

export function vkHash(target: 'default' | 'evm'): string {
  const f = path.join(resolveCircuitsDir(), 'target', target === 'evm' ? 'vk_evm' : 'vk', 'vk_hash');
  return fs.existsSync(f) ? `0x${fs.readFileSync(f).toString('hex')}` : 'missing';
}

const ZERO = `0x${'0'.repeat(64)}`;

export class PayGateway {
  readonly dir: string;
  readonly receipts: ReceiptStore;

  constructor(opts?: { dir?: string; paypal?: PayPalService }) {
    this.dir = opts?.dir ?? path.join(leashHome(), 'gateway');
    fs.mkdirSync(this.dir, { recursive: true });
    this.receipts = new ReceiptStore(this.dir);
    this.paypal = opts?.paypal ?? paypalService;
  }

  private readonly paypal: PayPalService;

  private readJson<T>(name: string, fallback: T): T {
    const f = path.join(this.dir, name);
    if (!fs.existsSync(f)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
    } catch (e) {
      // Fail closed (an unreadable spend.json must not reset the daily cap); writes are atomic, so this
      // only happens if the file was damaged outside LEASH.
      throw new GatewayError(500, `${f} is not valid JSON (${(e as Error).message}); restore it before the gateway can continue`);
    }
  }

  /** Atomic (temp file + rename): the Express gateway and the console share this directory. */
  private writeJson(name: string, value: unknown): void {
    writeFileAtomic(path.join(this.dir, name), JSON.stringify(value, null, 2));
  }

  /**
   * Read-modify-write of one JSON file under its lock: `fn` gets the current content (re-read inside
   * the lock) and changes it in place, so concurrent writers in other processes never lose each
   * other's entries.
   */
  private updateJson<T extends object, R>(name: string, fn: (all: T) => R): R {
    return withFileLock(path.join(this.dir, name), () => {
      const all = this.readJson<T>(name, {} as T);
      const out = fn(all);
      this.writeJson(name, all);
      return out;
    });
  }

  policies(): GatewayPolicy[] {
    return Object.values(this.readJson<Record<string, GatewayPolicy>>('policies.json', {}));
  }

  policy(policyId: string): GatewayPolicy | undefined {
    return this.readJson<Record<string, GatewayPolicy>>('policies.json', {})[policyId.toLowerCase()];
  }

  /**
   * Register (or change the threshold / vault id of) a policy. The approval threshold decides whether
   * a vaulted PayPal wallet is charged without the buyer, so a change must come from the owner:
   *  - over the network: `signature` is the owner's EIP-191 signature of registrationMessage(...) and
   *    `version` is higher than the stored one (replays of an older registration are refused);
   *  - in-process on the owner device (the console's own routes): `{ trustedOwnerDevice: true }`.
   * Without either it throws 401. On chain, registration is bound to msg.sender instead.
   * `ephemeral` (owner device only) marks a console example policy; registering one also prunes
   * ephemeral registrations older than EPHEMERAL_TTL_MS with no receipt, spend commitment or vault id.
   */
  register(
    input: RegistrationInput & { signature?: string; version?: number },
    opts: { trustedOwnerDevice?: boolean; ephemeral?: boolean } = {}
  ): GatewayPolicy {
    if (opts.ephemeral && !opts.trustedOwnerDevice) throw new GatewayError(400, 'ephemeral registrations are for the owner device only');
    if (!isAddress(input.owner)) throw new GatewayError(400, 'owner must be a 0x-prefixed 20-byte address');
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.policyCommitment)) throw new GatewayError(400, 'policyCommitment must be 0x + 64 hex');
    const threshold = input.approvalThresholdCents ?? 0;
    if (!Number.isInteger(threshold) || threshold < 0) throw new GatewayError(400, 'approvalThresholdCents must be a non-negative integer');
    if (input.vaultId !== undefined && !/^[0-9a-zA-Z_-]{1,255}$/.test(input.vaultId)) throw new GatewayError(400, 'vaultId must match ^[0-9a-zA-Z_-]{1,255}$');
    const policyId = policyIdOf(input.owner, input.policyCommitment);
    return this.updateJson<Record<string, GatewayPolicy>, GatewayPolicy>('policies.json', (all) => {
      if (opts.ephemeral) this.pruneEphemeral(all);
      return this.applyRegistration(all, policyId, input, threshold, opts);
    });
  }

  /** Drop stale, unused console registrations (see GatewayPolicy.ephemeral) from `all` in place. */
  private pruneEphemeral(all: Record<string, GatewayPolicy>): void {
    const cutoff = Date.now() - EPHEMERAL_TTL_MS;
    const stale = Object.values(all).filter((p) => p.ephemeral && !p.vaultId && Date.parse(p.createdAt) < cutoff);
    if (!stale.length) return;
    const used = new Set(this.receipts.list().map((r) => r.policyId.toLowerCase()));
    const spend = this.readJson<Record<string, SpendRecord>>('spend.json', {});
    for (const p of stale) if (!used.has(p.policyId) && !spend[p.policyId]) delete all[p.policyId];
  }

  /** register()'s check-and-set, run on policies.json as read inside its lock. */
  private applyRegistration(
    all: Record<string, GatewayPolicy>,
    policyId: string,
    input: RegistrationInput & { signature?: string; version?: number },
    threshold: number,
    opts: { trustedOwnerDevice?: boolean; ephemeral?: boolean }
  ): GatewayPolicy {
    const prev = all[policyId];
    const vaultId = input.vaultId ?? prev?.vaultId;
    const prevVersion = prev?.version ?? 0;
    let version: number;
    if (opts.trustedOwnerDevice) {
      version = prevVersion + 1;
    } else {
      if (!input.signature) {
        throw new GatewayError(401, 'Owner signature required: sign registrationMessage(...) with the owner key (EIP-191)', {
          message: registrationMessage({ policyId, approvalThresholdCents: threshold, vaultId, version: prevVersion + 1 }),
        });
      }
      version = Number(input.version);
      if (!Number.isInteger(version) || version <= prevVersion) {
        throw new GatewayError(409, `version must be an integer above ${prevVersion} (the stored registration)`, { currentVersion: prevVersion });
      }
      let signer: string;
      try {
        signer = recoverEip191Signer(registrationMessage({ policyId, approvalThresholdCents: threshold, vaultId, version }), input.signature);
      } catch (e) {
        throw new GatewayError(400, `Bad signature: ${(e as Error).message}`);
      }
      if (signer !== input.owner.toLowerCase()) {
        throw new GatewayError(401, 'Signature is not from the policy owner');
      }
    }
    all[policyId] = {
      policyId,
      owner: input.owner.toLowerCase(),
      policyCommitment: input.policyCommitment.toLowerCase(),
      approvalThresholdCents: threshold,
      vaultId,
      version,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      // Only an ephemeral registration keeps the flag; any other change (e.g. a vault id) makes it permanent.
      ...(opts.ephemeral ? { ephemeral: true as const } : {}),
    };
    return all[policyId];
  }

  spendState(policyId: string): SpendRecord | undefined {
    return this.readJson<Record<string, SpendRecord>>('spend.json', {})[policyId.toLowerCase()];
  }

  /** Same rule as LeashPayment._checkSpend: today only; prev must be the stored commit, or 0 on a new day. */
  private checkSpend(policyId: string, pi: DecodedPublicInputs, nowMs: number): void {
    const today = currentEpoch(nowMs);
    if (Number(pi.epoch) !== today) throw new GatewayError(400, `Wrong epoch: proof is for day ${pi.epoch}, today is ${today}`);
    const s = this.spendState(policyId);
    if (s && s.epoch === today && s.commit !== ZERO) {
      if (pi.prev_spend_commit !== s.commit) throw new GatewayError(409, 'Stale spend commitment: another payment landed first');
    } else if (pi.prev_spend_commit !== ZERO) {
      throw new GatewayError(409, 'New epoch must start from zero');
    }
  }

  private advanceSpend(policyId: string, pi: DecodedPublicInputs): void {
    this.updateJson<Record<string, SpendRecord>, void>('spend.json', (all) => {
      all[policyId] = { epoch: Number(pi.epoch), commit: pi.new_spend_commit };
    });
  }

  /**
   * Verify a proof and release it through PayPal. Everything the gateway needs comes from the proof's
   * public inputs; the caller only names the owner and the PayPal merchant id behind the proven payee.
   *
   * Order matters: registration, nonce, spend chain, bb verify, PayPal configured, payee, and a PayPal
   * OAuth token (so wrong credentials or an unreachable PayPal cost the agent nothing) all come before
   * anything is consumed. The nonce and spend checks then run again, synchronously, right before the
   * nonce and spend commitment are consumed (no await in between), so two concurrent requests can't
   * both pass. Consuming writes a PENDING receipt with a lease: while it is live, a resubmission of
   * the same proof is refused with 409 "in flight" (in this process or another one sharing the
   * directory). Only the order create/capture call can fail after consumption; that leaves a FAILED
   * receipt, and resubmitting the same proof retries it (same PayPal-Request-Id, so PayPal does not
   * create a second order) instead of being refused as a used nonce; so does a PENDING whose lease
   * ran out (the process died mid-call). A settled receipt (AWAITING_APPROVAL, COMPLETED,
   * CAPTURE_PENDING) is never downgraded. A vault capture PayPal holds as PENDING is CAPTURE_PENDING.
   */
  async pay(input: {
    owner: string;
    proofHex: string;
    publicInputsHex: string;
    paypalMerchantId: string;
    returnUrl: string;
    cancelUrl: string;
    nowMs?: number;
  }): Promise<Receipt> {
    if (!isAddress(input.owner)) throw new GatewayError(400, 'owner must be the 0x address that owns the policy');
    if (!input.proofHex || !input.publicInputsHex) throw new GatewayError(400, 'proofHex and publicInputsHex are required');
    let pi: DecodedPublicInputs;
    try {
      pi = decodePublicInputs(Buffer.from(input.publicInputsHex.replace(/^0x/, ''), 'hex'));
    } catch (e: any) {
      throw new GatewayError(400, e.message);
    }
    const policyId = policyIdOf(input.owner, pi.policy_commitment);
    const reg = this.policy(policyId);
    if (!reg) throw new GatewayError(404, 'Policy not registered at this gateway (owner, commitment)');
    const pk = proofKeccak(input.proofHex);
    const nowMs = input.nowMs ?? Date.now();
    // A FAILED receipt for this exact proof is a retry: its nonce and spend were consumed by the
    // earlier attempt, so only the PayPal step runs again.
    const retry = this.isRetry(policyId, pi.nonce, pk);
    const checkNonceAndSpend = () => {
      const current = this.receipts.get(policyId, pi.nonce);
      if (current && this.inFlight(current)) throw new GatewayError(409, 'Payment for this nonce is in flight', { nonce: pi.nonce, status: current.status });
      if (retry) {
        if (!this.isRetry(policyId, pi.nonce, pk)) throw new GatewayError(409, 'Nonce already used for this policy', { nonce: pi.nonce });
        if (Number(pi.epoch) !== currentEpoch(nowMs)) throw new GatewayError(400, `Wrong epoch: proof is for day ${pi.epoch}, today is ${currentEpoch(nowMs)}`);
        return;
      }
      const used = this.receipts.get(policyId, pi.nonce);
      if (used) throw new GatewayError(409, 'Nonce already used for this policy', { nonce: pi.nonce, status: used.status });
      this.checkSpend(policyId, pi, nowMs);
    };
    checkNonceAndSpend();

    const verification = verifyPaymentProof({ proofHex: input.proofHex, publicInputsHex: input.publicInputsHex });
    if (!verification.valid) throw new GatewayError(400, `Invalid ZK proof: ${verification.error}`);

    // The proven payee must be this PayPal merchant: recipient == low 160 bits of keccak("leash:paypal:" + id).
    const merchantId = input.paypalMerchantId ?? '';
    const checkPayee = () => {
      if (!PAYPAL_MERCHANT_ID_RE.test(merchantId)) {
        throw new GatewayError(400, 'paypalMerchantId must be the 13-char PayPal merchant id the proof pays');
      }
      if (paypalPayee(merchantId).toLowerCase() !== pi.recipient) {
        throw new GatewayError(403, 'Payee mismatch: the proof pays a different payee than this PayPal merchant id');
      }
    };
    if (merchantId) checkPayee();

    // Refuse before consuming anything if PayPal can't run: the agent keeps its nonce and daily budget.
    const setup = this.paypal.setupStatus();
    if (!setup.configured) {
      throw new GatewayError(503, `Proof verified; nothing consumed. ${setup.message}`, { verified: true, setupRequired: setup.missing });
    }
    checkPayee();
    // Wrong credentials, an unreachable or slow PayPal: also refused before anything is consumed.
    try {
      await this.paypal.getAccessToken();
    } catch (e) {
      if (e instanceof PayPalSetupRequired) throw new GatewayError(503, `Proof verified; nothing consumed. ${e.message}`, { verified: true, setupRequired: e.missing });
      throw new GatewayError(502, `Proof verified; nothing consumed. ${(e as Error).message}`, { verified: true, consumed: false });
    }
    // The await above let other requests run: check the nonce and spend chain again, synchronously.
    checkNonceAndSpend();

    const amountCents = Number(pi.amount);
    const humanApproval = amountCents > reg.approvalThresholdCents || !reg.vaultId;
    const base: Receipt = {
      policyId,
      nonce: pi.nonce,
      amountCents,
      merchantIdHash: pi.merchant_id_hash,
      recipient: pi.recipient,
      epoch: Number(pi.epoch),
      newSpendCommit: pi.new_spend_commit,
      proofKeccak: pk,
      vkHash: vkHash('default'),
      proofTarget: 'default',
      rail: 'paypal',
      status: 'FAILED',
      custom_id: leashCustomId(policyId, pi.nonce),
      ts: new Date().toISOString(),
    };
    // Consume: nonce (PENDING receipt with a lease) + spend commitment, synchronously. A retry consumed them already.
    this.receipts.saveProof({ proofHex: input.proofHex, publicInputsHex: input.publicInputsHex, proofTarget: 'default' });
    this.receipts.put({
      ...base,
      status: 'PENDING',
      leaseUntil: new Date(Date.now() + this.leaseMs()).toISOString(),
      error: retry ? 'PayPal order pending (retry)' : 'PayPal order pending',
    });
    if (!retry) this.advanceSpend(policyId, pi);

    const proven = { policyId, nonce: pi.nonce, amountCents, payeeMerchantId: input.paypalMerchantId };
    try {
      if (humanApproval) {
        const order = await this.paypal.createOrder(proven, { kind: 'human', returnUrl: input.returnUrl, cancelUrl: input.cancelUrl });
        return this.settle({ ...base, status: 'AWAITING_APPROVAL', paypalOrderId: order.orderId, approveUrl: order.approveUrl, ts: new Date().toISOString() });
      }
      const order = await this.paypal.createOrder(proven, { kind: 'vault', vaultId: reg.vaultId! });
      return this.settle({ ...base, status: 'COMPLETED', paypalOrderId: order.orderId, captureId: order.capture!.captureId, ts: new Date().toISOString() });
    } catch (e: any) {
      if (e instanceof PayPalCapturePending) {
        return this.settle({ ...base, status: 'CAPTURE_PENDING', paypalOrderId: e.orderId, captureId: e.captureId, error: e.message, ts: new Date().toISOString() });
      }
      return this.settle({ ...base, status: 'FAILED', error: e.message, ts: new Date().toISOString() });
    }
  }

  /** How long a PENDING receipt blocks resubmissions: comfortably longer than the PayPal calls can take. */
  private leaseMs(): number {
    return Math.max(60_000, 4 * this.paypal.timeoutMs);
  }

  /** A PENDING receipt whose lease has not run out: another attempt is talking to PayPal right now. */
  private inFlight(r: Receipt): boolean {
    return r.status === 'PENDING' && Date.parse(r.leaseUntil ?? '') > Date.now();
  }

  /**
   * Compare-and-set for the outcome of a PayPal call: a receipt that is already settled
   * (AWAITING_APPROVAL, COMPLETED, CAPTURE_PENDING) for this nonce is never downgraded to FAILED and
   * never replaced by another attempt's order; the stored one is returned instead.
   */
  private settle(next: Receipt): Receipt {
    const current = this.receipts.get(next.policyId, next.nonce);
    const settled = current && (current.status === 'COMPLETED' || current.status === 'CAPTURE_PENDING' || current.status === 'AWAITING_APPROVAL');
    if (settled && !(current!.status === 'AWAITING_APPROVAL' && next.status === 'COMPLETED' && next.paypalOrderId === current!.paypalOrderId)) {
      return current!;
    }
    return this.receipts.put({ ...next, leaseUntil: undefined });
  }

  /**
   * True when (policyId, nonce) has a receipt made from this same proof (keccak of the bytes) that may
   * be retried: FAILED, or PENDING whose lease ran out.
   */
  private isRetry(policyId: string, nonce: string, proofKeccakHex: string): boolean {
    const r = this.receipts.get(policyId, nonce);
    if (!r || r.proofKeccak !== proofKeccakHex) return false;
    return r.status === 'FAILED' || (r.status === 'PENDING' && !this.inFlight(r));
  }

  /** Capture an approved order. COMPLETED only if PayPal reports COMPLETED for exactly the proven cents. */
  async capture(policyId: string, nonce: string): Promise<Receipt> {
    const r = this.receipts.get(policyId, nonce);
    if (!r) throw new GatewayError(404, 'No receipt for that policy and nonce');
    if (r.status === 'COMPLETED' || r.status === 'CAPTURE_PENDING') return r;
    if (r.status !== 'AWAITING_APPROVAL' || !r.paypalOrderId) throw new GatewayError(409, `Receipt is ${r.status}; nothing to capture`);
    try {
      const cap = await this.paypal.captureOrder(r.paypalOrderId, { policyId, nonce, amountCents: r.amountCents });
      return this.receipts.put({ ...r, status: 'COMPLETED', captureId: cap.captureId, error: undefined, ts: new Date().toISOString() });
    } catch (e: any) {
      if (e instanceof PayPalCapturePending) {
        return this.receipts.put({ ...r, status: 'CAPTURE_PENDING', captureId: e.captureId, error: e.message, ts: new Date().toISOString() });
      }
      if (e instanceof PayPalSetupRequired) throw new GatewayError(503, e.message);
      // Leave it awaiting approval (the buyer may not have approved yet); report why.
      throw new GatewayError(502, `Capture failed: ${e.message}`);
    }
  }
}

let shared: PayGateway | null = null;
export function sharedGateway(): PayGateway {
  shared ??= new PayGateway();
  return shared;
}
