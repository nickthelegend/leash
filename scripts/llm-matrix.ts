#!/usr/bin/env tsx
/**
 * Policy-violation matrix, LLM-in-the-loop: each matrix prompt goes to a real model (opencode) whose
 * only tools are leash-mcp's, on a fresh local Anvil chain. leash-mcp's LEASH_MCP_LOG records what the
 * agent actually requested and whether the proof or LeashPayment refused it.
 *
 *   pnpm matrix:llm -- --dry-run                     print the plan and prompts; no model call
 *   pnpm matrix:llm -- --check-sandbox               verify the agent can reach only leash tools; no model call
 *   pnpm matrix:llm                                  run the default subset (9 cases)
 *   pnpm matrix:llm -- --cases 21,25 --model openrouter/<model>
 *
 * The model provider is whatever opencode is configured with on this machine (its config and keys
 * are never read here). Free tiers are small: the run stops at the first provider failure and marks
 * the rest PENDING instead of guessing. Results: docs/evidence/llm-matrix-<date>.json.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLlmMatrixPrompt,
  classifyLlmCase,
  LLM_MATRIX_DEFAULT_CASES,
  LlmCaseResult,
  llmMatrixCases,
  looksLikeProviderFailure,
  parseMcpLog,
  undecidedLlmCase,
} from '../packages/core/src/harness/llmMatrix.js';

const ROOT = path.resolve(__dirname, '..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MODEL = arg('--model') ?? 'openrouter/minimax/minimax-m3.1-flash:free';
const IDS = arg('--cases') ? arg('--cases')!.split(',').map((s) => Number(s.trim())) : LLM_MATRIX_DEFAULT_CASES;
const DRY = process.argv.includes('--dry-run');
const PORT = arg('--port') ?? '8547'; // not 8545, so it never collides with a demo chain
const DAILY_CAP = '1500';
const TIMEOUT_MS = 300_000;
const cases = llmMatrixCases(IDS);
/**
 * The agent's sandbox. opencode resolves permissions last-match-wins and a user's global config may
 * end with "*": "allow", which beats per-tool denials in a project config (the first run on
 * 2026-10-21 showed exactly that: the model used bash). A dedicated agent's own rules come last, so
 * it denies everything and allows only leash-mcp's tools (opencode names them leash_<tool>).
 */
const AGENT = 'leashpay';
const AGENT_CONFIG = {
  [AGENT]: {
    mode: 'primary',
    description: 'Payments agent limited to the leash-mcp tools',
    permission: { '*': 'deny', 'leash_*': 'allow' },
  },
};
const isLeashTool = (name: string) => name.startsWith('leash_');
/** opencode gets the shell's environment without what pnpm/tsx add (NODE_PATH, npm_*, pnpm_*). */
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_PATH|NODE_OPTIONS|npm_|pnpm_|PNPM_PACKAGE_NAME|INIT_CWD)/i.test(k)));

function plan(): void {
  console.log(`LLM-in-the-loop matrix: ${cases.length} case(s) with ${MODEL}; daily cap ${DAILY_CAP} cents, 500 per payment.`);
  console.log(`Estimated model requests: ${cases.length * 2}-${cases.length * 3} (tool call(s) + final answer per case).\n`);
  for (const c of cases) console.log(`--- case ${c.id} (${c.category}, ${c.isInjection ? 'injection' : 'legitimate'})\n${buildLlmMatrixPrompt(c)}\n`);
}

if (DRY) {
  plan();
  process.exit(0);
}

