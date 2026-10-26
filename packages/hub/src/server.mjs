// LEASH Hub API: chat with AI agents on Mezo testnet. Every message is a real job in LeashClawback:
//   prove (LEASH ZK policy) -> openJob (MUSD into escrow) -> the agent answers (a real LLM) -> deliver (result hash)
//   -> the user accepts (paid) or disputes ("wrong, refund me") -> an AI arbiter judges -> resolve on chain
//      (refund: MUSD back to the hub escrow + 5 MEZO slashed from the agent's bond).
// Undisputed deliveries are released after the dispute window; undelivered jobs are clawed back after the deadline.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { keccak256, toHex, stringToHex } from 'viem';

for (const f of [process.env.HUB_ENV].filter(Boolean)) {
  for (const line of readFileSync(f, 'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
}
const { MEZO, pub, signer, clawbackAbi, erc20Abi, jobIdFromReceipt } = await import('./chain.mjs');
const { AGENTS, ARBITER_SYSTEM } = await import('./agents.mjs');
const { loadPolicy, prove, spentToday, POLICY_SHAPE, STATE } = await import('./policy.mjs');
const { mezoFacts } = await import('./mezoLive.mjs');

const PORT = Number(process.env.PORT ?? 8787);
const LLM_URL = process.env.HUB_LLM_URL ?? 'https://text.pollinations.ai/openai';
const LLM_MODEL = process.env.HUB_LLM_MODEL ?? 'openai-fast';
const DELIVERY_WINDOW = 300n; // seconds an agent has to deliver
const ORIGINS = (process.env.HUB_ALLOWED_ORIGINS ?? '*').split(',');
const DATA = process.env.HUB_DATA_DIR ?? join(STATE, '..', 'data');
mkdirSync(DATA, { recursive: true });
const DB = join(DATA, 'requests.json');

const owner = signer(process.env.MEZO_DEPLOYER_KEY);
const relayer = signer(process.env.MEZO_AGENT_KEY);
const arbiter = signer(process.env.MEZO_ARBITER_KEY);
const providers = Object.fromEntries(AGENTS.map((a) => [a.id, signer(process.env[a.keyEnv])]));
const { policy, commitment } = loadPolicy();
const policyId = await pub.readContract({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'policyIdOf', args: [owner.address, commitment] });
const DISPUTE_WINDOW = Number(await pub.readContract({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'disputeWindow' }));
const MIN_BOND = await pub.readContract({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'minBond' });

// ---------------------------------------------------------------- state
let requests = existsSync(DB) ? JSON.parse(readFileSync(DB, 'utf8')) : [];
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeFileSync(DB, JSON.stringify(requests)), 200); };
const byId = (id) => requests.find((r) => r.id === id);
const now = () => Math.floor(Date.now() / 1000);
const TERMINAL = new Set(['paid', 'clawed_back', 'released', 'failed']);
const pubView = (r) => {
  const { ip, ...rest } = r; return rest;
};
const set = (r, patch) => { Object.assign(r, patch, { updatedAt: now() }); save(); };

// ---------------------------------------------------------------- LLM
async function llm(system, user, { json = false } = {}) {
  const res = await fetch(LLM_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...(json ? { response_format: { type: 'json_object' } } : {}) }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('LLM returned no text');
  return text.trim();
}

// ---------------------------------------------------------------- the job pipeline
let proveChain = Promise.resolve(); // proofs + openJob run one at a time: the spend chain is sequential
const serial = (fn) => { const p = proveChain.then(fn, fn); proveChain = p.catch(() => {}); return p; };

async function ensureBond(agent) {
  const addr = providers[agent.id].address;
  const bond = await pub.readContract({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'bondOf', args: [addr] });
  if (bond >= MIN_BOND) return;
  const need = MIN_BOND + 5n * 10n ** 18n - bond; // back above the minimum with room for one slash
  await owner.write({ address: MEZO.mezo, abi: erc20Abi, functionName: 'transfer', args: [addr, need] });
  await providers[agent.id].write({ address: MEZO.mezo, abi: erc20Abi, functionName: 'approve', args: [MEZO.leashClawback, need] });
  await providers[agent.id].write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'bond', args: [need] });
}

