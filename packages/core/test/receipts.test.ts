import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PayGateway } from '../src/gateway/payGateway.js';
import { Receipt, ReceiptStore } from '../src/gateway/receipts.js';
import { PayPalService } from '../src/paypal/paypal.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-receipts-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const fresh = () => fs.mkdtempSync(path.join(root, 'd-'));
const POLICY = '0x' + 'ab'.repeat(32);
const receipt = (nonce: string, extra: Partial<Receipt> = {}): Receipt => ({
  policyId: POLICY,
  nonce,
  amountCents: 300,
  merchantIdHash: '0x' + '1'.repeat(64),
  recipient: '0x' + '2'.repeat(40),
  epoch: 20748,
  newSpendCommit: '0x' + '3'.repeat(64),
  proofKeccak: '0x' + '4'.repeat(64),
  vkHash: 'test',
  proofTarget: 'default',
  rail: 'paypal',
  status: 'AWAITING_APPROVAL',
  ts: new Date().toISOString(),
  ...extra,
});

describe('ReceiptStore survives a torn write', () => {
  it('a half-written last line is skipped and reported; reads and nonce checks keep working', () => {
    const dir = fresh();
    new ReceiptStore(dir).put(receipt('1'));
    fs.appendFileSync(path.join(dir, 'receipts.jsonl'), '{"policyId":"0xab'); // crash mid-append
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new ReceiptStore(dir);
    expect(store.list().map((r) => r.nonce)).toEqual(['1']);
    expect(store.isNonceUsed(POLICY, '1')).toBe(true);
    expect(store.isNonceUsed(POLICY, '2')).toBe(false);
    expect(store.corruptLines()).toEqual([2]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('line 2 is not valid JSON'));
    // The next receipt starts on its own line and is readable by any process
    store.put(receipt('2'));
    const again = new ReceiptStore(dir);
    expect(again.list().map((r) => r.nonce).sort()).toEqual(['1', '2']);
    expect(again.corruptLines()).toEqual([2]);
    warn.mockRestore();
  });
});

describe('ReceiptStore sees receipts another process wrote', () => {
  it('a store that already loaded the log picks up a later append (Express gateway + Next console share it)', () => {
    const dir = fresh();
    const gatewayView = new ReceiptStore(dir);
    expect(gatewayView.isNonceUsed(POLICY, '7')).toBe(false); // loads (empty) index
    new ReceiptStore(dir).put(receipt('7', { status: 'COMPLETED', captureId: '3C679366HH908993F' }));
    expect(gatewayView.isNonceUsed(POLICY, '7')).toBe(true);
    expect(gatewayView.get(POLICY, '7')?.status).toBe('COMPLETED');
  });
});

describe('PayGateway writes its state files atomically', () => {
  it('policies.json and spend.json go to a temp file that is renamed over the target', () => {
    const dir = fresh();
    const gw = new PayGateway({ dir, paypal: new PayPalService({ clientId: '', clientSecret: '' }) });
    const write = vi.spyOn(fs, 'writeFileSync');
    const rename = vi.spyOn(fs, 'renameSync');
    try {
      gw.register({ owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', policyCommitment: '0x' + '0a'.repeat(32) }, { trustedOwnerDevice: true });
      const target = path.join(dir, 'policies.json');
      const tmpWrite = write.mock.calls.find((c) => String(c[0]).startsWith(`${target}.`) && String(c[0]).endsWith('.tmp'));
      expect(tmpWrite, 'policies.json written via a temp file').toBeTruthy();
      expect(write.mock.calls.some((c) => String(c[0]) === target)).toBe(false);
      expect(rename).toHaveBeenCalledWith(tmpWrite![0], target);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(gw.policies()).toHaveLength(1);
    } finally {
      write.mockRestore();
      rename.mockRestore();
    }
  });

  it('an unreadable spend.json fails closed with a readable error (it never resets the daily cap)', () => {
    const dir = fresh();
    const gw = new PayGateway({ dir, paypal: new PayPalService({ clientId: '', clientSecret: '' }) });
    fs.writeFileSync(path.join(dir, 'spend.json'), '{"0xab": {"epoch": 2074');
    expect(() => gw.spendState(POLICY)).toThrow(/spend\.json is not valid JSON .* restore it/);
  });
});
