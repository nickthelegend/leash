export interface PayPalConfig {
  clientId?: string;
  clientSecret?: string;
  environment: 'sandbox' | 'live';
}

export interface PayPalOrderResult {
  success: boolean;
  configured: boolean;
  orderId?: string;
  captureId?: string;
  status?: string;
  amount?: string;
  currency?: string;
  merchant?: string;
  nonce?: string;
  error?: string;
  rawResponse?: any;
}

export class PayPalService {
  private clientId?: string;
  private clientSecret?: string;
  private baseUrl: string;

  constructor(config?: Partial<PayPalConfig>) {
    this.clientId = config?.clientId || process.env.PAYPAL_CLIENT_ID;
    this.clientSecret = config?.clientSecret || process.env.PAYPAL_CLIENT_SECRET;
    const env = config?.environment || process.env.PAYPAL_ENVIRONMENT || 'sandbox';
    this.baseUrl =
      env === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
  }

  isConfigured(): boolean {
    return Boolean(
      this.clientId &&
        this.clientId.trim().length > 0 &&
        this.clientSecret &&
        this.clientSecret.trim().length > 0
    );
  }

  /**
   * Fetches OAuth 2.0 access token from PayPal REST API.
   */
  async getAccessToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(
        'PayPal credentials missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local'
      );
    }

    const auth = Buffer.from(
      `${this.clientId}:${this.clientSecret}`
    ).toString('base64');

    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`PayPal authentication failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  /**
   * Creates and captures a real PayPal order for an approved LEASH transaction.
   * Only called after ZK proof verification has passed!
   */
  async executeOrder(
    amountCents: number,
    merchantName: string,
    nonce: string
  ): Promise<PayPalOrderResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        configured: false,
        error:
          'PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET not configured in .env.local. ZK proof verified successfully, but live PayPal transaction was not dispatched.',
        amount: (amountCents / 100).toFixed(2),
        merchant: merchantName,
        nonce,
      };
    }

    try {
      const token = await this.getAccessToken();
      const amountFormatted = (amountCents / 100).toFixed(2);

      // 1. Create order
      const createRes = await fetch(`${this.baseUrl}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': `leash_${nonce}_${Date.now()}`,
        },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: `leash_nonce_${nonce}`,
              description: `LEASH ZK AI Agent purchase from ${merchantName}`,
              amount: {
                currency_code: 'USD',
                value: amountFormatted,
              },
            },
          ],
        }),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        return {
          success: false,
          configured: true,
          error: `PayPal Create Order failed (${createRes.status}): ${errText}`,
          amount: amountFormatted,
          merchant: merchantName,
          nonce,
        };
      }

      const orderData = (await createRes.json()) as { id: string; status: string };

      // 2. Capture order
      const captureRes = await fetch(
        `${this.baseUrl}/v2/checkout/orders/${orderData.id}/capture`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!captureRes.ok) {
        const errText = await captureRes.text();
        return {
          success: false,
          configured: true,
          orderId: orderData.id,
          status: orderData.status,
          error: `PayPal Capture Order failed (${captureRes.status}): ${errText}`,
          amount: amountFormatted,
          merchant: merchantName,
          nonce,
        };
      }

      const captureData = (await captureRes.json()) as any;
      const captureId =
        captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
        orderData.id;

      return {
        success: true,
        configured: true,
        orderId: orderData.id,
        captureId,
        status: captureData.status || 'COMPLETED',
        amount: amountFormatted,
        currency: 'USD',
        merchant: merchantName,
        nonce,
        rawResponse: captureData,
      };
    } catch (err: any) {
      return {
        success: false,
        configured: true,
        error: `PayPal execution exception: ${err.message}`,
        amount: (amountCents / 100).toFixed(2),
        merchant: merchantName,
        nonce,
      };
    }
  }
}

export const paypalService = new PayPalService();
