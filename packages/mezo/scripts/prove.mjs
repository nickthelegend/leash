// Owner/agent-side proving for the live Mezo run. State stays in packages/mezo/.state (gitignored): the policy
// with its random salts (private witness) and the rolling-cap chain.
//   node prove.mjs init <payee>                 -> creates the policy, prints {commitment}
//   node prove.mjs pay <cents> <nonce> [epoch]  -> prints the proof + public inputs for executePayment
//   node prove.mjs advance <newCommit> <cents>  -> after a payment lands, moves the spend chain forward
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.PATH = `${join(root, '.tools')}:${process.env.PATH}`;
const core = await import(join(root, 'packages/core/dist/index.js'));
const state = join(root, 'packages/mezo/.state'); mkdirSync(state, { recursive: true, mode: 0o700 });
const P = join(state, 'policy.json'), S = join(state, 'spend.json');
const [cmd, a, b, c] = process.argv.slice(2);
const json = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const out = (o) => process.stdout.write(json(o) + '\n');
if (cmd === 'init') {
  if (existsSync(P)) { out({ commitment: JSON.parse(readFileSync(P, 'utf8')).policy.policyCommitment, existing: true }); process.exit(0); }
  const opts = { name: 'mezo-live', maxPerTxCents: 500, dailyCapCents: 1500, merchants: [{ name: 'mezo-merchant', payee: a }] };
  const policy = core.createSpendingPolicy(opts); // random salts
  writeFileSync(P, json({ opts, policySalt: policy.policySalt, spendSalt: policy.spendSalt, policy }), { mode: 0o600 });
  out({ commitment: policy.policyCommitment });
} else if (cmd === 'pay') {
  const saved = JSON.parse(readFileSync(P, 'utf8'));
  const policy = core.createSpendingPolicy({ ...saved.opts, policySalt: String(saved.policySalt), spendSalt: String(saved.spendSalt) });
  if (policy.policyCommitment !== saved.policy.policyCommitment) throw new Error('policy did not rebuild to the same commitment');
  const epoch = c ? Number(c) : core.currentEpoch();
  const st = existsSync(S) ? JSON.parse(readFileSync(S, 'utf8')) : null;
  const spend = st && st.epoch === epoch ? { epoch, prevSpendCommit: st.commit, spentBeforeCents: st.spent } : { epoch, prevSpendCommit: '0', spentBeforeCents: 0 };
  const r = core.generatePaymentProof({ policy, merchantName: 'mezo-merchant', amountCents: Number(a), nonce: String(b), recipient: saved.opts.merchants[0].payee, useEvmTarget: true, spend });
  const pi = r.publicInputs, hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  out({ commitment: hex32(pi.policy_commitment), cents: Number(pi.amount), merchantIdHash: hex32(pi.merchant_id_hash), nonce: hex32(pi.nonce), recipient: '0x' + BigInt(pi.recipient).toString(16).padStart(40, '0'), epoch: Number(pi.epoch), prev: hex32(pi.prev_spend_commit), next: hex32(pi.new_spend_commit), proof: r.proofHex.startsWith('0x') ? r.proofHex : '0x' + r.proofHex, ms: r.durationMs });
} else if (cmd === 'advance') {
  const st = existsSync(S) ? JSON.parse(readFileSync(S, 'utf8')) : null;
  const epoch = core.currentEpoch();
  const spent = (st && st.epoch === epoch ? st.spent : 0) + Number(b);
  writeFileSync(S, json({ epoch, commit: a, spent }), { mode: 0o600 });
  out({ epoch, spent });
} else throw new Error('usage: prove.mjs init <payee> | pay <cents> <nonce> [epoch] | advance <newCommit> <cents>');
