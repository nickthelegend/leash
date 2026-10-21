import { describe, expect, it } from 'vitest';
import { keccakWords, paypalPayee, policyIdOf } from '../src/crypto/evm.js';
import {
  assertCaptureMatches,
  buildCaptureHeaders,
  buildCreateOrderBody,
  buildCreateOrderHeaders,
  buildPaymentTokenBody,
  buildSetupTokenBody,
  centsToValue,
  extractApproveLink,
  leashCustomId,
  leashInvoiceId,
  leashRequestId,
  PayPalService,
  PayPalSetupRequired,
  valueToCents,
} from '../src/paypal/paypal.js';

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const COMMITMENT = '0x09133620fa909d1ae63144fe7b802a6746fe87be8b3ed165aed34d165383acff';
const POLICY_ID = policyIdOf(OWNER, COMMITMENT);
const MERCHANT = 'ABCDEFGHJKLMN';
const proven = { policyId: POLICY_ID, nonce: '3001', amountCents: 300, payeeMerchantId: MERCHANT };

describe('EVM helpers', () => {
  it('policyIdOf matches keccak256(abi.encode(owner, commitment))', () => {
    // cast keccak $(cast abi-encode 'f(address,bytes32)' $OWNER $COMMITMENT)
    expect(POLICY_ID).toBe('0xcfce5a7d693fa59ef970500f58fdd5df69adf8c16548a2bf82485fa17bdc60e2');
    expect(POLICY_ID).toBe(keccakWords(OWNER, COMMITMENT));
    expect(keccakWords()).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'); // keccak256("")
  });

  it('paypalPayee is a 160-bit value and rejects malformed merchant ids', () => {
    expect(paypalPayee(MERCHANT)).toMatch(/^0x[0-9a-f]{40}$/);
    expect(paypalPayee(MERCHANT)).not.toBe(paypalPayee('ABCDEFGHJKLMP'));
    expect(() => paypalPayee('abc')).toThrow(/Invalid PayPal merchant id/);
    expect(() => paypalPayee('ABCDEFGHIJKLM')).toThrow(); // I is not in the PayPal alphabet
  });
});

describe('PayPal Orders v2 builders (pure)', () => {
  it('derives custom_id, invoice_id and request ids deterministically from (policyId, nonce)', () => {
    expect(leashCustomId(POLICY_ID, '3001')).toBe(keccakWords(POLICY_ID, 3001n));
    expect(leashInvoiceId(POLICY_ID, '3001')).toBe(`leash-${POLICY_ID}-3001`);
    expect(leashInvoiceId(POLICY_ID, '3001').length).toBeLessThanOrEqual(127);
    expect(leashRequestId(POLICY_ID, '3001', 'create')).toBe(`leash-${POLICY_ID}-3001-create`);
    expect(leashRequestId(POLICY_ID, '3001', 'capture')).toBe(`leash-${POLICY_ID}-3001-capture`);
  });

  it('converts cents exactly', () => {
    expect(centsToValue(300)).toBe('3.00');
    expect(centsToValue(5)).toBe('0.05');
    expect(centsToValue(123456)).toBe('1234.56');
    expect(valueToCents('3.00')).toBe(300);
    expect(valueToCents('3')).toBe(300);
    expect(valueToCents('0.5')).toBe(50);
    expect(() => valueToCents('3.001')).toThrow();
  });

  it('human mode: intent CAPTURE, payee.merchant_id, custom_id, experience_context', () => {
    const body: any = buildCreateOrderBody(proven, {
      kind: 'human',
      returnUrl: 'http://localhost:3000/console?paypal=return',
      cancelUrl: 'http://localhost:3000/console?paypal=cancel',
    });
    expect(body.intent).toBe('CAPTURE');
    const pu = body.purchase_units[0];
    expect(pu.payee).toEqual({ merchant_id: MERCHANT });
    expect(pu.amount).toEqual({ currency_code: 'USD', value: '3.00' });
    expect(pu.custom_id).toBe(leashCustomId(POLICY_ID, '3001'));
    expect(pu.invoice_id).toBe(`leash-${POLICY_ID}-3001`);
    expect(body.payment_source.paypal.experience_context).toMatchObject({
      return_url: 'http://localhost:3000/console?paypal=return',
      cancel_url: 'http://localhost:3000/console?paypal=cancel',
      user_action: 'PAY_NOW',
    });
    expect(body.payment_source.paypal.vault_id).toBeUndefined();
  });

  it('agent mode: payment_source.paypal.vault_id and no experience_context', () => {
    const body: any = buildCreateOrderBody(proven, { kind: 'vault', vaultId: 'jwgvx42' });
    expect(body.payment_source).toEqual({ paypal: { vault_id: 'jwgvx42' } });
    expect(() => buildCreateOrderBody(proven, { kind: 'vault', vaultId: '' })).toThrow(/vault_id/);
  });

  it('rejects malformed proven payments before any request', () => {
    const human = { kind: 'human' as const, returnUrl: 'x', cancelUrl: 'y' };
    expect(() => buildCreateOrderBody({ ...proven, amountCents: 0 }, human)).toThrow();
    expect(() => buildCreateOrderBody({ ...proven, nonce: '12a' }, human)).toThrow();
    expect(() => buildCreateOrderBody({ ...proven, policyId: '0x12' }, human)).toThrow();
    expect(() => buildCreateOrderBody({ ...proven, payeeMerchantId: 'nope' }, human)).toThrow();
  });

  it('headers carry the deterministic PayPal-Request-Id', () => {
    expect(buildCreateOrderHeaders(proven, 'T')['PayPal-Request-Id']).toBe(`leash-${POLICY_ID}-3001-create`);
    expect(buildCaptureHeaders(proven, 'T')['PayPal-Request-Id']).toBe(`leash-${POLICY_ID}-3001-capture`);
    expect(buildCreateOrderHeaders(proven, 'T').Authorization).toBe('Bearer T');
  });

  it('Vault v3 setup-token and payment-token bodies', () => {
    const s: any = buildSetupTokenBody({ returnUrl: 'r', cancelUrl: 'c' });
    expect(s.payment_source.paypal.usage_type).toBe('MERCHANT');
    expect(s.payment_source.paypal.experience_context).toMatchObject({ return_url: 'r', cancel_url: 'c' });
    expect(buildPaymentTokenBody('5C991763VB2781612')).toEqual({
      payment_source: { token: { id: '5C991763VB2781612', type: 'SETUP_TOKEN' } },
    });
  });

  it('prefers the payer-action link, falls back to approve', () => {
    expect(extractApproveLink({ links: [{ rel: 'self', href: 's' }, { rel: 'payer-action', href: 'pa' }] })).toBe('pa');
    expect(extractApproveLink({ links: [{ rel: 'approve', href: 'ap' }] })).toBe('ap');
    expect(extractApproveLink({ links: [] })).toBeUndefined();
  });
});

