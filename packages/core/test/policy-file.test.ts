import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { getDefaultPolicy } from '../src/policy/policy.js';

// <LEASH_HOME>/policy.json holds the owner's policy salts. Once a policy is registered and funded, those
// salts are the only way to spend from it, so the file must never be silently replaced.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-policyfile-'));
const saved = { home: process.env.LEASH_HOME, cap: process.env.LEASH_DAILY_CAP_CENTS, pp: process.env.PAYPAL_PAYEE_MERCHANT_ID, demo: process.env.LEASH_DEMO };
process.env.LEASH_HOME = home;
delete process.env.LEASH_DEMO;
const file = path.join(home, 'policy.json');
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')).policyCommitment as string;
const env = (cap?: string, pp?: string) => {
  if (cap === undefined) delete process.env.LEASH_DAILY_CAP_CENTS;
  else process.env.LEASH_DAILY_CAP_CENTS = cap;
  if (pp === undefined) delete process.env.PAYPAL_PAYEE_MERCHANT_ID;
  else process.env.PAYPAL_PAYEE_MERCHANT_ID = pp;
};

afterEach(() => env(saved.cap, saved.pp));
afterAll(() => {
  for (const [k, v] of [['LEASH_HOME', saved.home], ['LEASH_DEMO', saved.demo]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('getDefaultPolicy never overwrites policy.json', () => {
  let first: string;

  it('creates it once (daily cap 700)', () => {
    env('700');
    first = getDefaultPolicy().policyCommitment;
    expect(onDisk()).toBe(first);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('another process with a different daily cap fails loudly and leaves the file alone', () => {
    env(undefined); // default 1500
    expect(() => getDefaultPolicy()).toThrow(/policy\.json was created with daily cap 700 cents .* set LEASH_DAILY_CAP_CENTS=700 or move it aside/s);
    expect(onDisk()).toBe(first);
  });

  it('a different PayPal merchant (allowlist) fails loudly too', () => {
    env('700', 'ABCDEFGHJKLMN');
    expect(() => getDefaultPolicy()).toThrow(/merchants \[openai, .*supabase\],.* merchants \[openai, .*paypal-sandbox-merchant\(ABCDEFGHJKLMN\)\]/s);
    expect(onDisk()).toBe(first);
  });

  it('the original configuration still gets the same policy', () => {
    env('700');
    expect(getDefaultPolicy().policyCommitment).toBe(first);
    expect(onDisk()).toBe(first);
  });
});
