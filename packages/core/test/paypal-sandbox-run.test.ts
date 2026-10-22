import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { GatewayError, PayGateway } from '../src/gateway/payGateway.js';
import { PayPalService } from '../src/paypal/paypal.js';
import { runPayPalSandboxOrder } from '../src/paypal/sandboxRun.js';

// `pnpm paypal:e2e` goes through the verify-only gateway (register, nonce, spend chain, payee, receipt),
// not straight to the PayPal client. Without keys the gateway stops at Setup required and consumes nothing.
const ROOT = path.resolve(__dirname, '../../..');
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-sandboxrun-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('paypal:e2e runs through PayGateway', () => {
  it('without PayPal keys: registers, proves, reaches gateway.pay and gets 503 "Proof verified; nothing consumed", no nonce or spend used', async () => {
    const gateway = new PayGateway({ dir, paypal: new PayPalService({ clientId: '', clientSecret: '' }) });
    const lines: string[] = [];
    let approveCalled = false;
    let err: unknown;
    try {
      await runPayPalSandboxOrder({
        gateway,
        owner: OWNER,
        merchantId: 'ABCDEFGHJKLMN',
        nonce: '8001',
        log: (l) => lines.push(l),
        approve: async () => {
          approveCalled = true;
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(503);
    expect((err as GatewayError).message).toBe('Proof verified; nothing consumed. Setup required (PAYPAL_CLIENT_ID)');
    expect(approveCalled).toBe(false);
    const [reg] = gateway.policies();
    expect(reg.owner).toBe(OWNER.toLowerCase());
    expect(lines.join('\n')).toMatch(/proof {5}verified by bb .* 300 cents/);
    expect(gateway.receipts.isNonceUsed(reg.policyId, '8001')).toBe(false);
    expect(gateway.spendState(reg.policyId)).toBeUndefined();
  }, 60_000);

  it('the script uses that path, and without keys it prints Setup required and exits 1 with no PayPal call', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/paypal-sandbox-e2e.ts'), 'utf8');
    expect(src).toContain('runPayPalSandboxOrder');
    expect(src).toContain('verify-receipt.ts');
    expect(src).not.toMatch(/\.(createOrder|captureOrder)\(/);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PAYPAL_')));
    const cwd = fs.mkdtempSync(path.join(dir, 'cwd-')); // no .env.local here
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'scripts/paypal-sandbox-e2e.ts')], { cwd, env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Setup required (PAYPAL_CLIENT_ID)');
    expect(r.stderr).toContain('No PayPal call was made');
  }, 60_000);

  it('pnpm paypal:vault (agent-mode vault id) without keys: Setup required (PAYPAL_CLIENT_ID), exit 1, no PayPal call', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['paypal:vault']).toBe('tsx scripts/paypal-vault.ts');
    const src = fs.readFileSync(path.join(ROOT, 'scripts/paypal-vault.ts'), 'utf8');
    expect(src).toContain('createVaultSetupToken');
    expect(src).toContain('createVaultPaymentToken');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PAYPAL_')));
    const cwd = fs.mkdtempSync(path.join(dir, 'cwd-')); // no .env.local here
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'scripts/paypal-vault.ts')], { cwd, env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr.split('\n')[0]).toBe('Setup required (PAYPAL_CLIENT_ID) — also missing: PAYPAL_CLIENT_SECRET');
    expect(r.stderr).toContain('No PayPal call was made');
  }, 60_000);
});
