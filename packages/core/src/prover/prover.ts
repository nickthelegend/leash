import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getMerchantProof, SpendingPolicy } from '../policy/policy.js';

export interface PaymentProofRequest {
  policy: SpendingPolicy;
  merchantName: string;
  amountCents: number;
  nonce: string | number;
  useEvmTarget?: boolean;
}

export interface PaymentProofResult {
  proofHex: string;
  publicInputsHex: string;
  publicInputs: {
    policy_commitment: string;
    amount: string;
    merchant_id_hash: string;
    nonce: string;
  };
  durationMs: number;
  circuitGates?: number;
}

/**
 * Generates an UltraHonk ZK proof using Noir and Barretenberg.
 * Enforces the two spending rules:
 *   R1: merchant allowlist membership (via Merkle proof)
 *   R2: per-transaction cap (amount <= max_per_tx)
 */
export function generatePaymentProof(
  req: PaymentProofRequest
): PaymentProofResult {
  const startTime = Date.now();
  const { policy, merchantName, amountCents, nonce, useEvmTarget } = req;

  // Pre-check 1: Merchant Allowlist
  const normalizedMerchant = merchantName.trim().toLowerCase();
  if (!policy.merchants.includes(normalizedMerchant)) {
    throw new Error(
      `Rule R1 Violation: Merchant '${merchantName}' is not in the allowlist.`
    );
  }

  // Pre-check 2: Per-transaction cap
  if (amountCents > policy.maxPerTxCents) {
    throw new Error(
      `Rule R2 Violation: Amount $${(amountCents / 100).toFixed(
        2
      )} exceeds the per-transaction cap of $${(
        policy.maxPerTxCents / 100
      ).toFixed(2)}.`
    );
  }

  const merklePath = getMerchantProof(policy, merchantName);

  const circuitsDir = path.resolve(__dirname, '../../../../circuits');
  const tempId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempProverFile = path.resolve(circuitsDir, `Prover_${tempId}.toml`);
  const witnessName = `witness_${tempId}`;
  const proofDir = path.resolve(circuitsDir, `target/proof_${tempId}`);

  try {
    const tomlContent = [
      `policy_commitment = "${policy.policyCommitment}"`,
      `amount = "${amountCents}"`,
      `merchant_id_hash = "${merklePath.merchantIdHash}"`,
      `nonce = "${nonce.toString()}"`,
      '',
      `max_per_tx = "${policy.maxPerTxCents}"`,
      `merkle_root = "${policy.merkleRoot}"`,
      `policy_salt = "${policy.policySalt}"`,
      `merchant_id = "${merklePath.merchantId}"`,
      `merkle_path_indices = [${merklePath.pathIndices.join(', ')}]`,
      `merkle_path_elements = [${merklePath.pathElements
        .map((e) => `"${e}"`)
        .join(', ')}]`,
    ].join('\n');

    fs.writeFileSync(tempProverFile, tomlContent, 'utf-8');

    // 1. Solve circuit witness using nargo
    const executeCmd = `nargo execute --package leash_circuit --prover-name "${tempProverFile.replace(
      /\.toml$/,
      ''
    )}" "${witnessName}"`;

    execSync(executeCmd, {
      cwd: circuitsDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const witnessPath = path.resolve(circuitsDir, `target/${witnessName}.gz`);
    const bytecodePath = path.resolve(circuitsDir, 'target/leash_circuit.json');
    const vkPath = useEvmTarget
      ? path.resolve(circuitsDir, 'target/vk_evm/vk')
      : path.resolve(circuitsDir, 'target/vk/vk');

    fs.mkdirSync(proofDir, { recursive: true });

    // 2. Generate UltraHonk ZK proof with Barretenberg
    const targetFlag = useEvmTarget ? '-t evm' : '';
    const proveCmd = `bb prove -b "${bytecodePath}" -w "${witnessPath}" -o "${proofDir}" -k "${vkPath}" ${targetFlag}`;

    execSync(proveCmd, {
      cwd: circuitsDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const proofFile = path.resolve(proofDir, 'proof');
    const publicInputsFile = path.resolve(proofDir, 'public_inputs');

    const proofBuffer = fs.readFileSync(proofFile);
    const publicInputsBuffer = fs.readFileSync(publicInputsFile);

    const durationMs = Date.now() - startTime;

    return {
      proofHex: `0x${proofBuffer.toString('hex')}`,
      publicInputsHex: `0x${publicInputsBuffer.toString('hex')}`,
      publicInputs: {
        policy_commitment: policy.policyCommitment,
        amount: amountCents.toString(),
        merchant_id_hash: merklePath.merchantIdHash,
        nonce: nonce.toString(),
      },
      durationMs,
    };
  } finally {
    // Cleanup temporary files
    if (fs.existsSync(tempProverFile)) {
      try {
        fs.unlinkSync(tempProverFile);
      } catch {
        // ignore
      }
    }
    const witnessPath = path.resolve(circuitsDir, `target/${witnessName}.gz`);
    if (fs.existsSync(witnessPath)) {
      try {
        fs.unlinkSync(witnessPath);
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(proofDir)) {
      try {
        fs.rmSync(proofDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
