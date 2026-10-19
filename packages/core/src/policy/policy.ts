import crypto from 'crypto';
import {
  computePolicyBundle,
  getMerklePath,
  merchantNameToField,
  MerklePath,
  PolicyBundle,
} from '../crypto/hasher.js';

export interface MerchantLeaf {
  name: string;
  field: string;
  hash: string;
  leafIndex: number;
}

export interface SpendingPolicy {
  id: string;
  name: string;
  maxPerTxCents: number; // e.g. 500 = $5.00
  merchants: string[];
  policySalt: string;
  policyCommitment: string;
  merkleRoot: string;
  merchantLeaves: MerchantLeaf[];
  leavesBigInt: string[];
  bundle: PolicyBundle;
  createdAt: string;
}

export function createSpendingPolicy(
  name: string,
  maxPerTxCents: number,
  merchants: string[],
  customSalt?: string
): SpendingPolicy {
  if (!merchants || merchants.length === 0) {
    throw new Error('Policy must contain at least one allowlisted merchant.');
  }
  if (merchants.length > 16) {
    throw new Error('LEASH stateless MVP supports up to 16 allowlisted merchants per tree.');
  }
  if (maxPerTxCents <= 0) {
    throw new Error('maxPerTxCents must be greater than zero.');
  }

  // Deduplicate and normalize merchant names
  const uniqueMerchants = Array.from(
    new Set(merchants.map((m) => m.trim().toLowerCase()))
  ).filter((m) => m.length > 0);

  // Generate 16 leaves (filled with merchant fields, remaining padded with 0)
  const leaves: bigint[] = [];
  const merchantLeaves: MerchantLeaf[] = [];

  for (let i = 0; i < 16; i++) {
    if (i < uniqueMerchants.length) {
      const mName = uniqueMerchants[i];
      const fieldVal = merchantNameToField(mName);
      leaves.push(fieldVal);
      merchantLeaves.push({
        name: mName,
        field: fieldVal.toString(),
        hash: '', // will be filled from bundle
        leafIndex: i,
      });
    } else {
      leaves.push(0n);
    }
  }

  const saltBigInt = customSalt
    ? BigInt(customSalt)
    : BigInt(`0x${crypto.randomBytes(16).toString('hex')}`);

  const bundle = computePolicyBundle(leaves, maxPerTxCents, saltBigInt);

  // Fill merchant hash from bundle
  for (const m of merchantLeaves) {
    m.hash = bundle.merchant_hashes[m.leafIndex];
  }

  const id = `pol_${crypto.randomBytes(8).toString('hex')}`;

  return {
    id,
    name,
    maxPerTxCents,
    merchants: uniqueMerchants,
    policySalt: saltBigInt.toString(),
    policyCommitment: bundle.policy_commitment,
    merkleRoot: bundle.merkle_root,
    merchantLeaves,
    leavesBigInt: leaves.map((l) => l.toString()),
    bundle,
    createdAt: new Date().toISOString(),
  };
}

export function getMerchantProof(
  policy: SpendingPolicy,
  merchantName: string
): MerklePath {
  const normalized = merchantName.trim().toLowerCase();
  const found = policy.merchantLeaves.find((m) => m.name === normalized);

  if (!found) {
    throw new Error(
      `Merchant '${merchantName}' is NOT in the allowlist for policy '${policy.name}' (${policy.policyCommitment})`
    );
  }

  const leaves = policy.leavesBigInt.map((l) => BigInt(l));
  return getMerklePath(found.leafIndex, leaves, policy.bundle);
}

let cachedDefaultPolicy: SpendingPolicy | null = null;

/**
 * Standard preset policy for the judge demo.
 * Merchants: OpenAI, Anthropic, GitHub, AWS, DigitalOcean, PayPal, Vercel, Supabase
 * Cap: $5.00 (500 cents)
 */
export function getDefaultPolicy(): SpendingPolicy {
  if (!cachedDefaultPolicy) {
    cachedDefaultPolicy = createSpendingPolicy(
      'AI Agent Production Leash',
      500, // $5.00
      [
        'openai',
        'anthropic',
        'github',
        'aws',
        'digitalocean',
        'paypal',
        'vercel',
        'supabase',
      ],
      '987654321'
    );
  }
  return cachedDefaultPolicy;
}
