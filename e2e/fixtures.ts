import { test as base, expect, type Page } from '@playwright/test';

export const BASE = process.env.LEASH_E2E_BASE_URL ?? 'http://127.0.0.1:3107';

/**
 * Every page is watched for console errors, page errors and failed same-origin requests.
 * A test that expects an honest non-2xx answer (e.g. /api/pay -> 503 Setup required) says so with
 * guard.allow(path, status); everything else fails the test at teardown.
 * Chrome also prints "Failed to load resource: ... status of N" for any non-2xx fetch; those console
 * lines are not counted twice: the response itself is checked (it carries the URL).
 */
type Guard = { allow: (pathPart: string, status: number) => void; problems: string[] };

export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page }, use) => {
      const allowed: Array<{ pathPart: string; status: number }> = [];
      const problems: string[] = [];
      const origin = new URL(BASE).origin;
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (/^Failed to load resource: the server responded with a status of \d+/.test(m.text())) return;
        problems.push(`console error: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      page.on('requestfailed', (r) => {
        if (!r.url().startsWith(origin)) return;
        const why = r.failure()?.errorText ?? '';
        // Navigating away (anchor jump, reload) aborts in-flight RSC/prefetch requests; that's not a failure.
        if (/ERR_ABORTED/.test(why)) return;
        problems.push(`request failed: ${r.method()} ${r.url()} ${why}`);
      });
      page.on('response', (r) => {
        if (!r.url().startsWith(origin) || r.status() < 400) return;
        const path = new URL(r.url()).pathname;
        if (allowed.some((a) => path.includes(a.pathPart) && a.status === r.status())) return;
        problems.push(`HTTP ${r.status()}: ${r.request().method()} ${path}`);
      });
      await use({ allow: (pathPart, status) => allowed.push({ pathPart, status }), problems });
      expect(problems, 'console errors / failed same-origin requests').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** No horizontal scroll: the document is never wider than the viewport. */
export async function expectNoHorizontalScroll(page: Page) {
  const [scrollW, innerW] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollW, `scrollWidth ${scrollW} > innerWidth ${innerW}`).toBeLessThanOrEqual(innerW);
}

/** After an anchor jump (smooth or instant), the element's top edge settles at the top of the viewport. */
export async function expectScrolledTo(page: Page, id: string) {
  await expect
    .poll(async () => page.evaluate((i) => Math.abs(Math.round(document.getElementById(i)!.getBoundingClientRect().top)), id), {
      message: `#${id} should be scrolled to the top of the viewport`,
      timeout: 8000,
    })
    .toBeLessThanOrEqual(2);
}

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;
