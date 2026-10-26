// The hub owner's hidden LEASH policy (random salts, private) and its rolling-cap spend chain.
// State lives in HUB_STATE_DIR (default packages/hub/.state, gitignored; a volume on the server).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (process.env.LEASH_TOOLS_DIR !== '') process.env.PATH = `${process.env.LEASH_TOOLS_DIR ?? join(root, '.tools')}:${process.env.PATH}`;
const core = await import(process.env.LEASH_CORE ?? join(root, 'packages/core/dist/index.js'));

export const STATE = process.env.HUB_STATE_DIR ?? join(root, 'packages/hub/.state');
mkdirSync(STATE, { recursive: true, mode: 0o700 });
const P = join(STATE, 'policy.json');
const S = join(STATE, 'spend.json');
const json = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

export const POLICY_SHAPE = { name: 'leash-hub', maxPerTxCents: 100, dailyCapCents: 5000 };

/** Create the policy once (random salts) for the given providers [{ name, payee }]. */
export function initPolicy(merchants) {
  if (existsSync(P)) return loadPolicy();
  const opts = { ...POLICY_SHAPE, merchants };
  const policy = core.createSpendingPolicy(opts);
  writeFileSync(P, json({ opts, policySalt: policy.policySalt, spendSalt: policy.spendSalt, commitment: policy.policyCommitment }), { mode: 0o600 });
  return loadPolicy();
}

export function loadPolicy() {
  if (!existsSync(P)) throw new Error(`no hub policy in ${STATE}: run scripts/setup.mjs (Setup required)`);
  const saved = JSON.parse(readFileSync(P, 'utf8'));
  const policy = core.createSpendingPolicy({ ...saved.opts, policySalt: String(saved.policySalt), spendSalt: String(saved.spendSalt) });
  if (policy.policyCommitment !== saved.commitment) throw new Error('hub policy did not rebuild to its stored commitment');
  return { policy, commitment: policy.policyCommitment, merchants: saved.opts.merchants };
}

const hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');

/** Prove a payment of `cents` to merchant `name` for today's epoch, continuing the spend chain. */
export function prove(policy, name, payee, cents, nonce) {
  const epoch = core.currentEpoch();
  const st = existsSync(S) ? JSON.parse(readFileSync(S, 'utf8')) : null;
  const spend = st && st.epoch === epoch ? { epoch, prevSpendCommit: st.commit, spentBeforeCents: st.spent } : { epoch, prevSpendCommit: '0', spentBeforeCents: 0 };
  const r = core.generatePaymentProof({ policy, merchantName: name, amountCents: cents, nonce: String(nonce), recipient: payee, useEvmTarget: true, spend });
  const pi = r.publicInputs;
  return {
    merchantIdHash: hex32(pi.merchant_id_hash), nonce: hex32(pi.nonce),
    spend: { epoch: BigInt(pi.epoch), prevCommit: hex32(pi.prev_spend_commit), newCommit: hex32(pi.new_spend_commit) },
    proof: r.proofHex.startsWith('0x') ? r.proofHex : '0x' + r.proofHex, ms: r.durationMs,
    advance: () => {
      const spent = (st && st.epoch === epoch ? st.spent : 0) + cents;
      writeFileSync(S, json({ epoch, commit: hex32(pi.new_spend_commit), spent }), { mode: 0o600 });
    },
  };
}

export function spentToday() {
  const st = existsSync(S) ? JSON.parse(readFileSync(S, 'utf8')) : null;
  return st && st.epoch === core.currentEpoch() ? st.spent : 0;
}
