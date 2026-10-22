/**
 * The console on the owner device (LEASH_OWNER_DEVICE=1), clicked like a user: agent tags committed by
 * the server, copy, spools, Pay / Tug with real nargo + bb proofs, the PayPal rail's honest "Setup
 * required", the walk test, the pull test (policy-violation matrix, no LLM) and the walk log with its
 * Refresh button, which loads this device's real receipts (the Anvil release made by the chain project).
 */
import { test, expect, expectNoHorizontalScroll, expectScrolledTo } from './fixtures';
import type { Page } from '@playwright/test';

const HEX64 = /0x[0-9a-f]{64}/;

async function openConsole(page: Page) {
  await page.goto('/#console');
  const tags = page.locator('article.tag-card');
  await expect(tags).toHaveCount(3);
  // Every tag gets a real commitment from the server (POST /api/policies -> nargo)
  for (let i = 0; i < 3; i++) {
    await expect(tags.nth(i).getByText('Engraved commitment')).toBeVisible();
    await expect(tags.nth(i).locator('p.mono')).toHaveAttribute('title', HEX64, { timeout: 30_000 });
  }
  await expect(page.getByRole('alert').filter({ hasText: 'Policy commitment unavailable' })).toHaveCount(0);
  return tags;
}

const walkLog = (page: Page) => page.locator('#audit');
const leadState = (page: Page) => page.locator('#run [aria-live="polite"][aria-busy]');
const overview = (page: Page) => page.getByRole('region', { name: 'Session overview' });
const stat = (page: Page, label: string) =>
  overview(page).locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');

