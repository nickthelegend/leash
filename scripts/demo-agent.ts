#!/usr/bin/env tsx
/**
 * `pnpm demo:agent`: the recorded agent run, replayed live with no LLM. A plain MCP stdio client drives
 * leash-mcp (the same server an agent uses) against the `pnpm demo:anvil` chain: one 300-cent release to
 * openai's bound payee from the owner's escrow, then the six refusals of the 2026-10-21 recording
 * (per-payment cap, attacker payee, daily cap, replay, a redirected proof and a direct cast send that
 * claims 900 cents with a 200-cent proof), `verify:receipt 3001`, and the balances. Each refusal is
 * compared with apps/web/lib/recordedRun.ts. Everything printed is program output; nothing is canned.
 *
 *   pnpm demo:anvil && pnpm demo:agent      then: kill "$(cat .demo/anvil.pid)"
 * LEASH_DEMO_DIR (default .demo) picks the chain demo:anvil wrote. Exits 1 if anything differs.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { RUN, SNAPS, SUMCHECKS, short } from '../apps/web/lib/recordedRun';

const ROOT = path.resolve(__dirname, '..');
const DEMO_DIR = path.resolve(ROOT, process.env.LEASH_DEMO_DIR ?? '.demo');
const mcpRequire = createRequire(path.join(ROOT, 'packages/leash-mcp/package.json'));
const { Client } = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const envFile = path.join(DEMO_DIR, 'anvil.env');
if (!fs.existsSync(envFile)) die(`No demo chain: ${path.relative(ROOT, envFile)} is missing. Run pnpm demo:anvil first.`);
const env: Record<string, string> = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
const mcpEntry = path.join(ROOT, 'packages/leash-mcp/dist/index.js');
if (!fs.existsSync(mcpEntry)) die('leash-mcp is not built: run pnpm --filter @leash/core build && pnpm --filter @leash/mcp build');

const PATH = `${path.join(ROOT, '.tools')}:${process.env.PATH}`;
const rpc = env.LEASH_RPC_URL;
const contract = env.LEASH_PAYMENT_CONTRACT_ADDRESS;
const OWNER = env.LEASH_POLICY_OWNER_ADDRESS;
const RELAYER = env.LEASH_SENDER_ADDRESS;
const cast = (...args: string[]) => execFileSync('cast', [...args, '--rpc-url', rpc], { encoding: 'utf8', env: { ...process.env, PATH }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const balance = (a: string) => BigInt(cast('balance', a));

async function main(): Promise<void> {
  try {
    cast('chain-id');
  } catch {
    die(`The demo chain at ${rpc} is not answering. Run pnpm demo:anvil first.`);
  }
  const home = path.join(DEMO_DIR, 'leash-home');
  fs.mkdirSync(home, { recursive: true });
  const client = new Client({ name: 'leash-demo-agent', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [mcpEntry],
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), ...env, PATH, LEASH_HOME: home, LEASH_MCP_LOG: path.join(DEMO_DIR, 'demo-agent-mcp.log') },
      stderr: 'pipe',
    })
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = r.content.map((c) => c.text).join('\n');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // plain-text refusal
    }
    return { isError: Boolean(r.isError), text, json };
  };

  try {
    const policy = (await call('leash_policy')).json;
    const policyId = cast('call', contract, 'policyIdOf(address,bytes32)(bytes32)', OWNER, policy.policyCommitment);
    if (cast('call', contract, 'usedNonces(bytes32,bytes32)(bool)', policyId, '0x' + (3001).toString(16).padStart(64, '0')) === 'true') {
      die(`This chain already ran the demo (nonce 3001 is used). Start a fresh one: kill "$(cat ${path.relative(ROOT, DEMO_DIR)}/anvil.pid)" && pnpm demo:anvil`);
    }
    const escrow = () => BigInt(cast('call', contract, 'policyBalance(bytes32)(uint256)', policyId).split(' ')[0]);
    const payee0 = balance(RUN.payee);
    const attacker0 = balance(RUN.attacker);
    const escrow0 = escrow();

    console.log('### LEASH demo:agent: leash-mcp driven by a plain MCP client (no LLM) on the demo:anvil chain');
    console.log(`### replays the recorded run of ${RUN.date} live; refusals are compared with apps/web/lib/recordedRun.ts`);
    console.log(`chain ${rpc}  LeashPayment ${contract}`);
    console.log(`policy commitment ${policy.policyCommitment}  owner ${OWNER}  escrow ${escrow0} wei  relayer ${RELAYER}`);
    console.log('### amounts are cents (300 = $3.00); the demo chain settles 1 cent as 1 wei\n');

    let released = 0;
    const refusals: { label: string; matches: boolean }[] = [];
    const refused = (n: number, label: string, got: { isError: boolean; text: string }, expected: string, same?: { test: (t: string) => boolean; note: string }) => {
      const line = got.text.split('\n')[0];
      const exact = got.text.includes(expected);
      const matches = got.isError && (exact || Boolean(same?.test(got.text)));
      refusals.push({ label, matches });
      const verdict = !matches ? `DIFFERS from the recording, which said: ${expected}` : exact ? 'matches the recording' : `matches the recording (${same!.note})`;
      console.log(`[${n}] REFUSED   ${label}\n      ${line}\n      ${verdict}`);
    };

    // 1. The legitimate payment
    const p1 = await call('leash_request_payment', { merchant: 'openai', amountCents: 300, nonce: '3001' });
    if (p1.isError || !p1.json?.approved) die(`[1] proof for 300 cents failed: ${p1.text}`);
    const s1 = await call('leash_execute_onchain', { nonce: '3001' });
    if (s1.isError || !s1.json?.released) die(`[1] release failed: ${s1.text}`);
    released++;
    console.log(
      `[1] RELEASED  nonce 3001: ${s1.json.amountCents} cents (${s1.json.amountWei} wei) to openai's payee ${short(s1.json.recipient)}, ` +
        `paid from ${s1.json.paidFrom}\n      proved in ${p1.json.proveMs} ms, verified by bb; tx ${s1.json.txHash} (block ${s1.json.block})`
    );

    // 2-5. The four snaps
    refused(2, `nonce 3002: ${SNAPS[0].request}`, await call('leash_request_payment', { merchant: 'openai', amountCents: 900, nonce: '3002' }), SNAPS[0].error);
    refused(3, `nonce 3003: ${SNAPS[1].request}`, await call('leash_request_payment', { merchant: 'openai', amountCents: 200, nonce: '3003', recipient: RUN.attacker }), SNAPS[1].error);
    refused(4, `nonce 3004: ${SNAPS[2].request}`, await call('leash_request_payment', { merchant: 'openai', amountCents: 500, nonce: '3004' }), SNAPS[2].error);
    refused(5, `nonce 3001: ${SNAPS[3].request}`, await call('leash_execute_onchain', { nonce: '3001' }), SNAPS[3].error);

    // 6. A valid 200-cent proof sent to the attacker
    const p6 = await call('leash_request_payment', { merchant: 'openai', amountCents: 200, nonce: '3005' });
    if (p6.isError || !p6.json?.approved) die(`[6] proof for 200 cents failed: ${p6.text}`);
    refused(6, `nonce 3005: ${SUMCHECKS[0].request}`, await call('leash_execute_onchain', { nonce: '3005', recipient: RUN.attacker }), SUMCHECKS[0].error);

    // 7. Bypass leash-mcp: the same 200-cent proof, sent with cast, claiming 900 cents
    const pi = p6.json.publicInputs;
    const b32 = (dec: string) => '0x' + BigInt(dec).toString(16).padStart(64, '0');
    let direct = { isError: false, text: '' };
    try {
      direct.text = cast(
        'send', contract,
        'executePayment(address,bytes32,uint256,bytes32,bytes32,address,(uint64,bytes32,bytes32),bytes)',
        OWNER, pi.policy_commitment, '900', pi.merchant_id_hash, b32(pi.nonce), pi.recipient,
        `(${pi.epoch},${pi.prev_spend_commit},${pi.new_spend_commit})`, p6.json.proofHex,
        '--unlocked', '--from', RELAYER
      );
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string };
      const out = [err.stderr, err.stdout].filter(Boolean).join('\n');
      const revert = out.split('\n').find((l) => /revert/i.test(l)) ?? out.split('\n')[0];
      direct = { isError: true, text: revert.replace(/^Error:\s*/, '').trim() };
    }
    // cast's own revert line, unedited. cast versions format it differently ("custom error 0x9fc3a218: SumcheckFailed"
    // in the recording, "custom error 0x9fc3a218, data: …: SumcheckFailed" in cast 1.7), so the selector is compared.
    refused(7, `nonce 3005: ${SUMCHECKS[1].request}`, direct, SUMCHECKS[1].error, {
      test: (t) => t.includes('execution reverted: custom error 0x9fc3a218') && t.includes('SumcheckFailed'),
      note: 'same revert, custom error 0x9fc3a218 = SumcheckFailed; this cast version words the line differently',
    });

    // Receipt, re-checked without trusting leash-mcp
    console.log('\n$ pnpm verify:receipt 3001 --owner ' + OWNER);
    const v = spawnSync(process.execPath, [require.resolve('tsx/cli'), path.join(ROOT, 'scripts/verify-receipt.ts'), '3001', '--owner', OWNER], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH, LEASH_HOME: home },
    });
    process.stdout.write(v.stdout.split('\n').map((l) => (l ? `      ${l}` : l)).join('\n'));
    const receiptOk = v.status === 0;

    const dPayee = balance(RUN.payee) - payee0;
    const dAttacker = balance(RUN.attacker) - attacker0;
    console.log(`\nbalances: openai's payee ${short(RUN.payee)} +${dPayee} wei, attacker ${short(RUN.attacker)} +${dAttacker} wei, escrow ${escrow0} -> ${escrow()} wei`);
    const matched = refusals.filter((r) => r.matches).length;
    console.log(`summary: ${released} release, ${refusals.length} refusals, ${matched} of ${refusals.length} refusal texts match the recording; verify:receipt ${receiptOk ? 'PASS' : 'FAIL'}`);
    const ok = released === 1 && refusals.length === 6 && matched === 6 && receiptOk && dPayee === 300n && dAttacker === 0n;
    if (!ok) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((e) => die(`demo:agent failed: ${(e as Error).message}`));
