import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isAddress, paypalPayee, PAYPAL_MERCHANT_ID_RE } from '../crypto/evm.js';
import { computePolicyBundle, getMerklePath, merchantNameToField, MerklePath, PolicyBundle } from '../crypto/hasher.js';
import { leashHome } from '../util/paths.js';

/**
 * An allowlist entry: a merchant and the one payee it may be paid at. The payee is bound into the
 * leaf, so a proof for this merchant can only name this payee as the recipient.
 *   - EVM payee:    { name, payee: '0x…' }
 *   - PayPal payee: { name, paypalMerchantId: 'ABCDEFGHJKLMN' }  (payee = paypalPayee(merchantId))
 */
export interface MerchantEntry {
  name: string;
  payee?: string;
  paypalMerchantId?: string;
}

export interface MerchantLeaf {
  name: string;
  field: string;
  /** the 160-bit payee bound in the leaf (EVM address or paypalPayee(merchantId)) */
  payee: string;
  paypalMerchantId?: string;
  /** salted merchant hash: pedersen(merchant_id, policy_salt) */
  hash: string;
  leafIndex: number;
}

export interface SpendingPolicy {
  id: string;
  name: string;
  maxPerTxCents: number; // 500 = $5.00
  dailyCapCents: number;
  merchants: string[];
  policySalt: string;
  spendSalt: string;
  policyCommitment: string;
  merkleRoot: string;
  merchantLeaves: MerchantLeaf[];
  merchantIds: string[];
  bundle: PolicyBundle;
  createdAt: string;
}

/** The public face of a policy: what a gateway or explorer may see. */
export interface PublicPolicy {
  id: string;
  name: string;
  policyCommitment: string;
  createdAt: string;
}

export function publicPolicy(p: SpendingPolicy): PublicPolicy {
  return { id: p.id, name: p.name, policyCommitment: p.policyCommitment, createdAt: p.createdAt };
}

/**
 * Payees for the console's well-known merchants: Anvil dev accounts #1, #3..#8 (Anvil #2 plays the
 * attacker in the demo). Real deployments list their own payees.
 */
export const DEFAULT_PAYEES: Record<string, string> = {
  openai: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  anthropic: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  github: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  aws: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  digitalocean: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  vercel: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
  supabase: '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
};

const randomField = () => BigInt(`0x${crypto.randomBytes(16).toString('hex')}`);

function resolveEntry(m: string | MerchantEntry): Required<Pick<MerchantEntry, 'name'>> & { payee: string; paypalMerchantId?: string } {
  const entry: MerchantEntry = typeof m === 'string' ? { name: m } : m;
  const name = entry.name.trim().toLowerCase();
  if (!name) throw new Error('Merchant name must be non-empty');
  if (entry.paypalMerchantId) {
    if (!PAYPAL_MERCHANT_ID_RE.test(entry.paypalMerchantId)) {
      throw new Error(`Merchant '${name}': invalid PayPal merchant id '${entry.paypalMerchantId}'`);
    }
    return { name, payee: paypalPayee(entry.paypalMerchantId), paypalMerchantId: entry.paypalMerchantId };
  }
  const payee = entry.payee ?? DEFAULT_PAYEES[name];
  if (!isAddress(payee)) {
    throw new Error(`Merchant '${name}' has no payee: give an EVM address (payee) or a PayPal merchant id (paypalMerchantId)`);
  }
  return { name, payee: payee.toLowerCase() };
}

export interface CreatePolicyOptions {
  name: string;
  maxPerTxCents: number;
  /** rolling per-UTC-day cap; defaults to 3 x maxPerTxCents */
  dailyCapCents?: number;
  merchants: (string | MerchantEntry)[];
  /** explicit salts are for fixtures and the --demo policy only; default is random */
  policySalt?: string;
  spendSalt?: string;
}