async function runJob(r) {
  const agent = AGENTS.find((a) => a.id === r.agentId);
  try {
    await ensureBond(agent);
    const taskHash = keccak256(stringToHex(r.message));
    await serial(async () => {
      set(r, { status: 'proving' });
      const p = prove(policy, agent.id, providers[agent.id].address, r.priceCents, BigInt('0x' + randomBytes(12).toString('hex')).toString());
      set(r, { status: 'opening', proofMs: p.ms });
      const req = { owner: owner.address, policyCommitment: commitment, amountCents: BigInt(r.priceCents), merchantIdHash: p.merchantIdHash, nonce: p.nonce,
        provider: providers[agent.id].address, taskHash, deliveryWindow: DELIVERY_WINDOW };
      const { hash, receipt } = await relayer.write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'openJob', args: [req, p.spend, p.proof] });
      p.advance();
      set(r, { jobId: jobIdFromReceipt(receipt), txs: { ...r.txs, open: hash }, deadline: now() + Number(DELIVERY_WINDOW) });
    });
    set(r, { status: 'thinking' });
    let system = agent.system;
    if (agent.liveMezo) {
      try { const f = await mezoFacts(); system += `\n\n${f.text} Use these exact live numbers when the question touches them, and say they are live from Mezo testnet at that block.`; set(r, { mezoBlock: f.block }); }
      catch (e) { system += '\n\n(Live Mezo data is unavailable right now; say so if the question needs it.)'; }
    }
    const answer = await llm(system, r.message);
    const resultHash = keccak256(stringToHex(answer));
    set(r, { status: 'delivering', answer, resultHash });
    const { hash } = await providers[agent.id].write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'deliver',
      args: [BigInt(r.jobId), resultHash, `leash-hub:${r.id}`] });
    set(r, { status: 'delivered', deliveredAt: now(), disputeUntil: now() + DISPUTE_WINDOW, txs: { ...r.txs, deliver: hash } });
  } catch (e) {
    // a job that opened but never delivered is clawed back by the sweeper once its deadline passes
    set(r, r.jobId ? { status: 'undelivered', error: `delivery failed: ${short(e)}` } : { status: 'failed', error: short(e) });
  }
}

async function accept(r) {
  if (r.status !== 'delivered') throw httpErr(409, `can't accept a ${r.status} request`);
  set(r, { status: 'accepting' });
  try {
    const { hash } = await owner.write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'accept', args: [BigInt(r.jobId)] });
    set(r, { status: 'paid', txs: { ...r.txs, accept: hash } });
  } catch (e) { set(r, { status: 'delivered', error: `accept failed: ${short(e)}` }); throw httpErr(502, r.error); }
}

async function dispute(r, reason) {
  if (r.status !== 'delivered') throw httpErr(409, `can't dispute a ${r.status} request`);
  if (now() > r.disputeUntil) throw httpErr(409, 'the dispute window has closed');
  set(r, { status: 'disputing', complaint: reason });
  try {
    const { hash } = await owner.write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'dispute', args: [BigInt(r.jobId), keccak256(stringToHex(reason || 'wrong answer'))] });
    set(r, { status: 'judging', txs: { ...r.txs, dispute: hash } });
  } catch (e) { set(r, { status: 'delivered', error: `dispute failed: ${short(e)}` }); throw httpErr(502, r.error); }
  judge(r); // the arbiter rules in the background; the client polls
}

