import { NextRequest, NextResponse } from 'next/server';
import { GatewayError, Receipt, ReceiptStore, leashHome, sharedGateway } from '@leash/core';

/**
 * Proving needs the policy secrets, so it only runs on the owner's device: `next dev` on the owner's
 * machine, or LEASH_OWNER_DEVICE=1. A production deployment (`next start`) is a verify-only gateway
 * unless that flag is set; LEASH_OWNER_DEVICE=0 turns proving off in dev too.
 */
export function ownerDeviceEnabled(): boolean {
  if (process.env.LEASH_OWNER_DEVICE === '1') return true;
  if (process.env.LEASH_OWNER_DEVICE === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Hostname of the Host header without the port; '' when absent. */
function hostName(req: NextRequest): string {
  const host = (req.headers.get('host') ?? '').trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0];
}

/** True when the request was addressed to this machine's loopback name (Host header). */
export function isLoopbackRequest(req: NextRequest): boolean {
  return LOOPBACK.has(hostName(req));
}

const refuseOwner = (status: number, error: string) => NextResponse.json({ success: false, kind: 'owner-device', error }, { status });

/**
 * Gate for the routes that use the policy secrets (prove, create policy, matrix, PayPal vault). They run
 * only on the owner device, and only for requests from that device's own browser or tools:
 *  - Host must be localhost / 127.0.0.1 / [::1] (the server also binds 127.0.0.1); this defeats DNS
 *    rebinding and LAN access,
 *  - Sec-Fetch-Site, when a browser sends it, must be same-origin or none (no cross-site page can call it),
 *  - a request with a body must be Content-Type application/json (a cross-site form or text/plain POST
 *    can't be one without a CORS preflight, which these routes never answer).
 */
export function ownerDeviceOnly(req: NextRequest): NextResponse | null {
  if (!ownerDeviceEnabled()) {
    return NextResponse.json(
      { success: false, kind: 'setup', error: 'This gateway is verify-only: proving runs on the owner device (leash-mcp, or the console with LEASH_OWNER_DEVICE=1).' },
      { status: 403 }
    );
  }
  if (!isLoopbackRequest(req)) {
    return refuseOwner(403, `Owner-device route: only requests to localhost / 127.0.0.1 are served (Host was '${hostName(req) || 'missing'}').`);
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return refuseOwner(403, `Owner-device route: refusing a ${site} request (only this console's own pages may call it).`);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      return refuseOwner(415, `Owner-device route: Content-Type must be application/json (got '${type || 'none'}').`);
    }
  }
  return null;
}

/** JSON body cap for every POST route: a proof body is ~33 KB as hex; nothing here is near 128 KB. */
export const JSON_BODY_LIMIT = 128 * 1024;

/** A parsed JSON object body; each route checks the fields it uses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonBody = Record<string, any>;
type BodyResult = { body: JsonBody; response?: undefined } | { body?: undefined; response: NextResponse };

/**
 * Guarded JSON body for the POST routes (App Router handlers have no body limit of their own):
 *  - a browser request marked Sec-Fetch-Site: cross-site is refused (403): no other site's page can
 *    make the console verify proofs or release payments;
 *  - Content-Type must be application/json (415), which a cross-site page can only send after a CORS
 *    preflight these routes never answer, so `no-cors` text/plain POSTs stop here;
 *  - more than 128 KB is refused (413): by Content-Length when sent, and by counting the stream when
 *    it is not (chunked), so the body is never buffered past the cap;
 *  - the body must be a JSON object (400).
 */
export async function readJsonBody(req: NextRequest, limit: number = JSON_BODY_LIMIT): Promise<BodyResult> {
  // A refusal before the whole body is read leaves the rest of it on the socket. Close the connection
  // with the answer, so a keep-alive client (Node's default agent, a browser) doesn't send its next
  // request into that unread body and wait forever for a response that never comes.
  const refuse = (status: number, error: string): BodyResult => ({
    response: NextResponse.json({ success: false, error }, { status, headers: { connection: 'close' } }),
  });
  if (req.headers.get('sec-fetch-site') === 'cross-site') return refuse(403, 'Refusing a cross-site request: only this console’s own pages and non-browser clients may call it.');
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return refuse(415, `Content-Type must be application/json (got '${type || 'none'}').`);
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) return refuse(413, `Request body too large (${declared} bytes; the limit is ${limit}).`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return refuse(413, `Request body too large (over ${limit} bytes).`);
      }
      chunks.push(value);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    return refuse(400, 'Request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse(400, 'Request body must be a JSON object.');
  return { body: parsed as JsonBody };
}

/** Address that owns the console's policies (defaults to Anvil dev account #0). */
export function consoleOwner(): string {
  return process.env.LEASH_CONSOLE_OWNER ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
}

/**
 * Base URL for the PayPal return / cancel links. LEASH_PUBLIC_URL when set; otherwise the request's
 * own origin, but only on loopback: anywhere else the Host header is caller-controlled, so building
 * the buyer's return link from it would let a caller send the buyer to their own site.
 */
export function publicBaseUrl(req: NextRequest): string {
  const configured = process.env.LEASH_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (isLoopbackRequest(req)) return req.nextUrl.origin;
  throw new GatewayError(503, 'Setup required (LEASH_PUBLIC_URL): set the public https URL of this console; return links are not built from the Host header off localhost.', {
    setupRequired: ['LEASH_PUBLIC_URL'],
  });
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof GatewayError || (err as { name?: string } | null)?.name === 'GatewayError') {
    const e = err as GatewayError;
    return NextResponse.json({ success: false, error: e.message, ...e.extra }, { status: e.status });
  }
  // The caller's bad policy request (cap, merchants, payee): 400 with the reason, not a server error.
  if ((err as { name?: string } | null)?.name === 'PolicyInputError') {
    return NextResponse.json({ success: false, kind: 'input', error: (err as Error).message }, { status: 400 });
  }
  return NextResponse.json({ success: false, error: String((err as Error)?.message ?? err) }, { status: 500 });
}

/**
 * Receipts the console shows: the gateway's (PayPal rail) plus, on the owner device, the on-chain
 * releases leash-mcp recorded on this machine (<LEASH_HOME>/receipts.jsonl, rail "evm"). Both stores
 * hold public data only (policy id, amount, salted merchant hash, nonce, proof hash, ids / tx hash).
 * Newest first.
 */
export function consoleReceipts(): Receipt[] {
  const all = [...sharedGateway().receipts.list()];
  if (ownerDeviceEnabled()) all.push(...new ReceiptStore(leashHome()).list());
  return all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
