/**
 * The judge's first two minutes: `pnpm demo:anvil && pnpm demo:agent` on a fresh chain, no LLM and no
 * keys. Runs its own Anvil (port LEASH_E2E_DEMO_ANVIL_PORT, default 8559, state in e2e/.run/demo) so it
 * never touches the stack's chain, and kills that Anvil by PID afterwards.
 */
import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SNAPS, SUMCHECKS } from '../apps/web/lib/recordedRun';

const ROOT = path.resolve(__dirname, '..');
const DEMO_DIR = path.join(path.resolve(ROOT, process.env.LEASH_E2E_RUN_DIR ?? 'e2e/.run'), 'demo');
const env = { ...process.env, PATH: `${path.join(ROOT, '.tools')}:${process.env.PATH}`, LEASH_DEMO_DIR: DEMO_DIR, ANVIL_PORT: process.env.LEASH_E2E_DEMO_ANVIL_PORT ?? '8559' };

test.afterAll(() => {
  const pid = path.join(DEMO_DIR, 'anvil.pid');
  if (fs.existsSync(pid)) {
    try {
      process.kill(Number(fs.readFileSync(pid, 'utf8').trim()));
    } catch {
      // already gone
    }
  }
});

test('pnpm demo:anvil && pnpm demo:agent: 1 release and the 6 recorded refusals, verify:receipt passes, payee +300 wei', async () => {
  test.setTimeout(5 * 60_000);
  execFileSync('./scripts/demo-anvil.sh', { cwd: ROOT, env, encoding: 'utf8' });
  const run = spawnSync('pnpm', ['-s', 'demo:agent'], { cwd: ROOT, env, encoding: 'utf8' });
  const out = run.stdout;
  await test.info().attach('demo-agent.txt', { body: out + run.stderr, contentType: 'text/plain' });
  expect(run.status, out + run.stderr).toBe(0);
  expect(out.match(/^\[\d\] RELEASED /gm)).toHaveLength(1);
  expect(out.match(/^\[\d\] REFUSED /gm)).toHaveLength(6);
  expect(out.match(/^ {6}matches the recording/gm)).toHaveLength(6);
  for (const e of [...SNAPS.map((s) => s.error), SUMCHECKS[0].error]) expect(out).toContain(e);
  // The direct cast send: the same on-chain revert (selector 0x9fc3a218 = SumcheckFailed), in cast's own words
  expect(out).toMatch(/^\[7\] REFUSED .*\n {6}.*execution reverted: custom error 0x9fc3a218.*SumcheckFailed/m);
  expect(out).toContain('PASS bb verify');
  expect(out).toMatch(/payee 0x7099…79C8 \+300 wei, attacker 0x3C44…93BC \+0 wei, escrow 2000 -> 1700 wei/);
  expect(out).toContain('summary: 1 release, 6 refusals, 6 of 6 refusal texts match the recording; verify:receipt PASS');

  // Running it again on the same chain is refused with a readable hint, not a confusing failure
  const again = spawnSync('pnpm', ['-s', 'demo:agent'], { cwd: ROOT, env, encoding: 'utf8' });
  expect(again.status).toBe(1);
  expect(again.stderr).toContain('This chain already ran the demo (nonce 3001 is used)');
});