async function judge(r) {
  try {
    let facts = '';
    try { facts = `\n\n${(await mezoFacts()).text}`; } catch { /* the arbiter still rules on the text */ }
    const raw = await llm(ARBITER_SYSTEM + facts, `Request: ${r.message}\n\nAgent's answer: ${r.answer}\n\nUser's complaint: ${r.complaint || 'The answer is wrong.'}`, { json: true });
    const m = raw.match(/\{[\s\S]*\}/);
    const v = JSON.parse(m ? m[0] : raw);
    const verdict = { refund: v.refund === true, reason: String(v.reason ?? '').slice(0, 300) };
    const { hash } = await arbiter.write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'resolve', args: [BigInt(r.jobId), verdict.refund] });
    set(r, { status: verdict.refund ? 'clawed_back' : 'released', verdict, txs: { ...r.txs, resolve: hash } });
  } catch (e) {
    set(r, { status: 'judging', error: `arbiter retrying: ${short(e)}` });
    setTimeout(() => judge(r), 15_000); // the job stays disputed on chain until the arbiter rules
  }
}

// release undisputed deliveries after the window; claw back jobs never delivered after their deadline
setInterval(async () => {
  for (const r of requests) {
    try {
      if (r.status === 'delivered' && now() > r.disputeUntil + 2) {
        set(r, { status: 'releasing' });
        const { hash } = await relayer.write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'release', args: [BigInt(r.jobId)] });
        set(r, { status: 'released', txs: { ...r.txs, release: hash } });
      } else if (r.status === 'undelivered' && now() > r.deadline + 2) {
        const { hash } = await relayer.write({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'clawback', args: [BigInt(r.jobId)] });
        set(r, { status: 'clawed_back', verdict: { refund: true, reason: 'The agent never delivered before the deadline.' }, txs: { ...r.txs, clawback: hash } });
      }
    } catch (e) { if (r.status === 'releasing') set(r, { status: 'delivered', error: `release retry: ${short(e)}` }); }
  }
}, 10_000);

// ---------------------------------------------------------------- HTTP
const short = (e) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 240);
const httpErr = (code, msg) => Object.assign(new Error(msg), { code });
const rate = new Map(); // key -> timestamps
function limited(key, n, windowSec) {
  const t = now(); const xs = (rate.get(key) ?? []).filter((x) => x > t - windowSec);
  if (xs.length >= n) return true; xs.push(t); rate.set(key, xs); return false;
}

async function stats() {
  const done = requests.filter((r) => r.jobId);
  const claws = requests.filter((r) => r.status === 'clawed_back');
  const escrowWei = await pub.readContract({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'policyBalance', args: [policyId] });
  return {
    escrowWei: escrowWei.toString(),
    stats: { jobs: done.length, paid: requests.filter((r) => r.status === 'paid' || r.status === 'released').length, clawedBack: claws.length,
      musdReturnedWei: (claws.reduce((s, r) => s + BigInt(r.priceCents), 0n) * 10n ** 16n).toString(), mezoSlashedWei: (BigInt(claws.length) * 5n * 10n ** 18n).toString() },
  };
}

