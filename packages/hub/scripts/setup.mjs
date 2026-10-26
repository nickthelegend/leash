// One-time on-chain setup for LEASH Hub on Mezo testnet (idempotent):
//   - each provider agent gets a little BTC for gas and a 10 MEZO bond in LeashClawback
//   - the hub owner's hidden policy (the three providers allowlisted, 1 MUSD per job, 50 MUSD per day) is created
//     with random salts and registered with the arbiter and a MUSD escrow
// Keys come from the env file named by HUB_ENV (default contracts/.env.mezo); none are printed.
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEther } from 'viem';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
for (const line of readFileSync(process.env.HUB_ENV ?? join(root, 'contracts/.env.mezo'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { MEZO, pub, signer, clawbackAbi, erc20Abi } = await import('../src/chain.mjs');
const { AGENTS } = await import('../src/agents.mjs');
const { initPolicy } = await import('../src/policy.mjs');

const owner = signer(process.env.MEZO_DEPLOYER_KEY);
const arbiter = process.env.MEZO_ARBITER_ADDRESS;
const ESCROW = parseEther(process.env.HUB_ESCROW_MUSD ?? '60');
const BOND = 10n * 10n ** 18n;
const read = (functionName, args) => pub.readContract({ address: MEZO.leashClawback, abi: clawbackAbi, functionName, args });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

for (const a of AGENTS) {
  const addr = process.env[a.addressEnv];
  const prov = signer(process.env[a.keyEnv]);
  if (prov.address.toLowerCase() !== addr.toLowerCase()) throw new Error(`${a.id}: key does not match address`);
  if ((await pub.getBalance({ address: addr })) < parseEther('0.00005')) {
    const { hash } = await owner.sendValue(addr, parseEther('0.0002')); log(a.id, 'gas funded', hash);
  }
  const bond = await read('bondOf', [addr]);
  if (bond < BOND) {
    const need = BOND - bond;
    const bal = await pub.readContract({ address: MEZO.mezo, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
    if (bal < need) { const { hash } = await owner.write({ address: MEZO.mezo, abi: erc20Abi, functionName: 'transfer', args: [addr, need - bal] }); log(a.id, 'MEZO sent', hash); }
    await prov.write({ address: MEZO.mezo, abi: erc20Abi, functionName: 'approve', args: [MEZO.leashClawback, need] });
    const { hash } = await prov.write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'bond', args: [need] });
    log(a.id, 'bonded', need / 10n ** 18n, 'MEZO', hash);
  }
  log(a.id, addr, 'bond', (await read('bondOf', [addr])) / 10n ** 18n, 'MEZO');
}

const { commitment } = initPolicy(AGENTS.map((a) => ({ name: a.id, payee: process.env[a.addressEnv] })));
const policyId = await read('policyIdOf', [owner.address, commitment]);
if ((await read('policyOwner', [policyId])) === '0x0000000000000000000000000000000000000000') {
  await owner.write({ address: MEZO.musd, abi: erc20Abi, functionName: 'approve', args: [MEZO.leashClawback, ESCROW] });
  const { hash } = await owner.write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'registerPolicy', args: [commitment, arbiter, ESCROW] });
  log('hub policy registered', commitment, hash);
}
log('policy', commitment, 'escrow', Number(await read('policyBalance', [policyId])) / 1e18, 'MUSD; arbiter', arbiter);
