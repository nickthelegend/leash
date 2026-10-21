import fs from 'fs';
import path from 'path';
import { isAddress, paypalPayee, PAYPAL_MERCHANT_ID_RE, policyIdOf } from '../crypto/evm.js';
import { leashCustomId, PayPalService, PayPalSetupRequired, paypalService } from '../paypal/paypal.js';
import { currentEpoch } from '../spend/spendState.js';
import { leashHome } from '../util/paths.js';
import { decodePublicInputs, DecodedPublicInputs, resolveCircuitsDir, verifyPaymentProof } from '../verifier/verifier.js';
import { proofKeccak, Receipt, ReceiptStore } from './receipts.js';

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
  createdAt: string;
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
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as T) : fallback;
  }

  private writeJson(name: string, value: unknown): void {
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  policies(): GatewayPolicy[] {
    return Object.values(this.readJson<Record<string, GatewayPolicy>>('policies.json', {}));
  }

  policy(policyId: string): GatewayPolicy | undefined {
    return this.readJson<Record<string, GatewayPolicy>>('policies.json', {})[policyId.toLowerCase()];
  }

  /**
   * Register (or update the threshold / vault id of) a policy. Note: this local gateway does not
   * authenticate the owner; on chain, registration is bound to msg.sender.
   */
  register(input: { owner: string; policyCommitment: string; approvalThresholdCents?: number; vaultId?: string }): GatewayPolicy {
    if (!isAddress(input.owner)) throw new GatewayError(400, 'owner must be a 0x-prefixed 20-byte address');
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.policyCommitment)) throw new GatewayError(400, 'policyCommitment must be 0x + 64 hex');
    const threshold = input.approvalThresholdCents ?? 0;
    if (!Number.isInteger(threshold) || threshold < 0) throw new GatewayError(400, 'approvalThresholdCents must be a non-negative integer');
    const policyId = policyIdOf(input.owner, input.policyCommitment);
    const all = this.readJson<Record<string, GatewayPolicy>>('policies.json', {});
    const prev = all[policyId];
    all[policyId] = {
      policyId,
      owner: input.owner.toLowerCase(),
      policyCommitment: input.policyCommitment.toLowerCase(),
      approvalThresholdCents: threshold,
      vaultId: input.vaultId ?? prev?.vaultId,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
    };
    this.writeJson('policies.json', all);
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
    const all = this.readJson<Record<string, SpendRecord>>('spend.json', {});
    all[policyId] = { epoch: Number(pi.epoch), commit: pi.new_spend_commit };
    this.writeJson('spend.json', all);
  }

  /**
   * Verify a proof and release it through PayPal. Everything the gateway needs comes from the proof's
   * public inputs; the caller only names the owner and the PayPal merchant id behind the proven payee.
   *
   * Order matters: all checks (registration, nonce, spend chain, bb verify, PayPal configured, payee)
   * run before anything is consumed.
   * Then the nonce and spend commitment are consumed synchronously (no await in between), so two
   * concurrent requests can't both pass.
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
    if (this.receipts.isNonceUsed(policyId, pi.nonce)) throw new GatewayError(409, 'Nonce already used for this policy', { nonce: pi.nonce });

    this.checkSpend(policyId, pi, input.nowMs ?? Date.now());

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
      proofKeccak: proofKeccak(input.proofHex),
      vkHash: vkHash('default'),
      proofTarget: 'default',
      rail: 'paypal',
      status: 'FAILED',
      custom_id: leashCustomId(policyId, pi.nonce),
      ts: new Date().toISOString(),
    };
    // Consume: nonce (receipt exists) + spend commitment, synchronously.
    this.receipts.saveProof({ proofHex: input.proofHex, publicInputsHex: input.publicInputsHex, proofTarget: 'default' });
    this.receipts.put({ ...base, error: 'PayPal order pending' });
    this.advanceSpend(policyId, pi);

    const proven = { policyId, nonce: pi.nonce, amountCents, payeeMerchantId: input.paypalMerchantId };
    try {
      if (humanApproval) {
        const order = await this.paypal.createOrder(proven, { kind: 'human', returnUrl: input.returnUrl, cancelUrl: input.cancelUrl });
        return this.receipts.put({ ...base, status: 'AWAITING_APPROVAL', paypalOrderId: order.orderId, approveUrl: order.approveUrl, ts: new Date().toISOString() });
      }
      const order = await this.paypal.createOrder(proven, { kind: 'vault', vaultId: reg.vaultId! });
      return this.receipts.put({ ...base, status: 'COMPLETED', paypalOrderId: order.orderId, captureId: order.capture!.captureId, ts: new Date().toISOString() });
    } catch (e: any) {
      return this.receipts.put({ ...base, status: 'FAILED', error: e.message, ts: new Date().toISOString() });
    }
  }

  /** Capture an approved order. COMPLETED only if PayPal reports COMPLETED for exactly the proven cents. */
  async capture(policyId: string, nonce: string): Promise<Receipt> {
    const r = this.receipts.get(policyId, nonce);
    if (!r) throw new GatewayError(404, 'No receipt for that policy and nonce');
    if (r.status === 'COMPLETED') return r;
    if (r.status !== 'AWAITING_APPROVAL' || !r.paypalOrderId) throw new GatewayError(409, `Receipt is ${r.status}; nothing to capture`);
    try {
      const cap = await this.paypal.captureOrder(r.paypalOrderId, { policyId, nonce, amountCents: r.amountCents });
      return this.receipts.put({ ...r, status: 'COMPLETED', captureId: cap.captureId, error: undefined, ts: new Date().toISOString() });
    } catch (e: any) {
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