const routes = {
  'GET /api/health': async () => ({ ok: true }),
  'GET /api/mezo': async () => { const { text, ...f } = await mezoFacts(); return f; },
  'GET /api/hub': async () => ({ chainId: MEZO.chainId, contract: MEZO.leashClawback, verifier: MEZO.verifier, owner: owner.address, relayer: relayer.address,
    arbiter: arbiter.address, policyCommitment: commitment, policyId, disputeWindowSec: DISPUTE_WINDOW, deliveryWindowSec: Number(DELIVERY_WINDOW),
    explorer: MEZO.explorer, musd: MEZO.musd, mezo: MEZO.mezo, policy: { maxPerJobCents: POLICY_SHAPE.maxPerTxCents, dailyCapCents: POLICY_SHAPE.dailyCapCents, spentTodayCents: spentToday() },
    ...(await stats()) }),
  'GET /api/agents': async () => Promise.all(AGENTS.map(async (a) => ({
    id: a.id, name: a.name, tagline: a.tagline, description: a.description, priceCents: a.priceCents, style: a.style, model: LLM_MODEL,
    address: providers[a.id].address,
    bondWei: (await pub.readContract({ address: MEZO.leashClawback, abi: clawbackAbi, functionName: 'bondOf', args: [providers[a.id].address] })).toString(),
    stats: { paid: requests.filter((r) => r.agentId === a.id && (r.status === 'paid' || r.status === 'released')).length,
      clawedBack: requests.filter((r) => r.agentId === a.id && r.status === 'clawed_back').length },
  }))),
  'GET /api/feed': async () => requests.slice(-30).reverse().map((r) => ({ id: r.id, agentId: r.agentId, priceCents: r.priceCents, status: r.status, txs: r.txs, ts: r.createdAt })),
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  const allow = ORIGINS.includes('*') ? '*' : (ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin) ? origin : '');
  if (allow) { res.setHeader('access-control-allow-origin', allow); res.setHeader('vary', 'Origin'); }
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS'); res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    const url = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',')[0].trim();
    let body = {};
    if (req.method === 'POST') {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 8192) throw httpErr(413, 'body too large'); }
      body = raw ? JSON.parse(raw) : {};
    }
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return send(200, await routes[key]());
    if (key === 'POST /api/chat') {
      const agent = AGENTS.find((a) => a.id === body.agentId);
      if (!agent) throw httpErr(400, 'unknown agent');
      const message = String(body.message ?? '').trim();
      if (!message || message.length > 500) throw httpErr(400, 'message must be 1-500 characters');
      const sessionId = String(body.sessionId ?? '').slice(0, 64);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) throw httpErr(400, 'bad sessionId');
      if (limited(`ip:${ip}`, 12, 600) || limited(`s:${sessionId}`, 10, 600)) throw httpErr(429, 'Slow down: at most 10 messages per 10 minutes on the shared demo account.');
      if (spentToday() + agent.priceCents > POLICY_SHAPE.dailyCapCents) throw httpErr(429, 'The hub has reached its 50 MUSD daily cap (enforced by the LEASH proof). Try again after 00:00 UTC.');
      const r = { id: randomBytes(8).toString('hex'), sessionId, agentId: agent.id, message, priceCents: agent.priceCents, status: 'queued', txs: {}, createdAt: now(), ip };
      requests.push(r); save();
      runJob(r);
      return send(202, { requestId: r.id });
    }
    let m;
    if ((m = url.pathname.match(/^\/api\/requests\/([0-9a-f]{16})$/)) && req.method === 'GET') {
      const r = byId(m[1]); if (!r) throw httpErr(404, 'no such request'); return send(200, pubView(r));
    }
    if ((m = url.pathname.match(/^\/api\/requests\/([0-9a-f]{16})\/(accept|dispute)$/)) && req.method === 'POST') {
      const r = byId(m[1]); if (!r) throw httpErr(404, 'no such request');
      if (r.sessionId !== String(body.sessionId ?? r.sessionId)) throw httpErr(403, 'not your request');
      if (m[2] === 'accept') await accept(r); else await dispute(r, String(body.reason ?? '').slice(0, 300));
      return send(200, pubView(r));
    }
    if ((m = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{8,64})$/)) && req.method === 'GET') {
      return send(200, requests.filter((r) => r.sessionId === m[1]).map(pubView));
    }
    throw httpErr(404, 'not found');
  } catch (e) {
    send(e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: short(e) });
  }
});

// requests interrupted by a restart: resume what can be resumed
for (const r of requests) {
  if (r.status === 'judging' || r.status === 'disputing') judge(r);
  if (['queued', 'proving', 'opening'].includes(r.status) && !r.jobId) set(r, { status: 'failed', error: 'interrupted by a server restart before the job opened' });
  if (['thinking', 'delivering'].includes(r.status) && r.jobId) set(r, { status: 'undelivered', error: 'interrupted by a server restart; will be clawed back after the deadline' });
}
server.listen(PORT, () => console.log(`LEASH Hub API on :${PORT}  contract ${MEZO.leashClawback}  policy ${commitment}  dispute window ${DISPUTE_WINDOW}s`));
