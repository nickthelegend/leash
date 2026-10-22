import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isAddress } from '../crypto/evm.js';
import { findMerchant, getMerchantProof, SpendingPolicy } from '../policy/policy.js';
import { currentEpoch, SpendInputs } from '../spend/spendState.js';
import { toolExecOptions, toolPath, toolTimeoutMessage, withPrivateProverFile } from '../util/paths.js';
import { decodePublicInputs, DecodedPublicInputs, resolveCircuitsDir } from '../verifier/verifier.js';

/**
 * Proving runs on the agent / owner device (leash-mcp, the local console, scripts): it needs the
 * policy secrets. Gateways only verify.
 */
export interface PaymentProofRequest {
  policy: SpendingPolicy;
  merchantName: string;
  amountCents: number;
  nonce: string | number;
  /** Payee bound into the proof. Defaults to the payee listed for this merchant in the policy. */
  recipient?: string;
  /** Rolling daily cap state; defaults to a fresh epoch (prev 0, spent 0) for today. */
  spend?: SpendInputs;
  useEvmTarget?: boolean;
  /** Skip the fast R1/R2 pre-checks so the circuit itself has to refuse (harness, tests). */
  skipPrechecks?: boolean;
}

export interface PaymentProofResult {
  proofHex: string;
  publicInputsHex: string;
  publicInputs: DecodedPublicInputs;
  /** spent_before used for this proof (private; the owner keeps it to advance the spend chain) */
  spentBeforeCents: number;
  durationMs: number;
}