export function createSpendingPolicy(opts: CreatePolicyOptions): SpendingPolicy {
  const { name, maxPerTxCents, merchants } = opts;
  if (!merchants || merchants.length === 0) throw new Error('Policy must contain at least one allowlisted merchant.');
  if (!Number.isInteger(maxPerTxCents) || maxPerTxCents <= 0) throw new Error('maxPerTxCents must be a positive integer.');
  const dailyCapCents = opts.dailyCapCents ?? maxPerTxCents * 3;
  if (!Number.isInteger(dailyCapCents) || dailyCapCents <= 0) throw new Error('dailyCapCents must be a positive integer.');

  const seen = new Set<string>();
  const entries = merchants.map(resolveEntry).filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
  if (entries.length > 16) throw new Error('LEASH supports up to 16 allowlisted merchants per tree.');

  const merchantIds: bigint[] = [];
  const payees: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    merchantIds.push(i < entries.length ? merchantNameToField(entries[i].name) : 0n);
    payees.push(i < entries.length ? BigInt(entries[i].payee) : 0n);
  }

  const policySalt = opts.policySalt ? BigInt(opts.policySalt) : randomField();
  const spendSalt = opts.spendSalt ? BigInt(opts.spendSalt) : randomField();
  const bundle = computePolicyBundle({ merchantIds, payees, maxPerTxCents, dailyCapCents, policySalt, spendSalt });

  const merchantLeaves: MerchantLeaf[] = entries.map((e, i) => ({
    name: e.name,
    field: merchantIds[i].toString(),
    payee: e.payee,
    paypalMerchantId: e.paypalMerchantId,
    hash: bundle.merchant_hashes[i],
    leafIndex: i,
  }));

  return {
    id: `pol_${crypto.randomBytes(8).toString('hex')}`,
    name,
    maxPerTxCents,
    dailyCapCents,
    merchants: entries.map((e) => e.name),
    policySalt: policySalt.toString(),
    spendSalt: spendSalt.toString(),
    policyCommitment: bundle.policy_commitment,
    merkleRoot: bundle.merkle_root,
    merchantLeaves,
    merchantIds: merchantIds.map((x) => x.toString()),
    bundle,
    createdAt: new Date().toISOString(),
  };
}

export function findMerchant(policy: SpendingPolicy, merchantName: string): MerchantLeaf | undefined {
  const normalized = merchantName.trim().toLowerCase();
  return policy.merchantLeaves.find((m) => m.name === normalized);
}

export function getMerchantProof(policy: SpendingPolicy, merchantName: string): MerklePath {
  const found = findMerchant(policy, merchantName);
  if (!found) {
    throw new Error(`Merchant '${merchantName}' is NOT in the allowlist for policy '${policy.name}' (${policy.policyCommitment})`);
  }
  return getMerklePath(found.leafIndex, policy.merchantIds.map((l) => BigInt(l)), policy.bundle);
}

/** The demo allowlist: eight merchants with Anvil payees, plus a PayPal merchant when one is configured. */
export function defaultMerchants(): MerchantEntry[] {
  const list: MerchantEntry[] = ['openai', 'anthropic', 'github', 'aws', 'digitalocean', 'vercel', 'supabase'].map((name) => ({ name }));
  const pp = process.env.PAYPAL_PAYEE_MERCHANT_ID;
  if (pp) list.push({ name: 'paypal-sandbox-merchant', paypalMerchantId: pp });
  return list;
}

export const DEMO_POLICY_SALT = '987654321';
export const DEMO_SPEND_SALT = '123456789';

let cachedDefault: { key: string; policy: SpendingPolicy } | null = null;

/**
 * The owner's default policy (cap $5.00 per payment, $15.00 per day; LEASH_DAILY_CAP_CENTS overrides
 * the daily cap).
 *  - default: random salts, created once and kept in <LEASH_HOME>/policy.json (mode 0600) so every
 *    process on the owner device proves against the same commitment.
 *  - demo (`--demo` / LEASH_DEMO=1): the fixed, publicly known salt 987654321. For recordings and
 *    tests only: anyone can brute-force a demo policy's allowlist from its commitment.
 */
export function getDefaultPolicy(opts?: { demo?: boolean }): SpendingPolicy {
  const demo = opts?.demo ?? process.env.LEASH_DEMO === '1';
  const dailyCapCents = Number(process.env.LEASH_DAILY_CAP_CENTS ?? 1500);
  const key = `${demo}:${dailyCapCents}:${process.env.PAYPAL_PAYEE_MERCHANT_ID ?? ''}:${process.env.LEASH_HOME ?? ''}`;
  if (cachedDefault?.key === key) return cachedDefault.policy;

  const base = { name: 'AI Agent Production Leash', maxPerTxCents: 500, dailyCapCents, merchants: defaultMerchants() };
  let policy: SpendingPolicy;
  if (demo) {
    policy = createSpendingPolicy({ ...base, policySalt: DEMO_POLICY_SALT, spendSalt: DEMO_SPEND_SALT });
  } else {
    const file = path.join(leashHome(), 'policy.json');
    const stored = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as SpendingPolicy) : undefined;
    const sameMerchants =
      stored && JSON.stringify(stored.merchants) === JSON.stringify(base.merchants.map((m) => m.name));
    if (stored && sameMerchants && stored.dailyCapCents === dailyCapCents) {
      policy = stored;
    } else {
      policy = createSpendingPolicy(base);
      fs.writeFileSync(file, JSON.stringify(policy, null, 2), { mode: 0o600 });
    }
  }
  cachedDefault = { key, policy };
  return policy;
}
