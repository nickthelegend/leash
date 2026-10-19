import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const BN254_FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface PolicyBundle {
  merkle_root: string;
  policy_commitment: string;
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
 * Parses the structured Circuit Output printed by Noir.
 */
function parsePolicyBundleOutput(output: string): PolicyBundle {
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
    merkle_root: rootMatch[1].toLowerCase(),
    policy_commitment: commitmentMatch[1].toLowerCase(),
    layer1: parseHexArray('layer1').map((h) => h.toLowerCase()),
    layer2: parseHexArray('layer2').map((h) => h.toLowerCase()),
    layer3: parseHexArray('layer3').map((h) => h.toLowerCase()),
    merchant_hashes: parseHexArray('merchant_hashes').map((h) => h.toLowerCase()),
  };
}

/**
 * Executes policy_circuit to compute the Pedersen Merkle tree and commitment with 100% Noir fidelity.
 */
export function computePolicyBundle(
  leavesBigInt: bigint[],
  maxPerTxCents: number,
  policySalt: bigint
): PolicyBundle {
  if (leavesBigInt.length !== 16) {
    throw new Error(`Expected exactly 16 leaves, received ${leavesBigInt.length}`);
  }

  const policyCircuitDir = path.resolve(__dirname, '../../policy_circuit');
  const tempProverFile = path.resolve(
    policyCircuitDir,
    `Prover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.toml`
  );
  const witnessName = `bundle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const tomlContent = [
      `leaves = [${leavesBigInt.map((l) => `"${l.toString()}"`).join(', ')}]`,
      `max_per_tx = "${maxPerTxCents}"`,
      `policy_salt = "${policySalt.toString()}"`,
    ].join('\n');

    fs.writeFileSync(tempProverFile, tomlContent, 'utf-8');

    const cmd = `nargo execute --package policy_circuit --prover-name "${tempProverFile.replace(
      /\.toml$/,
      ''
    )}" "${witnessName}"`;

    const result = execSync(cmd, {
      cwd: policyCircuitDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parsed = parsePolicyBundleOutput(result);

    // Clean up temporary witness file if generated
    const targetWitness = path.resolve(policyCircuitDir, `target/${witnessName}.gz`);
    if (fs.existsSync(targetWitness)) {
      try {
        fs.unlinkSync(targetWitness);
      } catch {
        // ignore
      }
    }

    return parsed;
  } finally {
    if (fs.existsSync(tempProverFile)) {
      try {
        fs.unlinkSync(tempProverFile);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Calculates the Merkle authentication path for a leaf at index k in [0, 15].
 */
export function getMerklePath(
  k: number,
  leaves: bigint[],
  bundle: PolicyBundle
): MerklePath {
  if (k < 0 || k >= 16) {
    throw new Error(`Leaf index ${k} out of range [0, 15]`);
  }

  const pathElements: string[] = [
    leaves[k ^ 1].toString(),
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
    merchantId: leaves[k].toString(),
    merchantIdHash: bundle.merchant_hashes[k],
    pathElements,
    pathIndices,
  };
}
