/**
 * The agent's side of the walk, on the real local chain: leash-mcp (the MCP server an agent uses) is
 * driven over MCP stdio by a plain client, no LLM. Same policy and nonces as the recorded run on the
 * landing: 300 cents to openai's bound payee (Anvil #1) from the owner's escrow via a relayer that
 * sends no value, then the four refusals and the redirected proof. The landing quotes these errors
 * verbatim, so they are compared to the live output here.
 * Also: the verify-only gateway's owner-signed (EIP-191) registration, signed by the Anvil node.
 */
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SNAPS, SUMCHECKS, RUN } from '../apps/web/lib/recordedRun';

const ROOT = path.resolve(__dirname, '..');
const RUNDIR = path.resolve(ROOT, process.env.LEASH_E2E_RUN_DIR ?? 'e2e/.run');
const mcpRequire = createRequire(path.join(ROOT, 'packages/leash-mcp/package.json'));
const { Client } = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');

const GATEWAY = `http://127.0.0.1:${process.env.LEASH_E2E_GATEWAY_PORT ?? 3108}`;
const PAYEE = RUN.payee; // Anvil #1, openai's listed payee
const ATTACKER = RUN.attacker; // Anvil #2
const OWNER = RUN.owner; // Anvil #0
const RELAYER = RUN.relayer; // Anvil #9

function anvilEnv(): Record<string, string> {
  const file = path.join(RUNDIR, 'anvil.env');
  if (!fs.existsSync(file)) throw new Error('e2e/.run/anvil.env missing: run e2e/stack.sh start first');
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
}

const env = anvilEnv();
const rpc = env.LEASH_RPC_URL;
const cast = (...args: string[]) => execFileSync('cast', [...args, '--rpc-url', rpc], { encoding: 'utf8' }).trim();
const balance = (a: string) => BigInt(cast('balance', a));
const policyId = () => cast('call', env.LEASH_PAYMENT_CONTRACT_ADDRESS, 'policyIdOf(address,bytes32)(bytes32)', OWNER, RUN.commitment);
const escrow = () => BigInt(cast('call', env.LEASH_PAYMENT_CONTRACT_ADDRESS, 'policyBalance(bytes32)(uint256)', policyId()).split(' ')[0]);

async function rpcCall(method: string, params: unknown[]) {
  const res = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result!;
}

test.describe.configure({ mode: 'serial' });

let client: InstanceType<typeof Client>;
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content.map((c) => c.text).join('\n');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // plain-text error
  }
  return { isError: Boolean(r.isError), text, json };
}

test.beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'packages/leash-mcp/dist/index.js')],
    cwd: ROOT,
    env: {
      ...(process.env as Record<string, string>),
      ...env,
      PATH: `${path.join(ROOT, '.tools')}:${process.env.PATH}`,
      LEASH_HOME: path.join(RUNDIR, 'leash-home'),
      LEASH_MCP_LOG: path.join(RUNDIR, 'leash-mcp.log'),
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'leash-e2e', version: '1.0.0' });
  await client.connect(transport);
});

test.afterAll(async () => {
  await client?.close();
});

test('leash-mcp lists its tools and reports a healthy prover/verifier', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(
    ['leash_execute_onchain', 'leash_pay_paypal', 'leash_policy', 'leash_receipt', 'leash_request_payment', 'leash_verifier_health'].sort()
  );
  const health = await call('leash_verifier_health');
  expect(health.isError, health.text).toBe(false);
  const policy = await call('leash_policy');
  expect(policy.text).toContain(RUN.commitment);
  // Registered on chain by the owner, escrow funded in the same call
  expect(cast('call', env.LEASH_PAYMENT_CONTRACT_ADDRESS, 'registeredPolicies(bytes32)(bool)', policyId())).toBe('true');
  expect(cast('call', env.LEASH_PAYMENT_CONTRACT_ADDRESS, 'policyOwner(bytes32)(address)', policyId()).toLowerCase()).toBe(OWNER.toLowerCase());
  expect(escrow()).toBe(2000n);
});

