// Real proofs for the Mezo contract tests: a public demo policy whose one merchant pays MEZO_PAYEE_ADDRESS,
// $5.00 per payment, $15.00 per day, then two chained payments for today's UTC epoch (300 then 400 cents).
//   node packages/mezo/scripts/gen-fixtures.mjs <payee> [epoch]
// Writes contracts/test/fixtures/mezo-{pay1,pay2}/{proof,public_inputs} and mezo-policy.json (public: demo salts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.PATH = `${join(root, '.tools')}:${process.env.PATH}`;
const core = await import(join(root, 'packages/core/dist/index.js'));
const [payee, epochArg] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(payee ?? '')) throw new Error('usage: gen-fixtures.mjs <payee address> [epoch]');
const epoch = epochArg ? Number(epochArg) : core.currentEpoch();

export const policy = core.createSpendingPolicy({
  name: 'mezo-demo', maxPerTxCents: 500, dailyCapCents: 1500,
  merchants: [{ name: 'mezo-merchant', payee }],
  policySalt: '424242', spendSalt: '434343', // public fixture salts; a live owner uses random ones
});
const out = join(root, 'contracts/test/fixtures');
const write = (name, r) => {
  const dir = join(out, name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proof'), Buffer.from(r.proofHex.replace(/^0x/, ''), 'hex'));
  writeFileSync(join(dir, 'public_inputs'), Buffer.from(r.publicInputsHex.replace(/^0x/, ''), 'hex'));
  console.log(name, r.publicInputs.amount ?? '', `${r.durationMs} ms`);
};
const p1 = core.generatePaymentProof({ policy, merchantName: 'mezo-merchant', amountCents: 300, nonce: '1001', recipient: payee, useEvmTarget: true, spend: { epoch, prevSpendCommit: '0', spentBeforeCents: 0 } });
write('mezo-pay1', p1);
const p2 = core.generatePaymentProof({ policy, merchantName: 'mezo-merchant', amountCents: 400, nonce: '1002', recipient: payee, useEvmTarget: true, spend: { epoch, prevSpendCommit: p1.publicInputs.new_spend_commit, spentBeforeCents: 300 } });
write('mezo-pay2', p2);
writeFileSync(join(out, 'mezo-policy.json'), JSON.stringify({ epoch, payee, commitment: policy.policyCommitment, maxPerTxCents: 500, dailyCapCents: 1500 }, null, 2) + '\n');
console.log('commitment', policy.policyCommitment, 'epoch', epoch);
