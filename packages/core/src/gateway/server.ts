import cors from 'cors';
import dotenv from 'dotenv';
import express, { Express, Request, Response } from 'express';
import path from 'path';
import { paypalService } from '../paypal/paypal.js';
import { createVerifierRouter } from '../verifier/service.js';
import { GatewayError, PayGateway, sharedGateway } from './payGateway.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

/**
 * Verify-only gateway (Express). It holds no policy secrets and never proves: proving happens on
 * the agent / owner device (leash-mcp, the local console). Routes:
 *   GET  /health, /api/verify/health   verifier diagnostics
 *   POST /verify, /api/verify          bb verify against the server's own key
 *   GET  /api/policies                 public registrations (owner, commitment, threshold)
 *   POST /api/policies                 register { owner, policyCommitment, approvalThresholdCents }
 *   GET  /api/spend/:policyId          latest spend commitment (the total stays hidden)
 *   GET  /api/receipts[/:nonce]        receipts (?policyId= to pick one policy)
 * Payments are released by the Next.js app's /api/pay, which uses the same PayGateway.
 */
export function createGatewayApp(gateway: PayGateway = sharedGateway()): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
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

  app.post('/api/policies', (req: Request, res: Response) => {
    try {
      const { owner, policyCommitment, approvalThresholdCents, vaultId } = req.body ?? {};
      res.json({ success: true, policy: gateway.register({ owner, policyCommitment, approvalThresholdCents, vaultId }) });
    } catch (err: any) {
      res.status(err instanceof GatewayError ? err.status : 400).json({ success: false, error: err.message });
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

  return app;
}

export function startGatewayServer(port: number = Number(process.env.GATEWAY_PORT || process.env.PORT || 3001)) {
  return createGatewayApp().listen(port, () => {
    console.log(`[LEASH Gateway] verify-only, http://localhost:${port}`);
    console.log(`[LEASH Gateway] PayPal: ${paypalService.setupStatus().message}`);
  });
}

if (require.main === module || process.argv[1]?.endsWith('server.ts')) {
  startGatewayServer();
}