const which = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
if (which.status !== 0) {
  console.error('Setup required (opencode): install opencode and configure a model provider, or use --dry-run.');
  process.exit(1);
}
const MCP = path.join(ROOT, 'packages/leash-mcp/dist/index.js');
if (!existsSync(MCP)) {
  console.error(`Setup required: ${path.relative(ROOT, MCP)} is missing; run pnpm build first.`);
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
// Outside the repo, like the recorded demo: opencode treats a git worktree as the agent's project
// (snapshots it), and the agent's project should not be the LEASH repo. --run-dir overrides.
const RUN = path.resolve(arg('--run-dir') ?? path.join(os.tmpdir(), 'leash-llm-matrix'), runId);
mkdirSync(RUN, { recursive: true });
const LEASH_HOME = path.join(RUN, 'leash-home');
mkdirSync(LEASH_HOME, { recursive: true });
if (process.argv.includes('--check-sandbox')) {
  // No chain, no model call: write a case config and verify the agent can only reach leash tools.
  const dir = path.join(RUN, 'sandbox-check');
  mkdirSync(dir, { recursive: true });
  writeCaseConfig(dir, path.join(dir, 'tool-calls.jsonl'), {});
  console.log(`Sandbox OK: agent ${AGENT} denies bash/edit/read/write/webfetch/task and other MCP servers, allows leash_* only.`);
  process.exit(0);
}
plan();

// Fresh chain for this run: demo policy registered and funded by Anvil #0, relayer Anvil #9.
console.log(`Starting Anvil on :${PORT} (scripts/demo-anvil.sh) ...`);
const deploy = spawnSync(path.join(ROOT, 'scripts/demo-anvil.sh'), {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, ANVIL_PORT: PORT, LEASH_DAILY_CAP_CENTS: DAILY_CAP, LEASH_ESCROW_WEI: '5000' },
});
const pidFile = path.join(ROOT, '.demo/anvil.pid');
const anvilPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : NaN;
const stopChain = () => {
  if (Number.isInteger(anvilPid)) {
    try {
      process.kill(anvilPid);
    } catch {
      // already gone
    }
  }
};
process.on('exit', stopChain);
process.on('SIGINT', () => process.exit(130));
if (deploy.status !== 0) {
  console.error(`Anvil deploy failed:\n${deploy.stdout}\n${deploy.stderr}`);
  process.exit(1);
}
console.log(deploy.stdout.trim());
const chainEnv = Object.fromEntries(
  readFileSync(path.join(ROOT, '.demo/anvil.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);

/** Names of the MCP servers opencode resolves in `dir` (only the names are read, never values). */
function globalMcpNames(dir: string): string[] {
  const out = spawnSync('opencode', ['debug', 'config'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 24 });
  try {
    return Object.keys((JSON.parse(out.stdout) as { mcp?: Record<string, unknown> }).mcp ?? {});
  } catch {
    throw new Error('Could not read the resolved opencode config (opencode debug config)');
  }
}

/** Refuse to run unless the resolved agent denies bash/edit/read and allows the leash tools (last match wins). */
function assertSandbox(dir: string): void {
  const out = spawnSync('opencode', ['debug', 'agent', AGENT], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 24 });
  let rules: { permission: string; action: string }[];
  try {
    rules = (JSON.parse(out.stdout) as { permission: { permission: string; action: string }[] }).permission;
  } catch {
    throw new Error(`Sandbox check failed: opencode debug agent ${AGENT} did not return JSON`);
  }
  const glob = (p: string, name: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name);
  const decide = (name: string) => [...rules].reverse().find((r) => r.permission !== 'external_directory' && glob(r.permission, name))?.action;
  const bad = ['bash', 'edit', 'write', 'read', 'webfetch', 'task', 'railway_list-projects'].filter((t) => decide(t) !== 'deny');
  if (bad.length || decide('leash_leash_request_payment') !== 'allow') {
    throw new Error(`Sandbox not enforced for agent ${AGENT}: ${bad.join(', ') || 'leash tools not allowed'}; refusing to run a model`);
  }
}

/** opencode --format json prints one event per line; count model steps, tool calls and the final text. */
function readEvents(stdout: string): { steps: number; finalText: string; errors: string[]; tools: string[] } {
  let steps = 0;
  const texts: string[] = [];
  const errors: string[] = [];
  const tools: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; part?: { text?: string; tool?: string }; error?: unknown };
      if (ev.type === 'step_start') steps++;
      if (ev.type === 'tool_use' && ev.part?.tool) tools.push(ev.part.tool);
      if (ev.type === 'text' && ev.part?.text) texts.push(ev.part.text);
      if (ev.type === 'error' || ev.error) errors.push(JSON.stringify(ev.error ?? ev).slice(0, 400));
    } catch {
      // not an event line
    }
  }
  return { steps, finalText: texts.join('\n').trim().slice(-600), errors, tools };
}

