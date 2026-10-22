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

describe('ReceiptStore index after its own writes', () => {
  it('its own appends update the index without re-reading the log; another store\'s append is still picked up', () => {
    const d = fresh();
    const a = new ReceiptStore(d);
    const b = new ReceiptStore(d);
    a.put(receipt('9001'));
    a.list();
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      for (let i = 0; i < 20; i++) a.put(receipt(String(9100 + i)));
      expect(a.list().length).toBe(21);
      expect(reads.mock.calls.filter(([f]) => String(f).endsWith('receipts.jsonl'))).toEqual([]);
      b.put(receipt('9200')); // another process sharing LEASH_HOME
      a.put(receipt('9201'));
      expect(a.get(POLICY, '9200')).toBeDefined();
      expect(a.list().length).toBe(23);
    } finally {
      reads.mockRestore();
    }
  });
});

describe('throwaway console registrations are pruned', () => {
  it('registering a console (ephemeral) policy drops ephemeral ones older than a day that have no receipts and no spend', () => {
    const d = fresh();
    const gw = new PayGateway({ dir: d, paypal: new PayPalService({ clientId: '', clientSecret: '' }) });
    const owner = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    const c = (n: number) => '0x' + n.toString(16).padStart(64, '0');
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const ids = [1, 2, 3, 4].map((n) => gw.register({ owner, policyCommitment: c(n) }, { trustedOwnerDevice: true, ephemeral: n !== 3 }).policyId);
    // Age them: 1 (ephemeral, unused), 2 (ephemeral, has a receipt), 3 (not ephemeral), 4 (ephemeral, has spend)
    const all = JSON.parse(fs.readFileSync(path.join(d, 'policies.json'), 'utf8'));
    for (const id of ids) all[id].createdAt = old;
    fs.writeFileSync(path.join(d, 'policies.json'), JSON.stringify(all));
    gw.receipts.put({ ...receipt('1'), policyId: ids[1] });
    fs.writeFileSync(path.join(d, 'spend.json'), JSON.stringify({ [ids[3]]: { epoch: 1, commit: c(9) } }));
    const fresh5 = gw.register({ owner, policyCommitment: c(5) }, { trustedOwnerDevice: true, ephemeral: true });
    expect(gw.policies().map((p) => p.policyId).sort()).toEqual([ids[1], ids[2], ids[3], fresh5.policyId].sort());
    expect(gw.policy(ids[2])!.ephemeral).toBeUndefined();
    expect(fresh5.ephemeral).toBe(true);
  });
});
