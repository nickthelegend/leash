/**
 * PayPal Orders v2 + Vault v3 client for LEASH. Every order is created only for a payment whose
 * proof already verified, and is tied to that proof by (policyId, nonce):
 *
 *   custom_id   = keccak256(abi.encode(policyId, nonce))     (hidden from the payer, in reports)
 *   invoice_id  = leash-<policyId>-<nonce>                     (unique per merchant account)
 *   PayPal-Request-Id = leash-<keccak256(abi.encode(policyId, nonce)) as 64 hex>-create / -capture
 *                       (idempotent retries; 78 chars for any nonce)
 *
 * Field names and limits are from the Orders v2 OpenAPI schema,
 * https://developer.paypal.com/api/orders/v2/schema.json :
 *   purchase_units[].custom_id 1..255, invoice_id 1..127, reference_id 1..256,
 *   payee.merchant_id = 13-char account_id, amount.currency_code (3) + amount.value (string),
 *   order.status in CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED.
 * Idempotency: https://developer.paypal.com/api/rest/reference/idempotency/ (same PayPal-Request-Id
 * returns the earlier result instead of repeating the action).
 * Vault v3 (save PayPal without purchase, then charge with vault_id):
 * https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/
 *
 * Nothing here is ever faked: without PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET every live call throws
 * PayPalSetupRequired ("Setup required (PAYPAL_CLIENT_ID)").
 */
import { keccakWords, PAYPAL_MERCHANT_ID_RE } from '../crypto/evm.js';

export interface PayPalConfig {
  clientId?: string;
  clientSecret?: string;
  environment: 'sandbox' | 'live';
  /** Override the API host (default api-m.sandbox.paypal.com / api-m.paypal.com). */
  baseUrl?: string;
  /** Per-request timeout in ms (default 20000, PAYPAL_TIMEOUT_MS). */
  timeoutMs?: number;
}

export class PayPalSetupRequired extends Error {
  public readonly code = 'PAYPAL_SETUP_REQUIRED';
  constructor(public readonly missing: string[]) {
    // Report the first missing variable, e.g. "Setup required (PAYPAL_CLIENT_ID)"; all are in .missing.
    super(`Setup required (${missing[0]})`);
    this.name = 'PayPalSetupRequired';
  }
}

export class PayPalApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = 'PayPalApiError';
  }
}

/**
 * PayPal accepted the capture for exactly the proven amount but holds it as PENDING (for example
 * PENDING_REVIEW): not paid yet, and not a failure either, since it can still settle. The gateway
 * records it as CAPTURE_PENDING and never retries it.
 */
export class PayPalCapturePending extends PayPalApiError {
  readonly orderId: string;
  readonly captureId: string;
  readonly reason?: string;
  constructor(c: { orderId: string; captureId: string; reason?: string }, body?: unknown) {
    super(`Capture ${c.captureId} is PENDING at PayPal (${c.reason ?? 'no reason given'}); not paid yet`, undefined, body);
    this.name = 'PayPalCapturePending';
    this.orderId = c.orderId;
    this.captureId = c.captureId;
    this.reason = c.reason;
  }
}

/** A payment the ZK proof already approved; the order must match it exactly. */
export interface ProvenPayment {
  /** keccak256(abi.encode(owner, commitment)), 0x + 64 hex */
  policyId: string;
  /** decimal nonce string, as proven */
  nonce: string;
  /** proven amount in cents */
  amountCents: number;
  /** PayPal merchant id of the allowlisted payee (13 chars) */
  payeeMerchantId: string;
  currency?: string;
  description?: string;
}

/** How the buyer approves: a human clicks the approve link, or the agent charges a vaulted wallet. */
export type ApprovalMode =
  | { kind: 'human'; returnUrl: string; cancelUrl: string }
  | { kind: 'vault'; vaultId: string };

export interface CreatedOrder {
  orderId: string;
  status: string;
  /** rel "payer-action" (with experience_context) or "approve" (without) */
  approveUrl?: string;
  /** Set when the create call already captured (vault_id + intent CAPTURE returns COMPLETED). */
  capture?: VerifiedCapture;
  requestId: string;
  raw: unknown;
}

