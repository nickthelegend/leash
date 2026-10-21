#!/usr/bin/env node
// Writes the real UltraHonk (EVM target) proofs the forge tests run against, one directory per case
// under contracts/test/fixtures/. Called by scripts/gen-proof-fixture.sh after it regenerates the
// verifier and keys; uses @leash/core's prover (nargo + bb) and checks every proof with bb verify.
const fs = require('fs');
const path = require('path');
const core = require('../packages/core/dist');

const OUT = path.resolve(__dirname, '../contracts/test/fixtures');
const EPOCH = 20747; // 2026-10-21 UTC; the tests vm.warp to this day
const RECIPIENT = '0x1234567890123456789012345678901234567890';
const ATTACKER = '0x000000000000000000000000000000000000dead';

const victim = core.createSpendingPolicy({
  name: 'fixture',
  maxPerTxCents: 500,
  dailyCapCents: 500,
  merchants: [{ name: 'fixture-merchant', payee: RECIPIENT }],
  policySalt: '987654321',
  spendSalt: '55555',
});
// The attacker's own policy lists the same merchant with the attacker as payee.
const attacker = core.createSpendingPolicy({
  name: 'attacker',
  maxPerTxCents: 500,
  dailyCapCents: 500,
  merchants: [{ name: 'fixture-merchant', payee: ATTACKER }],
  policySalt: '1111',
  spendSalt: '2222',
});

function write(name, policy, amountCents, nonce, spend) {
  const proof = core.generatePaymentProof({ policy, merchantName: 'fixture-merchant', amountCents, nonce, spend, useEvmTarget: true });
  const check = core.verifyPaymentProof({ proofHex: proof.proofHex, publicInputsHex: proof.publicInputsHex, useEvmTarget: true });
  if (!check.valid) throw new Error(`${name}: bb verify failed: ${check.error}`);
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'proof'), Buffer.from(proof.proofHex.slice(2), 'hex'));
  fs.writeFileSync(path.join(dir, 'public_inputs'), Buffer.from(proof.publicInputsHex.slice(2), 'hex'));
  console.log(`${name.padEnd(9)} amount ${amountCents} nonce ${nonce} epoch ${spend.epoch} prev ${spend.prevSpendCommit.slice(0, 10)}… -> new ${proof.publicInputs.new_spend_commit.slice(0, 10)}…`);
  return proof;
}

const fresh = (epoch) => ({ epoch, prevSpendCommit: '0', spentBeforeCents: 0 });
const base = write('base', victim, 300, 1, fresh(EPOCH));
write('second', victim, 200, 2, { epoch: EPOCH, prevSpendCommit: base.publicInputs.new_spend_commit, spentBeforeCents: 300 });
write('parallel', victim, 300, 3, fresh(EPOCH)); // built on the same prev as base
write('nextday', victim, 300, 4, fresh(EPOCH + 1));
write('attacker', attacker, 300, 1, fresh(EPOCH));
console.log(`fixtures written to ${OUT}`);