/** A payment the circuit (or a pre-check) refused. `rule` names the violated constraint. */
export class PolicyViolation extends Error {
  constructor(public readonly rule: string, message: string) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

const CIRCUIT_RULES: [RegExp, string][] = [
  [/Amount exceeds per-transaction cap/, 'R2_PER_TX_CAP'],
  [/Merchant\/payee pair not in allowlist/, 'R1_ALLOWLIST_PAYEE'],
  [/Amount exceeds daily cap/, 'R4_DAILY_CAP'],
  [/Stale or forged spend commitment/, 'R4_SPEND_CHAIN'],
  [/Policy commitment mismatch/, 'POLICY_COMMITMENT'],
  [/Merchant ID hash mismatch/, 'MERCHANT_HASH'],
];

/** A payment nonce: a canonical decimal integer (no sign, no leading zeros, no hex), 1-30 digits. */
export const NONCE_RE = /^(0|[1-9][0-9]{0,29})$/;

/** Throws unless `nonce` is a canonical decimal nonce (what the proof's public input will read back as). */
export function assertNonce(nonce: unknown): string {
  const s = typeof nonce === 'number' && Number.isSafeInteger(nonce) && nonce >= 0 ? String(nonce) : nonce;
  if (typeof s !== 'string' || !NONCE_RE.test(s)) {
    throw new Error(`nonce must be a decimal integer string without leading zeros (1-30 digits), got ${JSON.stringify(String(nonce)).slice(0, 40)}`);
  }
  return s;
}

/**
 * Prover.toml for nargo. Every value is written as a TOML basic string through JSON.stringify (booleans
 * as bare true / false), so a value can never close its quotes or start a new key. Pure; unit-tested.
 */
type TomlScalar = string | number | bigint | boolean;
export function proverToml(values: [string, TomlScalar | TomlScalar[]][]): string {
  const q = (v: TomlScalar) => (typeof v === 'boolean' ? String(v) : JSON.stringify(String(v)));
  return values
    .map(([k, v]) => {
      if (!/^[a-z_]+$/.test(k)) throw new Error(`bad Prover.toml key ${k}`);
      return Array.isArray(v) ? `${k} = [${v.map(q).join(', ')}]` : `${k} = ${q(v)}`;
    })
    .join('\n');
}

/**
 * Generates an UltraHonk proof with nargo + bb that the payment satisfies the policy:
 *   R1 merchant allowlist with its bound payee, R2 per-transaction cap, R4 rolling daily cap.
 */
export function generatePaymentProof(req: PaymentProofRequest): PaymentProofResult {
  const startTime = Date.now();
  const { policy, merchantName, amountCents, useEvmTarget } = req;
  const nonce = assertNonce(req.nonce);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
  const spend = req.spend ?? { epoch: currentEpoch(), prevSpendCommit: '0', spentBeforeCents: 0 };

  if (!req.skipPrechecks) {
    if (!findMerchant(policy, merchantName)) {
      throw new PolicyViolation('R1_ALLOWLIST_PAYEE', `Rule R1 Violation: Merchant '${merchantName}' is not in the allowlist.`);
    }
    if (amountCents > policy.maxPerTxCents) {
      throw new PolicyViolation(
        'R2_PER_TX_CAP',
        `Rule R2 Violation: Amount $${(amountCents / 100).toFixed(2)} exceeds the per-transaction cap of $${(policy.maxPerTxCents / 100).toFixed(2)}.`
      );
    }
  }

  const leaf = findMerchant(policy, merchantName);
  if (!leaf) {
    // No leaf on the owner device means no witness can exist: refuse before touching the circuit.
    throw new PolicyViolation('R1_ALLOWLIST_PAYEE', `Rule R1 Violation: Merchant '${merchantName}' is not in the allowlist.`);
  }
  const merklePath = getMerchantProof(policy, merchantName);
  const recipient = (req.recipient ?? leaf.payee).trim();
  if (!isAddress(recipient)) {
    throw new Error('Recipient not configured: the merchant has no payee in this policy and none was given.');
  }

  const circuitsDir = resolveCircuitsDir();
  const tempId = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const witnessName = `witness_${tempId}`;
  const witnessPath = path.resolve(circuitsDir, `target/${witnessName}.gz`);
  const proofDir = path.resolve(circuitsDir, `target/proof_${tempId}`);

  try {
    const toml = proverToml([
        ['policy_commitment', policy.policyCommitment],
        ['amount', amountCents],
        ['merchant_id_hash', merklePath.merchantIdHash],
        ['nonce', nonce],
        ['recipient', recipient],
        ['epoch', spend.epoch],
        ['prev_spend_commit', spend.prevSpendCommit],
        ['max_per_tx', policy.maxPerTxCents],
        ['daily_cap', policy.dailyCapCents],
        ['merkle_root', policy.merkleRoot],
        ['policy_salt', policy.policySalt],
        ['spend_salt', policy.spendSalt],
        ['merchant_id', merklePath.merchantId],
        ['spent_before', spend.spentBeforeCents],
        ['merkle_path_indices', merklePath.pathIndices],
        ['merkle_path_elements', merklePath.pathElements],
    ]);

    // 1. Solve the witness. A payment outside the policy fails here: no witness, no proof.
    // The secrets go in a private temp Prover.toml (0600), never into the repo tree.
    try {
      withPrivateProverFile(circuitsDir, toml, (proverName) =>
        execFileSync(toolPath('nargo'), ['execute', '--package', 'leash_circuit', '--prover-name', proverName, witnessName], {
          cwd: circuitsDir,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          ...toolExecOptions(),
        })
      );
    } catch (err: any) {
      const timedOut = toolTimeoutMessage('nargo execute', err);
      if (timedOut) throw new Error(timedOut);
      const out = `${err.stderr ?? ''}\n${err.stdout ?? ''}`;
      const hit = CIRCUIT_RULES.find(([re]) => re.test(out));
      if (hit) {
        throw new PolicyViolation(hit[1], `Circuit refused the payment (constraint failed): '${out.match(hit[0])![0]}'`);
      }
      throw err;
    }

    const bytecodePath = path.resolve(circuitsDir, 'target/leash_circuit.json');
    const vkPath = path.resolve(circuitsDir, useEvmTarget ? 'target/vk_evm/vk' : 'target/vk/vk');
    fs.mkdirSync(proofDir, { recursive: true });

    // 2. UltraHonk proof (-t evm: keccak transcript for the Solidity verifier).
    try {
      execFileSync(
        toolPath('bb'),
        ['prove', '-b', bytecodePath, '-w', witnessPath, '-o', proofDir, '-k', vkPath, ...(useEvmTarget ? ['-t', 'evm'] : [])],
        { cwd: circuitsDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...toolExecOptions() }
      );
    } catch (err) {
      const timedOut = toolTimeoutMessage('bb prove', err);
      throw timedOut ? new Error(timedOut) : err;
    }

    const proofBuffer = fs.readFileSync(path.resolve(proofDir, 'proof'));
    const publicInputsBuffer = fs.readFileSync(path.resolve(proofDir, 'public_inputs'));

    return {
      proofHex: `0x${proofBuffer.toString('hex')}`,
      publicInputsHex: `0x${publicInputsBuffer.toString('hex')}`,
      // Read back from bb's public_inputs, including the circuit-computed new_spend_commit.
      publicInputs: decodePublicInputs(publicInputsBuffer),
      spentBeforeCents: spend.spentBeforeCents,
      durationMs: Date.now() - startTime,
    };
  } finally {
    for (const f of [witnessPath, proofDir]) {
      try {
        fs.rmSync(f, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
