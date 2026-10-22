/**
 * The console with a PayPal sandbox merchant configured (PAYPAL_PAYEE_MERCHANT_ID set, no client id or
 * secret): e2e/stack.sh runs a second console on 127.0.0.1:3109 for this. Every committed policy lists
 * 'paypal-sandbox-merchant', and Pay must pay it with its PayPal merchant id, so that with sandbox keys
 * the gateway's payee check passes and an approve link comes back. Without keys: 503 Setup required.
 */
import { test, expect, expectNoHorizontalScroll } from './fixtures';

const MERCHANT_ID = 'ABCDEFGHJKLMN'; // valid-format 13-char id; no PayPal call is made without a client id

test('Pay 300 cents pays paypal-sandbox-merchant with its PayPal merchant id; the gateway checks the payee, then says Setup required', async ({ page, guard }) => {
  guard.allow('/api/pay', 503);
  const policies = await (await page.request.get('/api/policies')).json();
  expect(policies.paypalPayeeMerchantId).toBe(MERCHANT_ID);
  expect(policies.paypal.configured).toBe(false);

  await page.goto('/#console');
  const research = page.locator('article.tag-card').filter({ hasText: 'Research agent' });
  await expect(research.locator('p.mono')).toHaveAttribute('title', /0x[0-9a-f]{64}/, { timeout: 30_000 });
  // On the allowlist (chip) and named as what Pay / Tug pay
  await expect(research.getByText('paypal-sandbox-merchant', { exact: true })).toHaveCount(2);
  await expect(research).toContainText('Pay and Tug pay paypal-sandbox-merchant on the PayPal rail');
  await research.scrollIntoViewIfNeeded();

  const payReq = page.waitForRequest((r) => r.url().endsWith('/api/pay') && r.method() === 'POST');
  const payRes = page.waitForResponse((r) => r.url().endsWith('/api/pay'));
  await research.getByRole('button', { name: 'Pay 300 cents' }).click();
  const sent = (await payReq).postDataJSON();
  expect(sent.paypalMerchantId).toBe(MERCHANT_ID);
  const res = await payRes;
  // 503 (not 400 / 403): the merchant id is well-formed and the proof's payee is paypalPayee(MERCHANT_ID).
  expect(res.status()).toBe(503);
  expect((await res.json()).error).toBe('Proof verified; nothing consumed. Setup required (PAYPAL_CLIENT_ID)');
  await expect(page.locator('#run [aria-live="polite"][aria-busy]')).toContainText('Not released: Proof verified; nothing consumed. Setup required (PAYPAL_CLIENT_ID)');
  await expectNoHorizontalScroll(page);
  // The longer merchant name still fits a 375px phone
  await page.setViewportSize({ width: 375, height: 812 });
  await research.scrollIntoViewIfNeeded();
  await expectNoHorizontalScroll(page);
  await research.screenshot({ path: test.info().outputPath('paypal-merchant-tag-375.png') });
});

test('the walk test pays the PayPal merchant too', async ({ page, guard }) => {
  guard.allow('/api/pay', 503);
  guard.allow('/api/prove', 422);
  await page.goto('/#console');
  await expect(page.locator('article.tag-card').first().locator('p.mono')).toHaveAttribute('title', /0x[0-9a-f]{64}/, { timeout: 30_000 });
  const run = page.locator('#run');
  await run.scrollIntoViewIfNeeded();
  await expect(run).toContainText('300 cents ($3.00) to paypal-sandbox-merchant');
  const payReq = page.waitForRequest((r) => r.url().endsWith('/api/pay') && r.method() === 'POST');
  await run.getByRole('button', { name: 'Run the walk test' }).click();
  expect((await payReq).postDataJSON().paypalMerchantId).toBe(MERCHANT_ID);
  await expect(run.getByRole('button', { name: 'Run the walk test again' })).toBeVisible({ timeout: 120_000 });
});
