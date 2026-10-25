/**
 * The hosted, verify-only console (scripts/build-vercel.mjs; https://leash-console.vercel.app by default,
 * LEASH_E2E_HOSTED_URL to point at a preview). It has no owner device: it must not send a request that can
 * only be refused (no 4xx/5xx at all, see the guard), it says why tags, the walk test and the matrix don't
 * run, and the live gateway really verifies the committed proof and rejects it with one byte flipped.
 * Run: pnpm exec playwright test --project hosted-desktop --project hosted-mobile
 */
import { test, expect } from './fixtures';

test.describe('hosted verify-only console', () => {
  test('nothing is committed or proven here, and the page says so without a refused request', async ({ page, guard }) => {
    await page.goto('/#console');
    const console_ = page.locator('#console');
    await expect(console_.getByText('Console · hosted, verify-only', { exact: true })).toBeVisible();
    await expect(console_.getByText(/Hosted and verify-only: nothing is committed or proven on this page/)).toBeVisible();
    await expect(console_.getByText('none (verify-only)')).toBeVisible();
    await expect(console_.getByText('Not committed on this page: policies are committed on the owner device.')).toHaveCount(3);
    await expect(console_.getByRole('button', { name: /^Pay \d+ cents$/ }).first()).toBeDisabled();
    await expect(console_.getByRole('button', { name: 'Tug $500' }).first()).toBeDisabled();
    await expect(console_.getByRole('button', { name: 'Run the walk test' })).toHaveCount(0);
    await expect(console_.getByRole('button', { name: 'Run the matrix' })).toBeDisabled();
    await expect(console_.getByText(/Not run on this page: This gateway is verify-only/)).toBeVisible();
    await expect(console_.getByRole('button', { name: 'Save PayPal for agent mode' })).toBeDisabled();
    await expect(console_.getByText(/Policy commitment unavailable/)).toHaveCount(0);
    // Turning a spool changes the dial only: no commit request goes out.
    const commits: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/policies') && r.method() === 'POST') commits.push(r.url()); });
    await console_.getByRole('button', { name: 'Increase cap by $0.50' }).first().click();
    await page.waitForTimeout(800);
    expect(commits).toEqual([]);
    // No copy promises what this page can't do: no re-commit, no walk test, no matrix result to wait for.
    await expect(console_.getByText(/this page commits nothing/)).toBeVisible();
    await expect(console_.getByText(/the policy is re-committed and the tag gets a new hash\./)).toHaveCount(0);
    await expect(console_.getByText(/Run the walk test or pay from an agent tag/)).toHaveCount(0);
    await expect(console_.getByText(/Results appear here once the matrix finishes/)).toHaveCount(0);
    // The receipts come from the live gateway.
    await expect(console_.getByText(/^\d+ receipts? · updated /)).toBeVisible();
    const width = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(width[0], 'no sideways scroll').toBeLessThanOrEqual(width[1]);
    expect(guard.problems).toEqual([]);
  });

  test('Live verify: the gateway verifies the committed proof, and rejects it with one byte flipped', async ({ page }) => {
    await page.goto('/#run');
    const run = page.locator('#run');
    await run.getByRole('button', { name: 'Verify the committed proof' }).click();
    await expect(run.getByText('UltraHonk proof verified')).toBeVisible({ timeout: 30_000 });
    await expect(run.getByText(/Verified by the live gateway in \d+ ms\./)).toBeVisible();
    await expect(run.locator('dd', { hasText: /^300/ })).toBeVisible();
    await expect(run.getByText(/Not released: this hosted page only verifies/)).toBeVisible();

    await run.getByRole('button', { name: 'Flip one byte and verify' }).click();
    await expect(run.getByText('Snapped taut: nothing released')).toBeVisible({ timeout: 30_000 });
    await expect(run.getByText(/1 byte flipped at offset \d+ of 8640\./).first()).toBeVisible();
    await expect(run.getByText('UltraHonk proof verified')).toHaveCount(0);
  });
});
