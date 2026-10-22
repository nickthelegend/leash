import { defineConfig } from '@playwright/test';

/**
 * Real-browser E2E for LEASH. Start the real stack first: `e2e/stack.sh start` (Anvil + contracts +
 * escrow-funded demo policy, the verify-only Express gateway and the console with owner-device mode
 * on, all on 127.0.0.1), then `pnpm test:e2e`. Stop it with `e2e/stack.sh stop`.
 * Runs in the installed Google Chrome. Proofs are real (nargo + bb), so timeouts are generous.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/test-results',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'e2e/playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.LEASH_E2E_BASE_URL ?? 'http://127.0.0.1:3107',
    channel: 'chrome',
    video: 'on',
    trace: 'on',
    screenshot: 'on',
    actionTimeout: 20_000,
  },
  projects: [
    // leash-mcp driven over MCP stdio (no LLM) against the Anvil contracts; the console specs read its receipts.
    { name: 'chain', testMatch: /anvil-mcp\.spec\.ts/ },
    {
      name: 'desktop',
      testIgnore: /anvil-mcp\.spec\.ts/,
      dependencies: ['chain'],
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      testIgnore: /anvil-mcp\.spec\.ts/,
      dependencies: ['chain'],
      use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
    },
  ],
});