test('300 cents to openai: proved, verified, released on Anvil from escrow by a relayer that sends no value', async () => {
  const payee0 = balance(PAYEE);
  const relayer0 = balance(RELAYER);
  const proof = await call('leash_request_payment', { merchant: 'openai', amountCents: 300, nonce: '3001' });
  expect(proof.isError, proof.text).toBe(false);
  expect(proof.text).toMatch(/verified|valid/i);
  const sent = await call('leash_execute_onchain', { nonce: '3001' });
  expect(sent.isError, sent.text).toBe(false);
  expect(sent.json.released).toBe(true);
  expect(sent.json.amountCents).toBe(300);
  expect(sent.json.recipient.toLowerCase()).toBe(PAYEE.toLowerCase());
  expect(sent.json.paidFrom).toContain('policy escrow');
  expect(balance(PAYEE) - payee0).toBe(300n);
  expect(escrow()).toBe(1700n);
  // The relayer paid gas only: it lost less than it would have if it had sent 300 wei of value plus gas,
  // and the tx itself carried no value.
  const tx = JSON.parse(cast('tx', sent.json.txHash, '--json'));
  expect(BigInt(tx.value)).toBe(0n);
  expect(tx.from.toLowerCase()).toBe(RELAYER.toLowerCase());
  expect(relayer0 - balance(RELAYER)).toBeGreaterThan(0n);
  const logs = JSON.parse(cast('receipt', sent.json.txHash, '--json')).logs as unknown[];
  expect(logs.length).toBeGreaterThan(0);

  const receipt = await call('leash_receipt', { nonce: '3001' });
  expect(receipt.isError, receipt.text).toBe(false);
  expect(receipt.json.receipts[0]).toMatchObject({ amountCents: 300, rail: 'evm', status: 'COMPLETED', txHash: sent.json.txHash });
});

test('over the per-payment cap: 900 cents is refused before proving (landing text is the live error)', async () => {
  const r = await call('leash_request_payment', { merchant: 'openai', amountCents: 900, nonce: '3002' });
  expect(r.isError).toBe(true);
  expect(r.text).toContain(SNAPS[0].error);
});

test('attacker payee: the circuit has no witness for (openai, 0x3C44…93BC)', async () => {
  const r = await call('leash_request_payment', { merchant: 'openai', amountCents: 200, nonce: '3003', recipient: ATTACKER });
  expect(r.isError).toBe(true);
  expect(r.text).toContain(SNAPS[1].error);
  const s = await call('leash_execute_onchain', { nonce: '3003' });
  expect(s.isError).toBe(true);
  expect(s.text).toMatch(/No proof for nonce '3003'/);
});

test('daily cap: 500 more cents after 300 today (800 > 700) has no witness', async () => {
  const r = await call('leash_request_payment', { merchant: 'openai', amountCents: 500, nonce: '3004' });
  expect(r.isError).toBe(true);
  expect(r.text).toContain(SNAPS[2].error);
});

test('replay: the released 3001 proof is rejected on chain (nonce already used)', async () => {
  const payee0 = balance(PAYEE);
  const r = await call('leash_execute_onchain', { nonce: '3001' });
  expect(r.isError).toBe(true);
  expect(r.text).toContain(SNAPS[3].error);
  expect(balance(PAYEE)).toBe(payee0);
});

test('a valid 200-cent proof redirected to the attacker fails on-chain verification (SumcheckFailed)', async () => {
  const attacker0 = balance(ATTACKER);
  const proof = await call('leash_request_payment', { merchant: 'openai', amountCents: 200, nonce: '3005' });
  expect(proof.isError, proof.text).toBe(false);
  const r = await call('leash_execute_onchain', { nonce: '3005', recipient: ATTACKER });
  expect(r.isError).toBe(true);
  expect(r.text).toContain(SUMCHECKS[0].error);
  expect(balance(ATTACKER)).toBe(attacker0);
  expect(escrow()).toBe(1700n);
});

