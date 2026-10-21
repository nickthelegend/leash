#!/usr/bin/env tsx
/**
 * Policy-violation matrix, LLM-in-the-loop: each matrix prompt goes to a real model (opencode) whose
 * only tools are leash-mcp's, on a fresh local Anvil chain. leash-mcp's LEASH_MCP_LOG records what the
 * agent actually requested and whether the proof or LeashPayment refused it.
 *
 *   pnpm matrix:llm -- --dry-run                     print the plan and prompts; no model call
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
const RUN = path.join(ROOT, '.demo', 'llm-matrix', runId);
mkdirSync(RUN, { recursive: true });
const LEASH_HOME = path.join(RUN, 'leash-home');
mkdirSync(LEASH_HOME, { recursive: true });
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

/** opencode --format json prints one event per line; count model steps and keep the final text. */
function readEvents(stdout: string): { steps: number; finalText: string; errors: string[] } {
  let steps = 0;
  const texts: string[] = [];
  const errors: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; part?: { text?: string }; error?: unknown };
      if (ev.type === 'step_start') steps++;
      if (ev.type === 'text' && ev.part?.text) texts.push(ev.part.text);
      if (ev.type === 'error' || ev.error) errors.push(JSON.stringify(ev.error ?? ev).slice(0, 400));
    } catch {
      // not an event line
    }
  }
  return { steps, finalText: texts.join('\n').trim().slice(-600), errors };
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
  // The agent gets only leash-mcp: every built-in opencode tool is off.
  const off = ['bash', 'edit', 'write', 'read', 'glob', 'grep', 'list', 'webfetch', 'patch', 'todowrite', 'todoread', 'task'];
  writeFileSync(
    path.join(dir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        tools: Object.fromEntries(off.map((t) => [t, false])),
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
              LEASH_RPC_URL: chainEnv.LEASH_RPC_URL,
              LEASH_PAYMENT_CONTRACT_ADDRESS: chainEnv.LEASH_PAYMENT_CONTRACT_ADDRESS,
              LEASH_SENDER_ADDRESS: chainEnv.LEASH_SENDER_ADDRESS,
              LEASH_POLICY_OWNER_ADDRESS: chainEnv.LEASH_POLICY_OWNER_ADDRESS,
              LEASH_MCP_LOG: log,
            },
          },
        },
      },
      null,
      1
    )
  );
  console.log(`\n=== case ${c.id} (${c.category}) ...`);
  const run = spawnSync('opencode', ['run', '-m', MODEL, '--format', 'json', buildLlmMatrixPrompt(c)], {
    cwd: dir,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 26,
  });
  writeFileSync(path.join(dir, 'opencode-events.jsonl'), run.stdout ?? '');
  writeFileSync(path.join(dir, 'opencode-stderr.txt'), run.stderr ?? '');
  const ev = readEvents(run.stdout ?? '');
  totalSteps += ev.steps;
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
  injectionsWithPayloadPaid: decided.filter((r) => r.isInjection && r.injectedPayloadPaid).map((r) => r.caseId),
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
