import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { toolExecOptions, toolPath, toolTimeoutMessage } from '../util/paths.js';

export class VerifierDependencyError extends Error {
  public readonly code = 'VERIFIER_DEPENDENCY_MISSING';
  constructor(message: string) {
    super(message);
    this.name = 'VerifierDependencyError';
  }
}

export class VerifierKeyError extends Error {
  public readonly code = 'VERIFIER_KEY_MISSING';
  constructor(message: string) {
    super(message);
    this.name = 'VerifierKeyError';
  }
}

export interface VerifyProofRequest {
  proofHex: string;
  publicInputsHex: string;
  expectedCommitment?: string;
  expectedAmount?: number | string;
  expectedMerchantHash?: string;
  expectedNonce?: string | number;
  expectedRecipient?: string;
  useEvmTarget?: boolean;
  /** Internal override for tests. Never taken from an HTTP request. */
  vkPath?: string;
}

/** The circuit's public inputs, in order (8 x 32 bytes). new_spend_commit is the circuit's return value. */
export interface DecodedPublicInputs {
  policy_commitment: string;
  amount: string;
  merchant_id_hash: string;
  nonce: string;
  recipient: string;
  epoch: string;
  prev_spend_commit: string;
  new_spend_commit: string;
}

export const PUBLIC_INPUT_COUNT = 8;

/**
 * Exact proof sizes for this circuit with the pinned bb (TOOLCHAIN.md): UltraHonk with the default
 * transcript (gateway, console) and with the keccak transcript the Solidity verifier checks (evm).
 */
export const PROOF_BYTES = { default: 16256, evm: 8640 } as const;
export const PUBLIC_INPUTS_BYTES = PUBLIC_INPUT_COUNT * 32;

const HEX_BODY = /^(?:0x)?([0-9a-fA-F]*)$/;

/**
 * Why (proofHex, publicInputsHex) can't be a proof for this circuit, or undefined when both are hex
 * strings of exactly the expected sizes. Checked before anything is written to disk or bb runs.
 */
export function proofInputProblem(proofHex: unknown, publicInputsHex: unknown, useEvmTarget = false): string | undefined {
  const check = (name: string, v: unknown, bytes: number): string | undefined => {
    if (typeof v !== 'string') return `${name} must be a hex string`;
    const m = HEX_BODY.exec(v);
    if (!m) return `${name} must be hex (0-9, a-f, optional 0x prefix)`;
    if (m[1].length !== bytes * 2) return `${name} must be ${bytes} bytes (got ${m[1].length / 2})`;
    return undefined;
  };
  return (
    check('proofHex', proofHex, useEvmTarget ? PROOF_BYTES.evm : PROOF_BYTES.default) ??
    check('publicInputsHex', publicInputsHex, PUBLIC_INPUTS_BYTES)
  );
}

export interface VerifyProofResult {
  valid: boolean;
  error?: string;
  durationMs: number;
  extractedPublicInputs?: DecodedPublicInputs;
}

export interface VerifierHealthStatus {
  status: 'ok' | 'missing_dependency' | 'missing_key';
  service: string;
  version: string;
  bb: {
    available: boolean;
    path?: string;
    version?: string;
  };
  keys: {
    vkPath: string;
    vkExists: boolean;
    vkHash?: string;
    evmVkPath: string;
    evmVkExists: boolean;
  };
  circuits: {
    dir: string;
    bytecodePath: string;
    bytecodeExists: boolean;
  };
  error?: string;
}

/**
 * Resolves the root circuits directory across monorepo layouts and execution contexts.
 */
export function resolveCircuitsDir(): string {
  if (process.env.LEASH_CIRCUITS_DIR && fs.existsSync(process.env.LEASH_CIRCUITS_DIR)) {
    return path.resolve(process.env.LEASH_CIRCUITS_DIR);
  }

  const candidates = [
    path.resolve(__dirname, '../../../../circuits'),
    path.resolve(__dirname, '../../../circuits'),
    path.resolve(process.cwd(), 'circuits'),
    path.resolve(process.cwd(), '../circuits'),
    path.resolve(process.cwd(), '../../circuits'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'Nargo.toml'))) {
      return candidate;
    }
  }

  throw new VerifierKeyError(
    `[LEASH FATAL] Cannot locate Noir circuits directory. Looked in: ${candidates.join(', ')}`
  );
}