describe('capture assertion (pure, on response-shaped objects)', () => {
  const cid = leashCustomId(POLICY_ID, '3001');
  const resp = (status: string, capStatus: string, value: string, currency = 'USD') => ({
    id: '5O190127TN364715T',
    status,
    purchase_units: [{ payments: { captures: [{ id: '3C679366HH908993F', status: capStatus, custom_id: cid, amount: { currency_code: currency, value } }] } }],
  });

  it('accepts COMPLETED with exactly the proven amount', () => {
    expect(assertCaptureMatches(resp('COMPLETED', 'COMPLETED', '3.00'), { amountCents: 300, customId: cid })).toMatchObject({
      orderId: '5O190127TN364715T',
      captureId: '3C679366HH908993F',
      amountCents: 300,
    });
  });

  it('rejects a non-COMPLETED order, a declined capture, a wrong amount, currency or custom_id', () => {
    expect(() => assertCaptureMatches(resp('PAYER_ACTION_REQUIRED', 'COMPLETED', '3.00'), { amountCents: 300 })).toThrow(/not COMPLETED/);
    expect(() => assertCaptureMatches(resp('COMPLETED', 'DECLINED', '3.00'), { amountCents: 300 })).toThrow(/DECLINED/);
    expect(() => assertCaptureMatches(resp('COMPLETED', 'COMPLETED', '3.01'), { amountCents: 300 })).toThrow(/301 cents != proven 300/);
    expect(() => assertCaptureMatches(resp('COMPLETED', 'COMPLETED', '3.00', 'EUR'), { amountCents: 300 })).toThrow(/currency/);
    expect(() => assertCaptureMatches(resp('COMPLETED', 'COMPLETED', '3.00'), { amountCents: 300, customId: '0xbeef' })).toThrow(/custom_id/);
  });
});

describe('PayPal live sandbox', () => {
  const svc = new PayPalService();
  const live = svc.isConfigured();
  if (!live) {
    // Visible in the test output: the live path is not faked.
    console.warn(`[paypal.test] ${svc.setupStatus().message}: live sandbox test skipped`);
  }

  it('without credentials every live call throws Setup required', async () => {
    const empty = new PayPalService({ clientId: '', clientSecret: '' });
    expect(empty.setupStatus().message).toBe('Setup required (PAYPAL_CLIENT_ID)');
    await expect(empty.getAccessToken()).rejects.toBeInstanceOf(PayPalSetupRequired);
    await expect(
      empty.createOrder(proven, { kind: 'human', returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c' })
    ).rejects.toThrow('Setup required (PAYPAL_CLIENT_ID)');
  });

  it.skipIf(!live)('Setup required (PAYPAL_CLIENT_ID) unless set: sandbox order is created with an approve link', async () => {
    const order = await svc.createOrder(
      { ...proven, nonce: String(Date.now()), payeeMerchantId: process.env.PAYPAL_PAYEE_MERCHANT_ID ?? MERCHANT },
      { kind: 'human', returnUrl: 'https://example.com/return', cancelUrl: 'https://example.com/cancel' }
    );
    expect(order.status).toBe('PAYER_ACTION_REQUIRED');
    expect(order.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
  });
});