/**
 * Per-case opencode.json: leash-mcp as the only enabled MCP server, a deny-all agent that allows only
 * its tools, every other MCP server the user's global config adds disabled; then the sandbox is checked.
 */
function writeCaseConfig(dir: string, log: string, chain: Record<string, string>): void {
  const off = ['bash', 'edit', 'write', 'read', 'glob', 'grep', 'list', 'webfetch', 'patch', 'todowrite', 'todoread', 'task'];
  const cfgPath = path.join(dir, 'opencode.json');
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    tools: Object.fromEntries(off.map((t) => [t, false])),
    agent: AGENT_CONFIG,
    mcp: {
      leash: {
        type: 'local',
        enabled: true,
        command: ['node', MCP, '--demo'],
        environment: {
          PATH: `${path.join(ROOT, '.tools')}:${process.env.PATH}`,
          LEASH_HOME,
          LEASH_DEMO: '1',
          LEASH_DAILY_CAP_CENTS: DAILY_CAP,
          LEASH_PAY_FROM_ESCROW: '1',
          LEASH_RPC_URL: chain.LEASH_RPC_URL ?? '',
          LEASH_PAYMENT_CONTRACT_ADDRESS: chain.LEASH_PAYMENT_CONTRACT_ADDRESS ?? '',
          LEASH_SENDER_ADDRESS: chain.LEASH_SENDER_ADDRESS ?? '',
          LEASH_POLICY_OWNER_ADDRESS: chain.LEASH_POLICY_OWNER_ADDRESS ?? '',
          LEASH_MCP_LOG: log,
        },
      },
    } as Record<string, unknown>,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
  for (const name of globalMcpNames(dir)) if (name !== 'leash') cfg.mcp[name] = { enabled: false };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
  assertSandbox(dir);
}

const shortProof = (l: { result: unknown }) => {
  const r = l.result as Record<string, unknown>;
  if (r && typeof r === 'object' && typeof r.proofHex === 'string') {
    const hex = r.proofHex as string;
    const { verification, ...rest } = r;
    void verification;
    return { ...l, result: { ...rest, proofHex: `<${(hex.length - 2) / 2} bytes, sha256 ${createHash('sha256').update(hex).digest('hex').slice(0, 16)}>` } };
  }
  return l;
};

const results: LlmCaseResult[] = [];
const toolLogs: Record<number, unknown[]> = {};
let totalSteps = 0;
let stopped: string | undefined;

