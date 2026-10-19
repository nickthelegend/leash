import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface VerifyProofRequest {
  proofHex: string;
  publicInputsHex: string;
  expectedCommitment: string;
  expectedAmount: number | string;
  expectedMerchantHash: string;
  expectedNonce: string | number;
  useEvmTarget?: boolean;
}

export interface VerifyProofResult {
  valid: boolean;
  error?: string;
  durationMs: number;
  extractedPublicInputs?: {
    policy_commitment: string;
    amount: string;
    merchant_id_hash: string;
    nonce: string;
  };
}

/**
 * Decodes the 128-byte public inputs buffer (4 * 32 bytes) into individual field elements.
 */
export function decodePublicInputs(buffer: Buffer): {
  policy_commitment: string;
  amount: string;
  merchant_id_hash: string;
  nonce: string;
} {
  if (buffer.length < 128) {
    throw new Error(
      `Public inputs buffer must be at least 128 bytes, received ${buffer.length}`
    );
  }

  const p0 = buffer.subarray(0, 32);
  const p1 = buffer.subarray(32, 64);
  const p2 = buffer.subarray(64, 96);
  const p3 = buffer.subarray(96, 128);

  return {
    policy_commitment: `0x${p0.toString('hex')}`.toLowerCase(),
    amount: BigInt(`0x${p1.toString('hex')}`).toString(),
    merchant_id_hash: `0x${p2.toString('hex')}`.toLowerCase(),
    nonce: BigInt(`0x${p3.toString('hex')}`).toString(),
  };
}

/**
 * Verifies an UltraHonk proof against the circuit verification key and public inputs.
 */
export function verifyPaymentProof(
  req: VerifyProofRequest
): VerifyProofResult {
  const startTime = Date.now();
  const {
    proofHex,
    publicInputsHex,
    expectedCommitment,
    expectedAmount,
    expectedMerchantHash,
    expectedNonce,
    useEvmTarget,
  } = req;

  const proofClean = proofHex.startsWith('0x') ? proofHex.slice(2) : proofHex;
  const pubClean = publicInputsHex.startsWith('0x')
    ? publicInputsHex.slice(2)
    : publicInputsHex;

  const proofBuffer = Buffer.from(proofClean, 'hex');
  const pubBuffer = Buffer.from(pubClean, 'hex');

  // 1. Validate public input layout
  let decoded: {
    policy_commitment: string;
    amount: string;
    merchant_id_hash: string;
    nonce: string;
  };
  try {
    decoded = decodePublicInputs(pubBuffer);
  } catch (err: any) {
    return {
      valid: false,
      error: `Failed to decode public inputs: ${err.message}`,
      durationMs: Date.now() - startTime,
    };
  }

  // 2. Semantic consistency check
  const expCommitmentClean = expectedCommitment.toLowerCase();
  const expMerchantHashClean = expectedMerchantHash.toLowerCase();
  const expAmountStr = expectedAmount.toString();
  const expNonceStr = expectedNonce.toString();

  if (decoded.policy_commitment !== expCommitmentClean) {
    return {
      valid: false,
      error: `Public input mismatch: policy_commitment in proof (${decoded.policy_commitment}) does not match expected (${expCommitmentClean})`,
      durationMs: Date.now() - startTime,
      extractedPublicInputs: decoded,
    };
  }

  if (decoded.amount !== expAmountStr) {
    return {
      valid: false,
      error: `Public input mismatch: amount in proof (${decoded.amount}) does not match expected (${expAmountStr})`,
      durationMs: Date.now() - startTime,
      extractedPublicInputs: decoded,
    };
  }

  if (decoded.merchant_id_hash !== expMerchantHashClean) {
    return {
      valid: false,
      error: `Public input mismatch: merchant_id_hash in proof (${decoded.merchant_id_hash}) does not match expected (${expMerchantHashClean})`,
      durationMs: Date.now() - startTime,
      extractedPublicInputs: decoded,
    };
  }

  if (decoded.nonce !== expNonceStr) {
    return {
      valid: false,
      error: `Public input mismatch: nonce in proof (${decoded.nonce}) does not match expected (${expNonceStr})`,
      durationMs: Date.now() - startTime,
      extractedPublicInputs: decoded,
    };
  }

  // 3. Cryptographic proof verification using Barretenberg
  const circuitsDir = path.resolve(__dirname, '../../../../circuits');
  const tempId = `verify_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const tempProofPath = path.resolve(circuitsDir, `target/${tempId}.proof`);
  const tempPubPath = path.resolve(circuitsDir, `target/${tempId}.pub`);
  const vkPath = useEvmTarget
    ? path.resolve(circuitsDir, 'target/vk_evm/vk')
    : path.resolve(circuitsDir, 'target/vk/vk');

  try {
    fs.writeFileSync(tempProofPath, proofBuffer);
    fs.writeFileSync(tempPubPath, pubBuffer);

    const targetFlag = useEvmTarget ? '-t evm' : '';
    const verifyCmd = `bb verify -k "${vkPath}" -p "${tempProofPath}" -i "${tempPubPath}" ${targetFlag}`;

    execSync(verifyCmd, {
      cwd: circuitsDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return {
      valid: true,
      durationMs: Date.now() - startTime,
      extractedPublicInputs: decoded,
    };
  } catch (err: any) {
    return {
      valid: false,
      error: `Barretenberg verification failed: ${
        err.stderr || err.message || 'invalid proof'
      }`,
      durationMs: Date.now() - startTime,
      extractedPublicInputs: decoded,
    };
  } finally {
    if (fs.existsSync(tempProofPath)) {
      try {
        fs.unlinkSync(tempProofPath);
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(tempPubPath)) {
      try {
        fs.unlinkSync(tempPubPath);
      } catch {
        // ignore
      }
    }
  }
}