test('the 3001 receipt re-verifies offline (pnpm verify:receipt)', async () => {
  const out = execFileSync('pnpm', ['-s', 'verify:receipt', '3001', '--owner', OWNER], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(ROOT, '.tools')}:${process.env.PATH}`, LEASH_HOME: path.join(RUNDIR, 'leash-home') },
  });
  expect(out).not.toMatch(/FAIL/);
  for (const check of ['bb verify', 'amount 300 cents', 'nonce 3001']) expect(out).toContain(check);
});

test('gateway registration needs the owner EIP-191 signature (signed by the Anvil node, no key handled)', async ({ request }) => {
  const commitment = RUN.commitment;
  const q = `owner=${OWNER}&policyCommitment=${commitment}&approvalThresholdCents=300`;
  const m = await (await request.get(`${GATEWAY}/api/policies/message?${q}`)).json();
  expect(m.message).toContain('LEASH gateway registration');

  // No signature: 401, and the message to sign comes back
  const unsigned = await request.post(`${GATEWAY}/api/policies`, { data: { owner: OWNER, policyCommitment: commitment, approvalThresholdCents: 300 } });
  expect(unsigned.status()).toBe(401);

  const hexMsg = '0x' + Buffer.from(m.message, 'utf8').toString('hex');
  // Signed by someone else (Anvil #1): refused
  const wrongSig = await rpcCall('personal_sign', [hexMsg, PAYEE]);
  const wrong = await request.post(`${GATEWAY}/api/policies`, {
    data: { owner: OWNER, policyCommitment: commitment, approvalThresholdCents: 300, version: m.version, signature: wrongSig },
  });
  expect(wrong.status()).toBe(401);
  expect((await wrong.json()).error).toMatch(/not from the policy owner/);

  // Signed by the owner: registered
  const sig = await rpcCall('personal_sign', [hexMsg, OWNER]);
  const ok = await request.post(`${GATEWAY}/api/policies`, {
    data: { owner: OWNER, policyCommitment: commitment, approvalThresholdCents: 300, version: m.version, signature: sig },
  });
  expect(ok.status(), await ok.text()).toBe(200);
  const reg = (await ok.json()).policy;
  expect(reg.policyId).toBe(policyId().toLowerCase());
  expect(reg.version).toBe(m.version);

  // Replaying the same signed registration: refused (version must increase)
  const replay = await request.post(`${GATEWAY}/api/policies`, {
    data: { owner: OWNER, policyCommitment: commitment, approvalThresholdCents: 300, version: m.version, signature: sig },
  });
  expect(replay.status()).toBe(409);

  // The console (same state dir) lists it
  const consolePolicies = await (await request.get('/api/policies')).json();
  expect(consolePolicies.policies.map((p: { policyId: string }) => p.policyId)).toContain(reg.policyId);
  expect(consolePolicies.paypal.configured).toBe(false);
});

/**
 * A proof that lands without leash-mcp advancing its spend record (a relayer submitted it, or `cast send`
 * timed out after the tx was mined), followed by a leash-mcp restart, must not lock the policy until UTC
 * midnight: the next proof reconciles from the pending spend this device recorded when it proved.
 * A second owner (Anvil #3) registers the same demo commitment as its own policy, so this spend chain and
 * its receipts (own LEASH_HOME) are separate from the walk above that the console specs read.
 */
test('a proof landed outside leash-mcp, then a restart: the next proof reconciles (spent_before 100), no lock-out', async () => {
  const OWNER3 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'; // Anvil #3
  const contract = env.LEASH_PAYMENT_CONTRACT_ADDRESS;
  cast('send', contract, 'registerPolicy(bytes32)', RUN.commitment, '--value', '1000', '--unlocked', '--from', OWNER3);
  const id3 = cast('call', contract, 'policyIdOf(address,bytes32)(bytes32)', OWNER3, RUN.commitment);
  const home3 = path.join(RUNDIR, 'leash-home-reconcile');
  fs.mkdirSync(home3, { recursive: true });
  const start = async () => {
    const c = new Client({ name: 'leash-e2e-reconcile', version: '1.0.0' });
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, 'packages/leash-mcp/dist/index.js')],
        cwd: ROOT,
        env: { ...(process.env as Record<string, string>), ...env, LEASH_POLICY_OWNER_ADDRESS: OWNER3, PATH: `${path.join(ROOT, '.tools')}:${process.env.PATH}`, LEASH_HOME: home3 },
        stderr: 'pipe',
      })
    );
    const callOn = async (name: string, args: Record<string, unknown>) => {
      const r = (await c.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      const text = r.content.map((x) => x.text).join('\n');
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // plain-text error
      }
      return { isError: Boolean(r.isError), text, json };
    };
    return { c, callOn };
  };

  let mcp = await start();
  const first = await mcp.callOn('leash_request_payment', { merchant: 'openai', amountCents: 100, nonce: '4001' });
  expect(first.isError, first.text).toBe(false);
  expect(first.json.spentTodayBeforeCents).toBe(0);
  // Land it directly, the way a relayer would; leash-mcp never sees the result.
  const pi = first.json.publicInputs;
  const b32 = (dec: string) => '0x' + BigInt(dec).toString(16).padStart(64, '0');
  const payee0 = balance(PAYEE);
  cast(
    'send', contract,
    'executePayment(address,bytes32,uint256,bytes32,bytes32,address,(uint64,bytes32,bytes32),bytes)',
    OWNER3, pi.policy_commitment, pi.amount, pi.merchant_id_hash, b32(pi.nonce), pi.recipient,
    `(${pi.epoch},${pi.prev_spend_commit},${pi.new_spend_commit})`, first.json.proofHex,
    '--unlocked', '--from', RELAYER
  );
  expect(balance(PAYEE) - payee0).toBe(100n);
  expect(cast('call', contract, 'spendCommit(bytes32)(bytes32)', id3).toLowerCase()).toBe(pi.new_spend_commit);
  await mcp.c.close(); // leash-mcp restarts: its in-memory proofs are gone

  mcp = await start();
  try {
    const next = await mcp.callOn('leash_request_payment', { merchant: 'openai', amountCents: 100, nonce: '4002' });
    expect(next.isError, next.text).toBe(false);
    expect(next.json.spentTodayBeforeCents).toBe(100);
    expect(next.json.publicInputs.prev_spend_commit).toBe(pi.new_spend_commit);
    const sent = await mcp.callOn('leash_execute_onchain', { nonce: '4002' });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.json.released).toBe(true);
    expect(sent.json.spentTodayCents).toBe(200);
    expect(balance(PAYEE) - payee0).toBe(200n);
  } finally {
    await mcp.c.close();
  }
});
