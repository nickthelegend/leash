/**
 * The console's public POST routes (/api/verify, /api/pay, /api/pay/capture) take a capped JSON body:
 * more than 128 KB is refused (by Content-Length, and by counting a chunked stream), the Content-Type
 * must be application/json (so a cross-site `no-cors` text/plain POST stops before bb), a browser
 * request marked cross-site is refused, and a proof must be hex of the exact size before bb runs.
 * Runs against the e2e console (e2e/stack.sh start); the cross-site cases are sent by real Chrome.
 */
import { test, expect, BASE } from './fixtures';
import http from 'node:http';

const GATEWAY_PORT = process.env.LEASH_E2E_GATEWAY_PORT ?? '3108';
const ROUTES = ['/api/verify', '/api/pay', '/api/pay/capture'];

/** Raw HTTP POST with full header control; `chunked` sends no Content-Length. */
function post(pathName: string, headers: Record<string, string>, body: string, chunked = false): Promise<{ status: number; json: any }> {
  const u = new URL(pathName, BASE);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { ...headers, ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(Buffer.byteLength(body)) }) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = { text };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    // The server may answer 413 and close before the whole body is written.
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? undefined : reject(e)));
    if (chunked) {
      for (let i = 0; i < body.length; i += 16_384) req.write(body.slice(i, i + 16_384));
    } else req.write(body);
    req.end();
  });
}

const JSON_TYPE = { 'content-type': 'application/json' };
const big = JSON.stringify({ proofHex: 'ab'.repeat(100_000), publicInputsHex: '00'.repeat(256) }); // ~200 KB

test.describe('public POST routes: body cap, JSON only, no cross-site, exact proof shape', () => {
  for (const route of ROUTES) {
    test(`${route}: 413 over 128 KB (Content-Length), 413 chunked, 415 text/plain, 403 cross-site`, async () => {
      const declared = await post(route, JSON_TYPE, big);
      expect(declared.status).toBe(413);
      expect(declared.json.error).toBe(`Request body too large (${Buffer.byteLength(big)} bytes; the limit is 131072).`);
      const streamed = await post(route, JSON_TYPE, big, true);
      expect(streamed.status).toBe(413);
      expect(streamed.json.error).toBe('Request body too large (over 131072 bytes).');
      const text = await post(route, { 'content-type': 'text/plain' }, '{}');
      expect(text.status).toBe(415);
      expect(text.json.error).toBe("Content-Type must be application/json (got 'text/plain').");
      const cross = await post(route, { ...JSON_TYPE, 'sec-fetch-site': 'cross-site' }, '{}');
      expect(cross.status).toBe(403);
      expect(cross.json.error).toMatch(/^Refusing a cross-site request/);
    });
  }

  test('/api/verify: 400 for a non-string or wrong-size proof (bb never runs)', async () => {
    const cases: [unknown, string][] = [
      [{ proofHex: 1, publicInputsHex: '00' }, 'proofHex must be a hex string'],
      [{ proofHex: '00', publicInputsHex: '00'.repeat(256) }, 'proofHex must be 16256 bytes (got 1)'],
      [{ proofHex: '00'.repeat(16256), publicInputsHex: '00'.repeat(256), useEvmTarget: true }, 'proofHex must be 8640 bytes (got 16256)'],
    ];
    for (const [body, error] of cases) {
      const r = await post('/api/verify', JSON_TYPE, JSON.stringify(body));
      expect(r.status, error).toBe(400);
      expect(r.json).toEqual({ success: false, valid: false, error });
    }
    // The control case: the right sizes pass the shape check and bb itself rejects the zero proof.
    const evmSized = await post('/api/verify', JSON_TYPE, JSON.stringify({ proofHex: '00'.repeat(8640), publicInputsHex: '00'.repeat(256), useEvmTarget: true }));
    expect(evmSized.status).toBe(200);
    expect(evmSized.json.valid).toBe(false);
    expect(evmSized.json.error).toMatch(/^Barretenberg verification failed/);
  });

  test('/api/pay: 400 for a proof that is not hex of the exact size', async () => {
    const r = await post('/api/pay', JSON_TYPE, JSON.stringify({ owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', proofHex: '00', publicInputsHex: '00'.repeat(256), paypalMerchantId: 'ABCDEFGHJKLMN' }));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('proofHex must be 16256 bytes (got 1)');
  });

  test('real Chrome: a no-cors POST from another site gets 403, from another port of this host 415; neither reaches bb', async ({ page, guard }) => {
    guard.allow('/api/verify', 403);
    guard.allow('/api/verify', 415);
    const body = JSON.stringify({ proofHex: '00'.repeat(16256), publicInputsHex: '00'.repeat(256) });
    const target = `${BASE}/api/verify`;
    for (const [origin, status] of [[`http://localhost:${GATEWAY_PORT}`, 403], [`http://127.0.0.1:${GATEWAY_PORT}`, 415]] as const) {
      await page.goto(`${origin}/api/health`);
      const answered = page.waitForResponse((r) => r.url() === target && r.request().method() === 'POST');
      await page.evaluate(([url, b]) => fetch(url, { method: 'POST', mode: 'no-cors', body: b }).then(() => undefined), [target, body] as const);
      expect((await answered).status(), origin).toBe(status);
    }
  });
});