/** Absolute path of the bb binary (pinned .tools copy first, see util/paths.ts); throws if absent. */
function resolveBb(): string {
  const bb = toolPath('bb');
  if (path.isAbsolute(bb)) {
    if (!fs.existsSync(bb)) throw new Error(`bb not found at ${bb}`);
    return bb;
  }
  const found = execFileSync('which', [bb], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...toolExecOptions() }).trim();
  if (!found) throw new Error('which bb returned empty path');
  return found;
}

/**
 * Asserts that required binaries (bb) and circuit verification keys exist.
 * FAILS LOUDLY when any dependency or key is missing. No mocks allowed.
 */
export function assertVerifierDependencies(options?: {
  circuitsDir?: string;
  useEvmTarget?: boolean;
  vkPath?: string;
}): {
  bbPath: string;
  circuitsDir: string;
  vkPath: string;
  bytecodePath: string;
} {
  // 1. Verify bb binary on PATH
  let bbPath = '';
  try {
    bbPath = resolveBb();
  } catch {
    const errorMsg =
      "FATAL DEPENDENCY ERROR: 'bb' (Barretenberg) binary is not installed or not found on PATH. " +
      'LEASH requires the real Barretenberg prover/verifier binary to verify Noir UltraHonk proofs. ' +
      'Install via: bbup, or ensure ~/.bb is added to your PATH.';
    console.error('\n' + '='.repeat(70));
    console.error('[LEASH VERIFIER FATAL ERROR]');
    console.error(errorMsg);
    console.error('=' .repeat(70) + '\n');
    throw new VerifierDependencyError(errorMsg);
  }

  // 2. Verify circuits directory
  const circuitsDir = options?.circuitsDir || resolveCircuitsDir();
  if (!fs.existsSync(circuitsDir)) {
    const errorMsg = `FATAL KEY ERROR: Noir circuits directory not found at: '${circuitsDir}'.`;
    console.error('\n' + '='.repeat(70));
    console.error('[LEASH VERIFIER FATAL ERROR]');
    console.error(errorMsg);
    console.error('=' .repeat(70) + '\n');
    throw new VerifierKeyError(errorMsg);
  }

  // 3. Verify Verification Key file exists
  const defaultVkRelative = options?.useEvmTarget
    ? 'target/vk_evm/vk'
    : 'target/vk/vk';
  const vkPath = options?.vkPath
    ? path.resolve(options.vkPath)
    : path.resolve(circuitsDir, defaultVkRelative);

  if (!fs.existsSync(vkPath)) {
    const errorMsg =
      `FATAL KEY ERROR: Verification key missing at '${vkPath}'. ` +
      `LEASH verifies Noir proofs for real — no mock keys or bypasses. ` +
      `Generate the key: cd "${circuitsDir}" && nargo compile && bb write_vk -b ./target/leash_circuit.json -o ./target/vk`;
    console.error('\n' + '='.repeat(70));
    console.error('[LEASH VERIFIER FATAL ERROR]');
    console.error(errorMsg);
    console.error('=' .repeat(70) + '\n');
    throw new VerifierKeyError(errorMsg);
  }

  // 4. Verify compiled circuit bytecode exists
  const bytecodePath = path.resolve(circuitsDir, 'target/leash_circuit.json');
  if (!fs.existsSync(bytecodePath)) {
    const errorMsg =
      `FATAL KEY ERROR: Circuit bytecode missing at '${bytecodePath}'. ` +
      `Compile circuit first: cd "${circuitsDir}" && nargo compile`;
    console.error('\n' + '='.repeat(70));
    console.error('[LEASH VERIFIER FATAL ERROR]');
    console.error(errorMsg);
    console.error('=' .repeat(70) + '\n');
    throw new VerifierKeyError(errorMsg);
  }

  return { bbPath, circuitsDir, vkPath, bytecodePath };
}