export interface VerifiedCapture {
  orderId: string;
  captureId: string;
  status: 'COMPLETED';
  amountCents: number;
  currency: string;
  customId?: string;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function assertProven(p: ProvenPayment): void {
  if (!HEX32.test(p.policyId)) throw new Error(`policyId must be 0x + 64 hex, got '${p.policyId}'`);
  if (!/^[0-9]{1,30}$/.test(p.nonce)) throw new Error(`nonce must be a decimal integer string, got '${p.nonce}'`);
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new Error('amountCents must be a positive integer');
  if (!PAYPAL_MERCHANT_ID_RE.test(p.payeeMerchantId)) {
    throw new Error(`payeeMerchantId '${p.payeeMerchantId}' is not a 13-char PayPal merchant id`);
  }
}

/** custom_id = keccak256(abi.encode(bytes32 policyId, uint256 nonce)) — 66 chars, under the 255 limit. */
export function leashCustomId(policyId: string, nonce: string): string {
  return keccakWords(policyId, nonce);
}

/** invoice_id = leash-<policyId>-<nonce> (<= 127 chars; unique per merchant account). */
export function leashInvoiceId(policyId: string, nonce: string): string {
  const id = `leash-${policyId.toLowerCase()}-${nonce}`;
  if (id.length > 127) throw new Error(`invoice_id too long (${id.length} > 127)`);
  return id;
}

/**
 * Deterministic PayPal-Request-Id so a retried create/capture can never double-charge. Built from the
 * hash of (policyId, nonce), so it is 78 characters for every nonce: the Orders v2 schema allows 10000,
 * PayPal's older API reference listed 1..108 (the vault call below caps at 108 too), and a
 * leash-<policyId>-<nonce>-capture id passed 108 from a 28-digit nonce on.
 */
export function leashRequestId(policyId: string, nonce: string, step: 'create' | 'capture'): string {
  return `leash-${keccakWords(policyId, nonce).slice(2, 66)}-${step}`;
}

/** 300 -> "3.00" (amount.value is a decimal string). */
export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`cents must be a non-negative integer, got ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** "3.00" -> 300, exact (no float math). */
export function valueToCents(value: string): number {
  const m = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!m) throw new Error(`Unexpected PayPal amount value '${value}'`);
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

/** Request body for POST /v2/checkout/orders. Pure; unit-tested. */
export function buildCreateOrderBody(p: ProvenPayment, mode: ApprovalMode): Record<string, unknown> {
  assertProven(p);
  const currency = p.currency ?? 'USD';
  const unit = {
    reference_id: `leash-${p.nonce}`,
    custom_id: leashCustomId(p.policyId, p.nonce),
    invoice_id: leashInvoiceId(p.policyId, p.nonce),
    description: (p.description ?? 'LEASH proof-verified agent payment').slice(0, 127),
    amount: { currency_code: currency, value: centsToValue(p.amountCents) },
    payee: { merchant_id: p.payeeMerchantId },
  };
  const paypal =
    mode.kind === 'vault'
      ? { vault_id: mode.vaultId }
      : {
          experience_context: {
            return_url: mode.returnUrl,
            cancel_url: mode.cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
          },
        };
  if (mode.kind === 'vault' && !mode.vaultId) throw new Error('vault mode needs a vault_id (payment token id)');
  return { intent: 'CAPTURE', purchase_units: [unit], payment_source: { paypal } };
}

export function buildCreateOrderHeaders(p: ProvenPayment, accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'PayPal-Request-Id': leashRequestId(p.policyId, p.nonce, 'create'),
    // Full order in the response (default is return=minimal: id, status, links only).
    Prefer: 'return=representation',
  };
}

export function buildCaptureHeaders(p: Pick<ProvenPayment, 'policyId' | 'nonce'>, accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'PayPal-Request-Id': leashRequestId(p.policyId, p.nonce, 'capture'),
    Prefer: 'return=representation',
  };
}

/** Body for POST /v3/vault/setup-tokens: save the owner's PayPal wallet for merchant-initiated use. */
export function buildSetupTokenBody(opts: { returnUrl: string; cancelUrl: string; description?: string }): Record<string, unknown> {
  return {
    payment_source: {
      paypal: {
        description: (opts.description ?? 'LEASH agent spending (proof-gated)').slice(0, 128),
        usage_type: 'MERCHANT',
        usage_pattern: 'IMMEDIATE',
        customer_type: 'CONSUMER',
        permit_multiple_payment_tokens: false,
        // Fields from PayPal's PayPal-wallet setup-token sample. `user_action: SETUP_NOW` is documented
        // only for cards, so it is not sent for a PayPal wallet.
        experience_context: {
          return_url: opts.returnUrl,
          cancel_url: opts.cancelUrl,
          shipping_preference: 'NO_SHIPPING',
        },
      },
    },
  };
}

/** Body for POST /v3/vault/payment-tokens: exchange the approved setup token for a payment token (vault_id). */
export function buildPaymentTokenBody(setupTokenId: string): Record<string, unknown> {
  if (!setupTokenId) throw new Error('setupTokenId required');
  return { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } };
}

type Link = { href: string; rel: string; method?: string };

/** The URL the buyer opens: rel "payer-action" (payment_source with experience_context) or "approve". */
export function extractApproveLink(resp: { links?: Link[] }): string | undefined {
  const links = resp.links ?? [];
  return (links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve'))?.href;
}

/**
 * Accept a capture only if the order is COMPLETED and purchase_units[0].payments.captures[0] is
 * COMPLETED for exactly the proven amount (PayPal: a COMPLETED order can still hold a DECLINED
 * capture, so check the capture itself). A PENDING capture for exactly the proven amount throws
 * PayPalCapturePending; anything else throws PayPalApiError.
 */
export function assertCaptureMatches(
  resp: any,
  expected: { amountCents: number; currency?: string; customId?: string }
): VerifiedCapture {
  const orderId = resp?.id;
  const unit = resp?.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  const currency = expected.currency ?? 'USD';
  /** Amount, currency and custom_id of the capture must be the proven ones (also for a PENDING capture). */
  const checkCapture = () => {
    if (cap.amount?.currency_code !== currency) {
      throw new PayPalApiError(`Capture currency ${cap.amount?.currency_code} != ${currency}`, undefined, resp);
    }
    const cents = valueToCents(String(cap.amount?.value));
    if (cents !== expected.amountCents) {
      throw new PayPalApiError(`Captured ${cents} cents != proven ${expected.amountCents} cents`, undefined, resp);
    }
    const cid: string | undefined = cap.custom_id ?? unit?.custom_id;
    if (expected.customId && cid && cid !== expected.customId) {
      throw new PayPalApiError(`custom_id ${cid} != expected ${expected.customId}`, undefined, resp);
    }
    return { cents, cid };
  };
  if (cap?.status === 'PENDING') {
    checkCapture();
    throw new PayPalCapturePending({ orderId, captureId: cap.id, reason: cap.status_details?.reason }, resp);
  }
  if (resp?.status !== 'COMPLETED') {
    throw new PayPalApiError(`Order ${orderId ?? '?'} status is ${resp?.status ?? 'missing'}, not COMPLETED`, undefined, resp);
  }
  if (!cap) throw new PayPalApiError(`Order ${orderId} has no capture`, undefined, resp);
  if (cap.status !== 'COMPLETED') {
    throw new PayPalApiError(`Capture ${cap.id} status is ${cap.status}, not COMPLETED`, undefined, resp);
  }
  const { cents: captured, cid: customId } = checkCapture();
  return { orderId, captureId: cap.id, status: 'COMPLETED', amountCents: captured, currency, customId };
}

export class PayPalService {
  private clientId?: string;
  private clientSecret?: string;
  readonly baseUrl: string;
  readonly environment: 'sandbox' | 'live';
  readonly timeoutMs: number;
  /** OAuth token, reused until a minute before it expires. */
  private token?: { value: string; expiresAt: number };

  constructor(config?: Partial<PayPalConfig>) {
    this.clientId = config?.clientId ?? process.env.PAYPAL_CLIENT_ID;
    this.clientSecret = config?.clientSecret ?? process.env.PAYPAL_CLIENT_SECRET;
    this.environment = (config?.environment ?? process.env.PAYPAL_ENVIRONMENT) === 'live' ? 'live' : 'sandbox';
    this.baseUrl = (config?.baseUrl ?? (this.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')).replace(/\/$/, '');
    this.timeoutMs = config?.timeoutMs ?? (Number(process.env.PAYPAL_TIMEOUT_MS) || 20_000);
  }

  /** Names of the env vars that are missing, e.g. ['PAYPAL_CLIENT_ID']. Never the values. */
  missing(): string[] {
    const m: string[] = [];
    if (!this.clientId?.trim()) m.push('PAYPAL_CLIENT_ID');
    if (!this.clientSecret?.trim()) m.push('PAYPAL_CLIENT_SECRET');
    return m;
  }

  isConfigured(): boolean {
    return this.missing().length === 0;
  }

  /** "Setup required (PAYPAL_CLIENT_ID)" style status for UIs and scripts. */
  setupStatus(): { configured: boolean; message: string; missing: string[]; environment: string } {
    const missing = this.missing();
    return {
      configured: missing.length === 0,
      missing,
      environment: this.environment,
      message: missing.length ? `Setup required (${missing[0]})` : `Configured (${this.environment})`,
    };
  }

  private requireConfigured(): void {
    const missing = this.missing();
    if (missing.length) throw new PayPalSetupRequired(missing);
  }

  /** Network failure or timeout as a readable message (never the request headers). */
  private netError(e: unknown): string {
    const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `no answer within ${this.timeoutMs} ms`;
    return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
  }

  /**
   * OAuth 2.0 client-credentials token: POST /v1/oauth2/token. Cached until a minute before expiry, so
   * the gateway can check the credentials before it consumes a nonce without a second round trip later.
   */
  async getAccessToken(): Promise<string> {
    this.requireConfigured();
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new PayPalApiError(`PayPal authentication failed: ${this.netError(e)}`);
    }
    if (!res.ok) throw new PayPalApiError(`PayPal authentication failed (${res.status}): ${await res.text()}`, res.status);
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    if (!data.access_token) throw new PayPalApiError('PayPal authentication failed: no access_token in the response', res.status);
    const ttlMs = Math.max(0, (Number(data.expires_in) || 0) - 60) * 1000;
    this.token = ttlMs > 0 ? { value: data.access_token, expiresAt: Date.now() + ttlMs } : undefined;
    return data.access_token;
  }

  private async call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new PayPalApiError(`PayPal ${method} ${path} failed: ${this.netError(e)}`);
    }
    if (res.status === 401) this.token = undefined; // expired or revoked: fetch a new one next time
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const detail = json?.details?.[0]?.issue ?? json?.name ?? '';
      throw new PayPalApiError(`PayPal ${method} ${path} failed (${res.status}) ${detail}: ${json?.message ?? text}`.trim(), res.status, json);
    }
    return json;
  }

  /**
   * POST /v2/checkout/orders for a proven payment. Human mode returns the approve link
   * (status PAYER_ACTION_REQUIRED). Vault mode (payment_source.paypal.vault_id, intent CAPTURE)
   * is captured by PayPal in the same call; the capture is checked against the proven amount.
   */
  async createOrder(p: ProvenPayment, mode: ApprovalMode): Promise<CreatedOrder> {
    const body = buildCreateOrderBody(p, mode);
    const token = await this.getAccessToken();
    const headers = buildCreateOrderHeaders(p, token);
    const resp = await this.call('POST', '/v2/checkout/orders', headers, body);
    const out: CreatedOrder = {
      orderId: resp.id,
      status: resp.status,
      approveUrl: extractApproveLink(resp),
      requestId: headers['PayPal-Request-Id'],
      raw: resp,
    };
    if (mode.kind === 'vault') {
      out.capture = assertCaptureMatches(resp, {
        amountCents: p.amountCents,
        currency: p.currency,
        customId: leashCustomId(p.policyId, p.nonce),
      });
    } else if (!out.approveUrl) {
      throw new PayPalApiError(`Order ${resp.id} (${resp.status}) has no payer-action/approve link`, undefined, resp);
    }
    return out;
  }

  /** POST /v2/checkout/orders/{id}/capture after the buyer approved; asserts COMPLETED + exact amount. */
  async captureOrder(orderId: string, p: Pick<ProvenPayment, 'policyId' | 'nonce' | 'amountCents' | 'currency'>): Promise<VerifiedCapture> {
    if (!/^[A-Z0-9]{1,36}$/.test(orderId)) throw new Error(`Invalid PayPal order id '${orderId}'`);
    const token = await this.getAccessToken();
    const resp = await this.call('POST', `/v2/checkout/orders/${orderId}/capture`, buildCaptureHeaders(p, token), {});
    return assertCaptureMatches(resp, {
      amountCents: p.amountCents,
      currency: p.currency,
      customId: leashCustomId(p.policyId, p.nonce),
    });
  }

  /** GET /v2/checkout/orders/{id} (returns purchase_units[].custom_id and invoice_id). */
  async getOrder(orderId: string): Promise<any> {
    if (!/^[A-Z0-9]{1,36}$/.test(orderId)) throw new Error(`Invalid PayPal order id '${orderId}'`);
    const token = await this.getAccessToken();
    return this.call('GET', `/v2/checkout/orders/${orderId}`, { Authorization: `Bearer ${token}` });
  }

  /** Owner step 1 of agent mode: POST /v3/vault/setup-tokens, returns the approve link for the owner. */
  async createVaultSetupToken(opts: { returnUrl: string; cancelUrl: string }): Promise<{ setupTokenId: string; status: string; approveUrl?: string }> {
    const token = await this.getAccessToken();
    const resp = await this.call(
      'POST',
      '/v3/vault/setup-tokens',
      { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `leash-setup-${Date.now()}` },
      buildSetupTokenBody(opts)
    );
    return { setupTokenId: resp.id, status: resp.status, approveUrl: extractApproveLink(resp) };
  }

  /** Owner step 2: POST /v3/vault/payment-tokens with the approved setup token; returns the vault_id. */
  async createVaultPaymentToken(setupTokenId: string): Promise<{ vaultId: string; customerId?: string }> {
    const token = await this.getAccessToken();
    const resp = await this.call(
      'POST',
      '/v3/vault/payment-tokens',
      { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `leash-vault-${setupTokenId}`.slice(0, 108) },
      buildPaymentTokenBody(setupTokenId)
    );
    return { vaultId: resp.id, customerId: resp.customer?.id };
  }
}

export const paypalService = new PayPalService();