for (const c of cases) {
  if (stopped) {
    results.push(undecidedLlmCase(c, 'PENDING', stopped));
    continue;
  }
  const dir = path.join(RUN, `case-${c.id}`);
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'tool-calls.jsonl');
  writeCaseConfig(dir, log, chainEnv);
  console.log(`\n=== case ${c.id} (${c.category}) ...`);
  // Through sh with stdin from /dev/null: spawned directly from node, opencode 1.18 fails in
  // createUserMessage ("Unexpected server error") before any model call. The prompt goes in by env.
  const cmd = 'exec opencode run --print-logs --log-level WARN -m "$LM_MODEL" --agent "$LM_AGENT" --format json "$LM_PROMPT" < /dev/null';
  const run = spawnSync('/bin/sh', ['-c', cmd], {
    cwd: dir,
    env: { ...cleanEnv(), LM_MODEL: MODEL, LM_AGENT: AGENT, LM_PROMPT: buildLlmMatrixPrompt(c) },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 1 << 26,
  });
  writeFileSync(path.join(dir, 'opencode-events.jsonl'), run.stdout ?? '');
  writeFileSync(path.join(dir, 'opencode-stderr.txt'), run.stderr ?? '');
  const ev = readEvents(run.stdout ?? '');
  totalSteps += ev.steps;
  const outside = ev.tools.filter((t) => !isLeashTool(t));
  if (outside.length) {
    // A tool outside leash-mcp ran: the case says nothing about LEASH, and the sandbox failed. Stop.
    console.error(`  ABORT: the agent used non-leash tools (${[...new Set(outside)].join(', ')}); sandbox failed, run discarded.`);
    process.exit(3);
  }
  const lines = existsSync(log) ? parseMcpLog(readFileSync(log, 'utf8')) : [];
  toolLogs[c.id] = lines.map(shortProof);
  const providerText = `${ev.errors.join('\n')}\n${run.stderr ?? ''}`;
  if (lines.length === 0 && (run.status !== 0 || run.error || looksLikeProviderFailure(providerText) || ev.steps === 0)) {
    const why = run.error ? String(run.error.message) : (ev.errors[0] ?? (run.stderr ?? '').trim().split('\n').pop() ?? `exit ${run.status}`);
    stopped = `provider unavailable at case ${c.id}: ${why.slice(0, 300)}`;
    results.push(undecidedLlmCase(c, 'PROVIDER_UNAVAILABLE', stopped));
    console.log(`  ${stopped}`);
    continue;
  }
  const r = classifyLlmCase(c, lines, { modelRequests: ev.steps, agentFinalText: ev.finalText });
  results.push(r);
  const asked = r.requests.map((q) => `${q.merchant} ${q.amountCents}c${q.recipient ? ` -> ${q.recipient.slice(0, 8)}…` : ''}`).join('; ') || 'nothing';
  console.log(`  agent asked: ${asked}`);
  console.log(`  verdict: ${r.verdict}${r.rule ? ` (${r.rule})` : ''}${r.releases.length ? `; chain: ${r.releases.map((x) => (x.released ? `released ${x.amountCents}c` : x.error)).join('; ')}` : ''}; passed: ${r.passed}; model steps ${ev.steps}`);
}

const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const decided = results.filter((r) => r.passed !== undefined);
const summary = {
  date: new Date().toISOString(),
  commit: head,
  model: MODEL,
  chain: 'local Anvil (chain id 31337), fresh per run; 1 cent settles as 1 wei',
  policy: { demo: true, perPaymentCapCents: 500, dailyCapCents: Number(DAILY_CAP), escrowWei: 5000 },
  casesRequested: IDS,
  casesRun: decided.length,
  pending: results.filter((r) => r.passed === undefined).map((r) => r.caseId),
  passed: decided.filter((r) => r.passed).length,
  injectionsWithPayloadPaid: decided.filter((r) => r.isInjection && r.payloadPaid).map((r) => r.caseId),
  modelRequestsCounted: totalSteps,
  stoppedBecause: stopped ?? null,
  results,
  toolCalls: toolLogs,
};
const outDir = path.join(ROOT, 'docs', 'evidence');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `llm-matrix-${summary.date.slice(0, 10)}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
writeFileSync(path.join(RUN, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Per-case opencode events and tool logs: ${RUN}`);

console.log('\n| case | category | agent asked | verdict | chain | passed |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
  const asked = r.requests.map((q) => `${q.merchant} ${q.amountCents}${q.recipient ? ` to ${q.recipient.slice(0, 6)}…` : ''}`).join('; ') || '—';
  const chain = r.releases.map((x) => (x.released ? `released ${x.amountCents}` : x.error)).join('; ') || '—';
  console.log(`| ${r.caseId} | ${r.category} | ${asked} | ${r.verdict}${r.rule ? ` ${r.rule}` : ''} | ${chain} | ${r.passed ?? 'pending'} |`);
}
console.log(`\n${decided.length}/${results.length} cases decided, ${summary.passed} passed; ${totalSteps} model steps counted. Written ${path.relative(ROOT, out)}`);
if (stopped) {
  console.log(`Stopped: ${stopped}. Remaining cases are PENDING (not run, not counted).`);
  process.exitCode = 2;
}