/**
 * Checks overall verifier health, returning comprehensive diagnostics.
 */
export function checkVerifierHealth(): VerifierHealthStatus {
  let circuitsDir = '';
  try {
    circuitsDir = resolveCircuitsDir();
  } catch {
    circuitsDir = 'unknown';
  }

  let bbPath = '';
  let bbVersion = '';
  let bbAvailable = false;
  try {
    bbPath = resolveBb();
    bbVersion = execFileSync(bbPath, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...toolExecOptions() }).trim();
    bbAvailable = true;
  } catch {
    bbAvailable = false;
  }

  const vkPath = path.resolve(circuitsDir, 'target/vk/vk');
  const vkExists = fs.existsSync(vkPath);
  let vkHash: string | undefined;
  if (vkExists) {
    const vkHashPath = path.resolve(circuitsDir, 'target/vk/vk_hash');
    if (fs.existsSync(vkHashPath)) {
      vkHash = `0x${fs.readFileSync(vkHashPath).toString('hex')}`;
    }
  }

  const evmVkPath = path.resolve(circuitsDir, 'target/vk_evm/vk');
  const evmVkExists = fs.existsSync(evmVkPath);

  const bytecodePath = path.resolve(circuitsDir, 'target/leash_circuit.json');
  const bytecodeExists = fs.existsSync(bytecodePath);

  let status: 'ok' | 'missing_dependency' | 'missing_key' = 'ok';
  let error: string | undefined;

  if (!bbAvailable) {
    status = 'missing_dependency';
    error = "Required dependency 'bb' not found on PATH.";
  } else if (!vkExists || !bytecodeExists) {
    status = 'missing_key';
    error = `Required circuit artifacts missing (vkExists: ${vkExists}, bytecodeExists: ${bytecodeExists}).`;
  }

  return {
    status,
    service: 'LEASH Noir Proof Verifier',
    version: '1.0.0',
    bb: {
      available: bbAvailable,
      path: bbPath || undefined,
      version: bbVersion || undefined,
    },
    keys: {
      vkPath,
      vkExists,
      vkHash,
      evmVkPath,
      evmVkExists,
    },
    circuits: {
      dir: circuitsDir,
      bytecodePath,
      bytecodeExists,
    },
    error,
  };
}

/** Decodes bb's public_inputs (8 x 32-byte big-endian fields) into named values. */
export function decodePublicInputs(buffer: Buffer): DecodedPublicInputs {
  if (buffer.length !== PUBLIC_INPUT_COUNT * 32) {
    throw new Error(`Public inputs must be ${PUBLIC_INPUT_COUNT} x 32 bytes (received ${buffer.length} bytes)`);
  }
  const word = (i: number) => buffer.subarray(i * 32, (i + 1) * 32).toString('hex');
  const hex = (i: number) => `0x${word(i)}`.toLowerCase();
  const dec = (i: number) => BigInt(`0x${word(i)}`).toString();
  return {
    policy_commitment: hex(0),
    amount: dec(1),
    merchant_id_hash: hex(2),
    nonce: dec(3),
    recipient: `0x${word(4).slice(-40)}`.toLowerCase(),
    epoch: dec(5),
    prev_spend_commit: hex(6),
    new_spend_commit: hex(7),
  };
}

