import dotenv from 'dotenv';
import express, { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import { paypalService } from '../paypal/paypal.js';
import { applyCors, createVerifierRouter, JSON_LIMIT } from '../verifier/service.js';
import { policyIdOf } from '../crypto/evm.js';
import { GatewayError, PayGateway, registrationMessage, sharedGateway } from './payGateway.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

/**
 * Verify-only gateway (Express). It holds no policy secrets and never proves: proving happens on
 * the agent / owner device (leash-mcp, the local console). Routes:
 *   GET  /health, /api/verify/health   verifier diagnostics
 *   POST /verify, /api/verify          bb verify against the server's own key
 *   GET  /api/policies                 public registrations (owner, commitment, threshold)
 *   GET  /api/policies/message         ?owner&policyCommitment&approvalThresholdCents[&vaultId]: the text
 *                                      the owner signs (EIP-191) and the next version
 *   POST /api/policies                 register / change { owner, policyCommitment, approvalThresholdCents,
 *                                      vaultId?, version, signature } (owner-signed; 401 without)
 *   GET  /api/spend/:policyId          latest spend commitment (the total stays hidden)
 *   GET  /api/receipts[/:nonce]        receipts (?policyId= to pick one policy)
 * Payments are released by the Next.js app's /api/pay, which uses the same PayGateway.
 * No CORS headers unless LEASH_GATEWAY_CORS_ORIGINS lists origins; JSON bodies are capped at 128 KB.
 */
export function createGatewayApp(gateway: PayGateway = sharedGateway()): Express {
  const app = express();
  app.disable('x-powered-by');
  applyCors(app); // none unless LEASH_GATEWAY_CORS_ORIGINS lists origins
  app.use(express.json({ limit: JSON_LIMIT }));
  app.use(createVerifierRouter());

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'LEASH verify-only gateway',
      paypal: paypalService.setupStatus(),
      registeredPolicies: gateway.policies().length,
      receipts: gateway.receipts.list().length,
      timestamp: new Date().toISOString(),
    });
  });

  // Public data only: no merchants, caps or salts ever reach the gateway.
  app.get('/api/policies', (_req: Request, res: Response) => {
    res.json({ policies: gateway.policies() });
  });

  // What the owner must sign for a registration or threshold change (no secret involved).
  app.get('/api/policies/message', (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const policyId = policyIdOf(String(q.owner ?? ''), String(q.policyCommitment ?? ''));
      const prev = gateway.policy(policyId);
      const approvalThresholdCents = Number(q.approvalThresholdCents ?? 0);
      const version = (prev?.version ?? 0) + 1;
      const vaultId = q.vaultId ?? prev?.vaultId;
      res.json({ policyId, version, message: registrationMessage({ policyId, approvalThresholdCents, vaultId, version }) });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  });

  // Owner-signed only: the threshold decides whether a vaulted wallet is charged without the buyer.
  app.post('/api/policies', (req: Request, res: Response) => {
    try {
      const { owner, policyCommitment, approvalThresholdCents, vaultId, version, signature } = req.body ?? {};
      res.json({ success: true, policy: gateway.register({ owner, policyCommitment, approvalThresholdCents, vaultId, version, signature }) });
    } catch (err) {
      const e = err as GatewayError;
      res.status(err instanceof GatewayError ? e.status : 400).json({ success: false, error: e.message, ...(err instanceof GatewayError ? e.extra : {}) });
    }
  });

  app.get('/api/spend/:policyId', (req: Request, res: Response) => {
    res.json({ policyId: String(req.params.policyId).toLowerCase(), spend: gateway.spendState(String(req.params.policyId)) ?? null });
  });

  app.get('/api/receipts', (req: Request, res: Response) => {
    const policyId = typeof req.query.policyId === 'string' ? req.query.policyId.toLowerCase() : undefined;
    const all = gateway.receipts.list();
    res.json({ receipts: policyId ? all.filter((r) => r.policyId === policyId) : all });
  });

  app.get('/api/receipts/:nonce', (req: Request, res: Response) => {
    const policyId = typeof req.query.policyId === 'string' ? req.query.policyId.toLowerCase() : undefined;
    const hits = gateway.receipts.byNonce(String(req.params.nonce)).filter((r) => !policyId || r.policyId === policyId);
    if (hits.length === 0) {
      res.status(404).json({ error: 'No receipt for that nonce' });
      return;
    }
    res.json(hits.length === 1 ? { receipt: hits[0] } : { receipts: hits });
  });

  // Every answer is JSON, including the ones Express would render as an HTML page.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ success: false, error: `No route for ${req.method} ${req.path}` });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ success: false, error: 'Body is not valid JSON' });
    if (err?.type === 'entity.too.large') return void res.status(413).json({ success: false, error: `Body too large (limit ${JSON_LIMIT})` });
    if (err?.status && err.status >= 400 && err.status < 500) return void res.status(err.status).json({ success: false, error: 'Bad request' });
    console.error('[LEASH Gateway] unhandled error:', err);
    res.status(500).json({ success: false, error: 'Gateway internal error' });
  });

  return app;
}

/**
 * Loopback by default: the gateway serves receipts and registrations for the owner device. Expose it
 * on purpose with LEASH_GATEWAY_HOST (e.g. 0.0.0.0 behind a TLS proxy).
 */
export function startGatewayServer(
  port: number = Number(process.env.GATEWAY_PORT || process.env.PORT || 3001),
  host: string = process.env.LEASH_GATEWAY_HOST ?? '127.0.0.1'
) {
  return createGatewayApp().listen(port, host, () => {
    console.log(`[LEASH Gateway] verify-only, http://${host.includes(':') ? `[${host}]` : host}:${port}`);
    console.log(`[LEASH Gateway] PayPal: ${paypalService.setupStatus().message}`);
  });
}

if (require.main === module || process.argv[1]?.endsWith('server.ts')) {
  startGatewayServer();
}
