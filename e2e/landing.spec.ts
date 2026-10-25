/**
 * Landing and /evidence, the way a visitor clicks them. The landing: one headline, the collar tag, how it
 * works, three proof numbers, what's live vs Setup required, the nav and footer. /evidence (everything that
 * moved off the landing): nav anchors (incl. "Walk log"), its hero CTA "Read the walk log", the tag, the
 * retractable lead animation (and its reduced-motion form), the snaps, the walk log timeline, the fine
 * print, the PayPal "Setup required" card and the footer.
 */
import { test, expect, expectNoHorizontalScroll, expectScrolledTo, isMobile } from './fixtures';
import { RUN, SNAPS, SUMCHECKS } from '../apps/web/lib/recordedRun';

const SECTIONS: Array<[string, string]> = [
  ['Tag', 'tag'],
  ['Lead', 'lead'],
  ['Snaps', 'snaps'],
  ['Walk log', 'walk'],
];
const BANDS: Array<[string, string]> = [
  ['How it works', 'how'],
  ['Proof', 'proof'],
];
async function openEvidence(page: import('@playwright/test').Page) {
  await page.goto('/evidence');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The tag, the lead and every snap.');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/A spending leash your agent can.t slip\./);
});

test('loads without errors or horizontal scroll; the hero, the bands and the proof numbers', async ({ page }) => {
  await expectNoHorizontalScroll(page);
  await expect(page.locator('.lz-steps > li h3')).toHaveText(['Write the policy', 'Prove each payment', 'Release or snap']);
  await expect(page.locator('.lz-big dd')).toHaveText([`${RUN.release.amountCents}¢`, '6', '229']);
  await expect(page.locator('.lz-big dt')).toHaveText(['Released', 'Refused', 'Tests']);
  await expect(page.locator('#live')).toContainText('Setup required');
  await expect(page.locator('#live code')).toHaveText(['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
  await expect(page.locator('.lz-hero-facts')).toHaveCount(0); // the facts moved to the proof band
  // The collar tag is engraved with the recorded run's real commitment
  const collar = page.getByRole('img', { name: /Collar tag engraved with the policy commitment/ });
  await expect(collar).toBeVisible();
  await expect(collar).toHaveAttribute('aria-label', new RegExp(RUN.commitment));
  await expect(page.getByText(`The real commitment from the recorded Anvil run, ${RUN.date}.`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('landing-hero.png') });
});

test('main nav: every section link is reachable and jumps to its section', async ({ page }) => {
  let nav = page.getByRole('navigation', { name: 'Main' });
  for (const [label, id] of BANDS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const link = nav.getByRole('link', { name: label, exact: true });
    await expect(link, `nav link "${label}" must be visible on this viewport`).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await expectScrolledTo(page, id);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await nav.getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page).toHaveURL(/\/evidence$/);
  nav = page.getByRole('navigation', { name: 'Main' });
  for (const [label, id] of SECTIONS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const link = nav.getByRole('link', { name: label, exact: true });
    await expect(link, `nav link "${label}" must be visible on this viewport`).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await expectScrolledTo(page, id);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await nav.getByRole('link', { name: 'Console' }).click();
  await expect(page).toHaveURL(/\/#console$/);
  await expectScrolledTo(page, 'console');
  nav = page.getByRole('navigation', { name: 'Main' });
  const gh = nav.getByRole('link', { name: 'GitHub' });
  await expect(gh).toBeVisible();
  await expect(gh).toHaveAttribute('href', 'https://github.com/nickthelegend/leash');
  await expect(gh).toHaveAttribute('target', '_blank');
  await expectNoHorizontalScroll(page);
});

test('every link or button labelled "log" works', async ({ page }) => {
  // the landing has none any more; the walk log lives on /evidence
  await expect(page.locator('a, button').filter({ hasText: /log/i })).toHaveCount(0);
  await openEvidence(page);
  const logControls = page.locator('a, button').filter({ hasText: /log/i });
  const n = await logControls.count();
  expect(n).toBeGreaterThanOrEqual(3); // nav "Walk log", hero "Read the walk log", footer "Walk log"
  for (let i = 0; i < n; i++) {
    const c = logControls.nth(i);
    const label = (await c.innerText()).trim();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(c, `"${label}" (#${i}) must be visible`).toBeVisible();
    await c.scrollIntoViewIfNeeded();
    await c.click();
    await expect(page).toHaveURL(/#walk$/);
    await expectScrolledTo(page, 'walk');
    await expect(page.getByRole('heading', { name: 'The recorded Anvil run, start to finish.' })).toBeInViewport();
  }
  await page.screenshot({ path: test.info().outputPath('walk-log.png') });
});

test('hero CTAs: open the console, how it works; the evidence link; the walk log on /evidence', async ({ page }) => {
  await page.getByRole('link', { name: /Open the console/ }).click();
  await expectScrolledTo(page, 'console');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('link', { name: /How it works/ }).first().click();
  await expectScrolledTo(page, 'how');
  await page.getByRole('link', { name: /See the evidence/ }).click();
  await expect(page).toHaveURL(/\/evidence$/);
  await page.getByRole('link', { name: /Read the walk log/ }).click();
  await expectScrolledTo(page, 'walk');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.lz-hero').getByRole('link', { name: /Open the console/ }).click();
  await expect(page).toHaveURL(/\/#console$/);
  await expectScrolledTo(page, 'console');
});

test('the tag: 8 public inputs on the front, the private witness on the back', async ({ page }) => {
  await openEvidence(page);
  await page.locator('#tag').scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: /Front/ })).toBeVisible();
  await expect(page.locator('.lz-dogtag-front li')).toHaveCount(8);
  await expect(page.locator('.lz-dogtag-back li')).toHaveCount(6);
  await expect(page.locator('.lz-dogtag-back')).toContainText('keccak256(owner, commitment)');
  await expectNoHorizontalScroll(page);
});

test('the retractable lead pays out once when scrolled into view', async ({ page }) => {
  await openEvidence(page);
  const lead = page.locator('figure.rl');
  await expect(lead).toHaveAttribute('data-phase', 'armed');
  await lead.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 200);
  await expect(lead).toHaveAttribute('data-phase', 'go');
  await expect(lead).toContainText(`${RUN.release.amountCents} cents`);
  await expect(lead).toContainText('500 per payment · 700 per day');
  await expect(lead).toContainText('2000 → 1700 wei');
  await page.waitForTimeout(1500);
  await lead.screenshot({ path: test.info().outputPath('lead-paid-out.png') });
});

test('snaps: four refusals and the two SumcheckFailed lines, verbatim', async ({ page }) => {
  await openEvidence(page);
  await page.locator('#snaps').scrollIntoViewIfNeeded();
  const snaps = page.locator('.lz-snap');
  await expect(snaps).toHaveCount(4);
  for (const [i, s] of SNAPS.entries()) await expect(snaps.nth(i)).toContainText(s.error);
  for (const s of SUMCHECKS) await expect(page.locator('.lz-sum')).toContainText(s.error);
  await expectNoHorizontalScroll(page);
});

test('walk log timeline: deploy, register, one release, six refusals, receipt check, PayPal setup, state', async ({ page }) => {
  await openEvidence(page);
  await page.locator('#walk').scrollIntoViewIfNeeded();
  const items = page.locator('.lz-walk > li');
  await expect(items).toHaveCount(12);
  await expect(page.locator('.lz-walk-paid')).toHaveCount(1);
  await expect(page.locator('.lz-walk-snap')).toHaveCount(6);
  await expect(page.locator('.lz-walk-setup')).toContainText('Setup required (PAYPAL_CLIENT_ID)');
  await expect(page.locator('.lz-walk-paid')).toContainText(RUN.release.txHash);
  await expect(page.locator('.lz-walk-paid')).toContainText(RUN.payee);
  await expectNoHorizontalScroll(page);
});

test('PayPal rail reads Setup required; the fine print opens and closes', async ({ page }) => {
  await openEvidence(page);
  await page.locator('#paypal').scrollIntoViewIfNeeded();
  const card = page.locator('#paypal').getByRole('note', { name: 'PayPal sandbox: setup required' });
  await expect(card).toContainText('Setup required (PAYPAL_CLIENT_ID)');
  await expect(card).toContainText('BLOCKED, not faked.');
  const faq = page.locator('.lz-faq details');
  await expect(faq).toHaveCount(4);
  await expect(faq.first()).toHaveAttribute('open', '');
  for (let i = 1; i < 4; i++) {
    const d = faq.nth(i);
    await d.locator('summary').click();
    await expect(d).toHaveAttribute('open', '');
    await expect(d.locator('p')).toBeVisible();
  }
  await faq.first().locator('summary').click();
  await expect(faq.first()).not.toHaveAttribute('open', '');
  for (const name of ['Get the code', 'README']) {
    const l = page.locator('#paypal').getByRole('link', { name: new RegExp(name) });
    await expect(l).toHaveAttribute('href', /^https:\/\/github\.com\/nickthelegend\/leash/);
    await expect(l).toHaveAttribute('target', '_blank');
  }
});

test('footer links jump to their sections, on the landing and on /evidence', async ({ page }) => {
  let foot = page.getByRole('navigation', { name: 'Footer' });
  for (const [label, id] of [...BANDS, ['What’s live', 'live'], ['Console', 'console']] as Array<[string, string]>) {
    await foot.scrollIntoViewIfNeeded();
    await foot.getByRole('link', { name: label, exact: true }).click();
    await expectScrolledTo(page, id);
  }
  await expect(page.locator('.lz-foot-cta').getByRole('link', { name: /Get the code/ })).toHaveAttribute('href', 'https://github.com/nickthelegend/leash');
  await foot.getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page).toHaveURL(/\/evidence$/);
  foot = page.getByRole('navigation', { name: 'Footer' });
  for (const [label, id] of SECTIONS) {
    await foot.scrollIntoViewIfNeeded();
    await foot.getByRole('link', { name: label, exact: true }).click();
    await expectScrolledTo(page, id);
  }
  await expect(page.getByText('© 2026 Nivesh Gajengi · MIT License')).toBeVisible();
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('the lead is drawn paid-out, with no animation, and anchors jump instantly', async ({ page }) => {
    await openEvidence(page);
    const lead = page.locator('figure.rl');
    await expect(lead).toHaveAttribute('data-phase', 'static');
    await lead.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await expect(lead).toHaveAttribute('data-phase', 'static');
    const anim = await page.locator('.rl-cord').evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe('none');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('link', { name: /Read the walk log/ }).click();
    await expectScrolledTo(page, 'walk');
    if (!isMobile(page)) await lead.screenshot({ path: test.info().outputPath('lead-reduced-motion.png') });
  });
});

test.describe('narrowest phones', () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test('no horizontal scroll at 320px on the landing, the console or /evidence', async ({ page }) => {
    for (const id of ['how', 'proof', 'live', 'console', 'audit']) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expectNoHorizontalScroll(page);
    }
    await openEvidence(page);
    for (const id of ['tag', 'lead', 'snaps', 'walk', 'paypal']) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expectNoHorizontalScroll(page);
    }
  });
});