test('agent tags: committed by the server, registered for the owner, copyable', async ({ page, context, browserName }) => {
  const tags = await openConsole(page);
  await expect(page.locator('#console').getByText('0xf39F…2266')).toBeVisible();
  const reg = await (await page.request.get('/api/policies')).json();
  expect(reg.ownerDevice).toBe(true);
  expect(reg.paypal.configured).toBe(false);
  const registered = reg.policies.map((p: { policyCommitment: string }) => p.policyCommitment);
  for (let i = 0; i < 3; i++) {
    const c = await tags.nth(i).locator('p.mono').getAttribute('title');
    expect(registered).toContain(c);
  }
  // Copy the full commitment
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const first = tags.first();
  const commitment = await first.locator('p.mono').getAttribute('title');
  await first.getByRole('button', { name: 'Copy the full commitment' }).click();
  await expect(first.getByRole('button', { name: 'Commitment copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(commitment);
  await expect(first.getByRole('button', { name: 'Copy the full commitment' })).toBeVisible({ timeout: 5000 });
  // The console's PayPal card is honest
  await expect(page.locator('#console').getByRole('note', { name: 'PayPal sandbox: setup required' })).toContainText('Setup required (PAYPAL_CLIENT_ID)');
  await expectNoHorizontalScroll(page);
  await page.locator('#fleet').screenshot({ path: test.info().outputPath('agent-tags.png') });
});

test('walk log: loads the real Anvil release, and Refresh visibly reloads it', async ({ page }) => {
  await openConsole(page);
  const log = walkLog(page);
  await log.scrollIntoViewIfNeeded();
  await expect(log.getByRole('heading', { name: /Walk log/ })).toBeVisible();
  // The 300-cent release the agent (leash-mcp) made on Anvil in the chain project, from this device's receipts
  const row = log.locator('li:visible, tr:visible').filter({ hasText: '3001' }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Paid');
  await expect(row).toContainText('300');
  await expect(row).toContainText(/Anvil tx 0x[0-9a-f]{4}/);
  await expect(stat(page, 'Paid')).toHaveText('1');
  await expect(overview(page)).toContainText('300');

  const status = log.getByRole('status');
  await expect(status).toContainText(/1 receipt/);
  const before = await status.innerText();
  await page.waitForTimeout(1100); // the status shows the load time to the second; let it be able to move
  const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/receipts') && r.status() === 200);
  await log.getByRole('button', { name: 'Refresh' }).click();
  await refreshed;
  await expect(status).not.toHaveText(before); // the "updated at" time moves, so the click visibly did something
  await expect(status).toContainText(/1 receipt/);
  await expectNoHorizontalScroll(page);
  await log.screenshot({ path: test.info().outputPath('walk-log-console.png') });

  // The same receipt by nonce (public data only: no caps, merchants or salts)
  const one = await (await page.request.get('/api/receipts/3001')).json();
  expect(one.receipt).toMatchObject({ nonce: '3001', amountCents: 300, rail: 'evm', status: 'COMPLETED' });
  expect(JSON.stringify(one)).not.toMatch(/maxPerTx|salt|merchants/i);
});

test('walk log: a failed receipts load is shown, not swallowed', async ({ page, guard }) => {
  await openConsole(page);
  guard.allow('/api/receipts', 500);
  await page.route('**/api/receipts', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disk unavailable"}' }));
  const log = walkLog(page);
  await log.scrollIntoViewIfNeeded();
  await log.getByRole('button', { name: 'Refresh' }).click();
  await expect(log.getByRole('alert')).toContainText('disk unavailable');
  await page.unroute('**/api/receipts');
  await log.getByRole('button', { name: 'Refresh' }).click();
  await expect(log.getByRole('alert')).toHaveCount(0);
  await expect(log.getByRole('status')).toContainText(/receipt/);
});

test('pay 300 cents: real proof verified by bb, PayPal rail says Setup required, nothing consumed', async ({ page, guard }) => {
  guard.allow('/api/pay', 503);
  const tags = await openConsole(page);
  const research = tags.filter({ hasText: 'Research agent' });
  await research.scrollIntoViewIfNeeded();
  const pay = page.waitForResponse((r) => r.url().endsWith('/api/pay'));
  await research.getByRole('button', { name: 'Pay 300 cents' }).click();
  await expect(leadState(page)).toContainText('Proving', { timeout: 5000 }).catch(() => undefined); // may be too quick to see
  const payRes = await pay;
  expect(payRes.status()).toBe(503);
  const body = await payRes.json();
  expect(body.verified).toBe(true);
  expect(body.error).toMatch(/Proof verified; nothing consumed\. Setup required \(PAYPAL_CLIENT_ID\)/);

  const panel = leadState(page);
  await expect(panel).toContainText('UltraHonk proof verified');
  await expect(panel).toContainText('Verified');
  await expect(panel).toContainText('300');
  await expect(panel).toContainText('Not released: Proof verified; nothing consumed. Setup required (PAYPAL_CLIENT_ID)');
  await expect(panel).toContainText('bb verify: passed');
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: test.info().outputPath('proof-verified-setup-required.png') });

  // Walk log: a "Not paid" row for this session; the device's daily cord did not move
  const log = walkLog(page);
  await expect(log.locator('li:visible, tr:visible').filter({ hasText: 'Not paid' })).toHaveCount(1);
  await expect(log).toContainText('PayPal: setup required');
  await expect(stat(page, 'Verified, not paid')).toHaveText('1');
  await expect(research.getByText('0 / 1500 cents')).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('tug $500: the circuit refuses, the lead snaps, the walk log records it', async ({ page, guard }) => {
  guard.allow('/api/prove', 422); // the prover's honest "constraint" answer
  const tags = await openConsole(page);
  const research = tags.filter({ hasText: 'Research agent' });
  await research.scrollIntoViewIfNeeded();
  await research.getByRole('button', { name: 'Tug $500' }).click();
  const panel = leadState(page);
  await expect(panel).toContainText('Snapped taut: nothing released');
  await expect(panel).toContainText(/R2|exceeds the per-transaction cap/);
  await expect(panel.getByRole('alert')).toContainText('Refused before any money moved');
  await expect(walkLog(page).locator('li:visible, tr:visible').filter({ hasText: 'Snapped' })).toHaveCount(1);
  await expect(walkLog(page)).toContainText('50000');
  await expect(stat(page, 'Snapped')).toHaveText('1');
  await panel.screenshot({ path: test.info().outputPath('tug-snapped.png') });
});

test('turn a spool: the cap changes and the policy is re-committed with a new hash', async ({ page }) => {
  const tags = await openConsole(page);
  const devops = tags.filter({ hasText: 'DevOps agent' });
  await devops.scrollIntoViewIfNeeded();
  const commit = devops.locator('p.mono');
  const before = await commit.getAttribute('title');
  const slider = devops.getByRole('slider');
  await expect(slider).toHaveAttribute('aria-valuenow', '1000');
  await devops.getByRole('button', { name: 'Increase cap by $0.50' }).click();
  await expect(slider).toHaveAttribute('aria-valuenow', '1050');
  await expect(commit).toHaveAttribute('title', HEX64, { timeout: 30_000 });
  await expect(commit).not.toHaveAttribute('title', before!);
  await expect(devops.getByText('0 / 3150 cents')).toBeVisible();
  // Keyboard on the dial, then a preset chip
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuenow', '1000');
  const presets = devops.getByRole('group', { name: 'Cap presets' }).getByRole('button');
  const n = await presets.count();
  expect(n).toBeGreaterThan(0);
  const chip = presets.nth(0);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(commit).toHaveAttribute('title', HEX64, { timeout: 30_000 });
  await devops.getByRole('button', { name: 'Decrease cap by $0.50' }).click();
  await expect(commit).toHaveAttribute('title', HEX64, { timeout: 30_000 });
  // The registration for the new commitment is at the gateway
  const c = await commit.getAttribute('title');
  const reg = await (await page.request.get('/api/policies')).json();
  expect(reg.policies.map((p: { policyCommitment: string }) => p.policyCommitment)).toContain(c);
});

test('fast spool steps commit once, and Pay proves against the cap on screen even when commits answer out of order', async ({ page, guard }) => {
  guard.allow('/api/pay', 503);
  const tags = await openConsole(page);
  const research = tags.filter({ hasText: 'Research agent' });
  await research.scrollIntoViewIfNeeded();
  const slider = research.getByRole('slider');
  await expect(slider).toHaveAttribute('aria-valuenow', '500');
  const commit = research.locator('p.mono');
  const before = await commit.getAttribute('title');

  // Every policy commit from here on is held back, earlier ones longest: answers arrive in reverse order.
  const sentCaps: number[] = [];
  await page.route('**/api/policies', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const i = sentCaps.push(route.request().postDataJSON().maxPerTxCents) - 1;
    await new Promise((r) => setTimeout(r, Math.max(0, 600 - 60 * i)));
    await route.continue();
  });
  await slider.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp');
  await expect(slider).toHaveAttribute('aria-valuenow', '1000');
  await expect(commit).toHaveAttribute('title', HEX64, { timeout: 30_000 });
  await expect(commit).not.toHaveAttribute('title', before!);
  await page.waitForTimeout(1500); // every held-back commit has answered by now
  expect(sentCaps).toEqual([1000]); // one commit for the cap the dial settled on, not one per step

  const pay = research.getByRole('button', { name: 'Pay 300 cents' });
  await expect(pay).toBeEnabled();
  const prove = page.waitForRequest((r) => r.url().endsWith('/api/prove'));
  const payRes = page.waitForResponse((r) => r.url().endsWith('/api/pay'));
  await pay.click();
  const proven = (await prove).postDataJSON();
  expect(proven.policy.maxPerTxCents).toBe(1000);
  expect(proven.policy.policyCommitment).toBe(await commit.getAttribute('title'));
  expect((await payRes).status()).toBe(503);
  await expect(leadState(page)).toContainText('bb verify: passed');
});

test('Pay and Tug wait for the policy commitment', async ({ page }) => {
  // Hold the first commits back: until a tag has its commitment, its Pay and Tug can't be pressed.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/policies', async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  await page.goto('/#console');
  const research = page.locator('article.tag-card').filter({ hasText: 'Research agent' });
  await research.scrollIntoViewIfNeeded();
  await expect(research.getByRole('button', { name: 'Pay 300 cents' })).toBeDisabled();
  await expect(research.getByRole('button', { name: 'Tug $500' })).toBeDisabled();
  release();
  await expect(research.locator('p.mono')).toHaveAttribute('title', HEX64, { timeout: 30_000 });
  await expect(research.getByRole('button', { name: 'Pay 300 cents' })).toBeEnabled();
  await expect(research.getByRole('button', { name: 'Tug $500' })).toBeEnabled();
});

test('walk test: the legit payment proves and verifies, the tug snaps, both land in the walk log', async ({ page, guard }) => {
  guard.allow('/api/pay', 503);
  guard.allow('/api/prove', 422);
  await openConsole(page);
  const run = page.locator('#run');
  await run.scrollIntoViewIfNeeded();
  await expect(run.getByText('not run yet')).toBeVisible();
  await run.getByRole('button', { name: 'Run the walk test' }).click();
  await expect(run.getByRole('button', { name: 'Run the walk test again' })).toBeVisible({ timeout: 120_000 });
  await expect(run.getByText(/^\d+\.\d\ds$/)).toBeVisible();
  await expect(run.getByText('Ran', { exact: true })).toHaveCount(2);
  // The panel ends on the tug; the walk log has both
  await expect(leadState(page)).toContainText('Snapped taut');
  const log = walkLog(page);
  await expect(log.locator('li:visible, tr:visible').filter({ hasText: 'Not paid' })).toHaveCount(1);
  await expect(log.locator('li:visible, tr:visible').filter({ hasText: 'Snapped' })).toHaveCount(1);
  await run.screenshot({ path: test.info().outputPath('walk-test.png') });
});

test('pull test: 26 cases through the real prover and verifier (no LLM), every guarantee holds', async ({ page }) => {
  await openConsole(page);
  const pull = page.locator('#harness');
  await pull.scrollIntoViewIfNeeded();
  await expect(pull.getByText('Nothing has run yet.')).toBeVisible();
  const res = page.waitForResponse((r) => r.url().endsWith('/api/harness'), { timeout: 240_000 });
  await pull.getByRole('button', { name: 'Run the matrix' }).click();
  await expect(pull.getByRole('button', { name: 'Running 26 cases…' })).toBeDisabled();
  expect((await res).status()).toBe(200);
  await expect(pull.getByRole('button', { name: 'Run again' })).toBeVisible();
  const tiles = pull.locator('[aria-live="polite"] > div');
  await expect(tiles.filter({ hasText: 'Violations blocked' })).toContainText('100%');
  await expect(tiles.filter({ hasText: 'Violations blocked' })).toContainText('22 of 22');
  await expect(tiles.filter({ hasText: 'Legitimate allowed' })).toContainText('4 of 4');
  await expect(tiles.filter({ hasText: 'All guarantees held' })).toContainText('Yes');
  await expect(tiles.filter({ hasText: 'All guarantees held' })).toContainText('26 cases run');
  await expect(pull.locator('ul > li')).toHaveCount(26);
  await expect(pull.getByText('Unexpected')).toHaveCount(0);
  await expect(pull.getByText('Error, not run')).toHaveCount(0);
  for (const label of ['Rule R1 · allowlist', 'Rule R1 · bound payee', 'Rule R2 · per-payment cap', 'Rule R4 · daily cap', 'Allowed']) {
    await expect(pull.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(pull.getByRole('alert')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await pull.screenshot({ path: test.info().outputPath('pull-test.png') });
});

test('approval-threshold path: above the threshold the gateway would return an approve link; without keys it says Setup required and consumes nothing', async ({ page, guard }) => {
  guard.allow('/api/pay', 503);
  guard.allow('/api/pay/capture', 404);
  guard.allow('/api/paypal/vault', 503);
  await openConsole(page);
  // A fresh policy on the owner device: 500/payment, approval threshold 300
  const created = await (
    await page.request.post('/api/policies', {
      data: { name: 'Threshold check', maxPerTxCents: 500, dailyCapCents: 1500, approvalThresholdCents: 300, merchants: ['openai'] },
    })
  ).json();
  const policy = created.policy;
  expect(created.registration.approvalThresholdCents).toBe(300);
  const nonce = String(Date.now());
  const proved = await (
    await page.request.post('/api/prove', {
      data: { policy, merchantName: 'openai', amountCents: 400, nonce, spend: { epoch: Math.floor(Date.now() / 86_400_000), prevSpendCommit: '0', spentBeforeCents: 0 } },
    })
  ).json();
  expect(proved.success, proved.error).toBe(true);
  // Through the browser, as the console does it
  const result = await page.evaluate(
    async ({ proofHex, publicInputsHex }) => {
      const r = await fetch('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', proofHex, publicInputsHex }) });
      return { status: r.status, body: await r.json() };
    },
    { proofHex: proved.proofHex, publicInputsHex: proved.publicInputsHex }
  );
  expect(result.status).toBe(503);
  expect(result.body.error).toContain('Proof verified; nothing consumed. Setup required (PAYPAL_CLIENT_ID)');
  expect(result.body.setupRequired).toEqual(expect.arrayContaining(['PAYPAL_CLIENT_ID']));
  // Nothing consumed: no receipt for the nonce, no spend commitment, so no approve link can exist
  const policyId = created.registration.policyId;
  expect((await (await page.request.get(`/api/spend/${policyId}`)).json()).spend).toBeNull();
  expect((await page.request.get(`/api/receipts/${nonce}`)).status()).toBe(404);
  const cap = await page.evaluate(async (b) => (await fetch('/api/pay/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, { policyId, nonce });
  expect(cap).toBe(404);
  const vault = await page.evaluate(async () => {
    const r = await fetch('/api/paypal/vault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setup' }) });
    return { status: r.status, body: await r.json() };
  });
  expect(vault.status).toBe(503);
  expect(vault.body.error).toContain('Setup required');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Approve in PayPal' })).toHaveCount(0);
});

test('console sections are reachable from the landing and fit the viewport', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Open the console/ }).click();
  await expectScrolledTo(page, 'console');
  await expect(page.getByRole('heading', { name: 'Put your own agents on a leash.' })).toBeInViewport();
  await openConsole(page);
  for (const id of ['fleet', 'run', 'harness', 'audit']) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
  }
  await page.locator('#console').screenshot({ path: test.info().outputPath('console-full.png') });
});