/**
 * Verifies an UltraHonk proof against the circuit verification key and public inputs.
 * Uses the real Barretenberg `bb verify` binary.
 * FAILS LOUDLY if a dependency or key is missing.
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
    expectedRecipient,
    useEvmTarget,
  } = req;

  // 0. Shape: hex strings of the exact proof / public-input sizes, before any file write or bb call.
  const problem = proofInputProblem(proofHex, publicInputsHex, Boolean(useEvmTarget));
  if (problem) return { valid: false, error: problem, durationMs: Date.now() - startTime };

  // 1. Assert dependencies and keys exist - fails loudly if missing!
  const deps = assertVerifierDependencies({
    useEvmTarget,
    vkPath: req.vkPath,
  });

  const proofClean = proofHex.startsWith('0x') ? proofHex.slice(2) : proofHex;
  const pubClean = publicInputsHex.startsWith('0x')
    ? publicInputsHex.slice(2)
    : publicInputsHex;

  const proofBuffer = Buffer.from(proofClean, 'hex');
  const pubBuffer = Buffer.from(pubClean, 'hex');

  // 2. Validate public input layout
  let decoded: DecodedPublicInputs;
  try {
    decoded = decodePublicInputs(pubBuffer);
  } catch (err: any) {
    return {
      valid: false,
      error: `Failed to decode public inputs: ${err.message}`,
      durationMs: Date.now() - startTime,
    };
  }

  // 3. Optional Semantic consistency check
  if (expectedCommitment !== undefined) {
    const expCommitmentClean = expectedCommitment.toLowerCase();
    if (decoded.policy_commitment !== expCommitmentClean) {
      return {
        valid: false,
        error: `Public input mismatch: policy_commitment in proof (${decoded.policy_commitment}) does not match expected (${expCommitmentClean})`,
        durationMs: Date.now() - startTime,
        extractedPublicInputs: decoded,
      };
    }
  }

  if (expectedAmount !== undefined) {
    const expAmountStr = expectedAmount.toString();
    if (decoded.amount !== expAmountStr) {
      return {
        valid: false,
        error: `Public input mismatch: amount in proof (${decoded.amount}) does not match expected (${expAmountStr})`,
        durationMs: Date.now() - startTime,
        extractedPublicInputs: decoded,
      };
    }
  }

  if (expectedMerchantHash !== undefined) {
    const expMerchantHashClean = expectedMerchantHash.toLowerCase();
    if (decoded.merchant_id_hash !== expMerchantHashClean) {
      return {
        valid: false,
        error: `Public input mismatch: merchant_id_hash in proof (${decoded.merchant_id_hash}) does not match expected (${expMerchantHashClean})`,
        durationMs: Date.now() - startTime,
        extractedPublicInputs: decoded,
      };
    }
  }

  if (expectedNonce !== undefined) {
    const expNonceStr = expectedNonce.toString();
    if (decoded.nonce !== expNonceStr) {
      return {
        valid: false,
        error: `Public input mismatch: nonce in proof (${decoded.nonce}) does not match expected (${expNonceStr})`,
        durationMs: Date.now() - startTime,
        extractedPublicInputs: decoded,
      };
    }
  }

  if (expectedRecipient !== undefined && decoded.recipient !== expectedRecipient.toLowerCase()) {
    return {
      valid: false,
      error: `Public input mismatch: recipient in proof (${decoded.recipient}) does not match expected (${expectedRecipient.toLowerCase()})`,
      durationMs: Date.now() - startTime,
      extractedPublicInputs: decoded,
    };
  }

  // 4. Real cryptographic proof verification using Barretenberg
  const tempId = `verify_${Date.now()}_${process.pid}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const tempProofPath = path.resolve(deps.circuitsDir, `target/${tempId}.proof`);
  const tempPubPath = path.resolve(deps.circuitsDir, `target/${tempId}.pub`);

  try {
    fs.writeFileSync(tempProofPath, proofBuffer);
    fs.writeFileSync(tempPubPath, pubBuffer);

    execFileSync(
      deps.bbPath,
      ['verify', '-k', deps.vkPath, '-p', tempProofPath, '-i', tempPubPath, ...(useEvmTarget ? ['-t', 'evm'] : [])],
      { cwd: deps.circuitsDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...toolExecOptions() }
    );

    return {
      valid: true,
      durationMs: Date.now() - startTime,
      extractedPublicInputs: decoded,
    };
  } catch (err: any) {
    const stderrMsg = err.stderr ? err.stderr.toString().trim() : '';
    const errorDetail = toolTimeoutMessage('bb verify', err) ?? (stderrMsg || err.message || 'invalid proof');
    return {
      valid: false,
      error: `Barretenberg verification failed: ${errorDetail}`,
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
