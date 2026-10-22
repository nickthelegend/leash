import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { toolPath } from '../util/paths.js';

export const BN254_FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface PolicyBundle {
  merkle_root: string;
  policy_commitment: string;
  /** leaf = pedersen(merchant_id, payee, policy_salt); 0 for empty slots */
  leaves: string[];
  layer1: string[];
  layer2: string[];
  layer3: string[];
  merchant_hashes: string[];
}

export interface MerklePath {
  merchantId: string;
  merchantIdHash: string;
  pathElements: string[];
  pathIndices: boolean[];
}

/**
 * Maps a merchant identifier string into a deterministic BN254 field element.
 */
export function merchantNameToField(merchantName: string): bigint {
  const normalized = merchantName.trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(`leash_merchant:${normalized}`).digest('hex');
  return BigInt(`0x${hash}`) % BN254_FR_MODULUS;
}

/**
 * nargo prints field values without leading zero bytes (0x00ea… comes out as 0xea…). Everything else
 * in LEASH (bb's public_inputs, the gateway, bytes32 on chain) uses 32-byte words, so a commitment or
 * hash that starts with a zero byte must be padded back to 0x + 64 hex.
 */
function field32(hex: string): string {
  return `0x${hex.slice(2).toLowerCase().padStart(64, '0')}`;
}

/** Parses the structured circuit output printed by Noir. Exported for tests. */
export function parsePolicyBundleOutput(output: string): PolicyBundle {
  const match = output.match(/PolicyBundle\s*\{([\s\S]*?)\}/);
  if (!match) {
    throw new Error(`Failed to parse PolicyBundle output from nargo: ${output}`);
  }
  const body = match[1];

  const rootMatch = body.match(/merkle_root:\s*(0x[0-9a-fA-F]+)/);
  const commitmentMatch = body.match(/policy_commitment:\s*(0x[0-9a-fA-F]+)/);
  if (!rootMatch || !commitmentMatch) {
    throw new Error(`Missing merkle_root or policy_commitment in output: ${body}`);
  }

  const parseHexArray = (name: string): string[] => {
    const regex = new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`);
    const arrMatch = body.match(regex);
    if (!arrMatch) return [];
    const hexes = arrMatch[1].match(/0x[0-9a-fA-F]+/g);
    return hexes || [];
  };

  return {
    merkle_root: field32(rootMatch[1]),
    policy_commitment: field32(commitmentMatch[1]),
    leaves: parseHexArray('leaves').map(field32),
    layer1: parseHexArray('layer1').map(field32),
    layer2: parseHexArray('layer2').map(field32),
    layer3: parseHexArray('layer3').map(field32),
    merchant_hashes: parseHexArray('merchant_hashes').map(field32),
  };
}

export function resolvePolicyCircuitDir(): string {
  if (process.env.LEASH_POLICY_CIRCUIT_DIR && fs.existsSync(process.env.LEASH_POLICY_CIRCUIT_DIR)) {
    return path.resolve(process.env.LEASH_POLICY_CIRCUIT_DIR);
  }

  const candidates = [
    path.resolve(__dirname, '../../policy_circuit'),
    path.resolve(__dirname, '../../../policy_circuit'),
    path.resolve(__dirname, '../../../packages/core/policy_circuit'),
    path.resolve(__dirname, '../../../../packages/core/policy_circuit'),
    path.resolve(process.cwd(), 'policy_circuit'),
    path.resolve(process.cwd(), 'packages/core/policy_circuit'),
    path.resolve(process.cwd(), '../core/policy_circuit'),
    path.resolve(process.cwd(), '../../packages/core/policy_circuit'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'Nargo.toml'))) {
      return candidate;
    }
  }

  throw new Error(`Cannot locate policy_circuit directory. Looked in: ${candidates.join(', ')}`);
}

export interface PolicyBundleInput {
  /** 16 merchant field ids (0 = empty slot) */
  merchantIds: bigint[];
  /** 16 payees (160-bit), aligned with merchantIds */
  payees: bigint[];
  maxPerTxCents: number;
  dailyCapCents: number;
  policySalt: bigint;
  spendSalt: bigint;
}

/**
 * Executes policy_circuit to compute the salted (merchant, payee) Merkle tree and the policy
 * commitment with the same Pedersen hashing as the payment circuit.
 */
export function computePolicyBundle(input: PolicyBundleInput): PolicyBundle {
  const { merchantIds, payees } = input;
  if (merchantIds.length !== 16 || payees.length !== 16) {
    throw new Error(`Expected exactly 16 merchant ids and payees, received ${merchantIds.length}/${payees.length}`);
  }

  const policyCircuitDir = resolvePolicyCircuitDir();
  const tag = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const tempProverFile = path.resolve(policyCircuitDir, `Prover_${tag}.toml`);
  const witnessName = `bundle_${tag}`;
  const arr = (xs: bigint[]) => `[${xs.map((x) => `"${x.toString()}"`).join(', ')}]`;

  try {
    fs.writeFileSync(
      tempProverFile,
      [
        `merchant_ids = ${arr(merchantIds)}`,
        `payees = ${arr(payees)}`,
        `max_per_tx = "${input.maxPerTxCents}"`,
        `daily_cap = "${input.dailyCapCents}"`,
        `policy_salt = "${input.policySalt.toString()}"`,
        `spend_salt = "${input.spendSalt.toString()}"`,
      ].join('\n'),
      'utf-8'
    );

    const result = execFileSync(
      toolPath('nargo'),
      ['execute', '--package', 'policy_circuit', '--prover-name', tempProverFile.replace(/\.toml$/, ''), witnessName],
      { cwd: policyCircuitDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return parsePolicyBundleOutput(result);
  } finally {
    for (const f of [tempProverFile, path.resolve(policyCircuitDir, `target/${witnessName}.gz`)]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Calculates the Merkle authentication path for a leaf at index k in [0, 15].
 */
export function getMerklePath(k: number, merchantIds: bigint[], bundle: PolicyBundle): MerklePath {
  if (k < 0 || k >= 16) {
    throw new Error(`Leaf index ${k} out of range [0, 15]`);
  }

  const pathElements: string[] = [
    BigInt(bundle.leaves[k ^ 1]).toString(),
    BigInt(bundle.layer1[(k >> 1) ^ 1]).toString(),
    BigInt(bundle.layer2[(k >> 2) ^ 1]).toString(),
    BigInt(bundle.layer3[(k >> 3) ^ 1]).toString(),
  ];

  const pathIndices: boolean[] = [
    (k & 1) === 1,
    ((k >> 1) & 1) === 1,
    ((k >> 2) & 1) === 1,
    ((k >> 3) & 1) === 1,
  ];

  return {
    merchantId: merchantIds[k].toString(),
    merchantIdHash: bundle.merchant_hashes[k],
    pathElements,
    pathIndices,
  };
}
