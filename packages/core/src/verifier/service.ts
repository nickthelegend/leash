import cors from 'cors';
import express, { Express, Request, Response, Router } from 'express';
import {
  assertVerifierDependencies,
  checkVerifierHealth,
  proofInputProblem,
  VerifierDependencyError,
  VerifierKeyError,
  verifyPaymentProof,
} from './verifier.js';

export function createVerifierRouter(): Router {
  const router = Router();

  /**
   * Health and dependency diagnostics check
   * Returns 200 if all ZK dependencies (bb, vk, circuits) are present and operational.
   * Returns 503 if any dependency or key is missing, failing loudly.
   */
  router.get(['/health', '/api/verify/health'], (_req: Request, res: Response) => {
    const health = checkVerifierHealth();
    if (health.status !== 'ok') {
      res.status(503).json(health);
      return;
    }
    res.json(health);
  });

  /**
   * Core Noir UltraHonk proof verification endpoint.
   * Verifies proofs from circuits/ for real via Barretenberg (bb verify).
   * No mocks. Fails loudly with 500/503 when a dependency or key is missing.
   */
  router.post(['/verify', '/api/verify'], (req: Request, res: Response) => {
    try {
      const {
        proofHex,
        publicInputsHex,
        expectedCommitment,
        expectedAmount,
        expectedMerchantHash,
        expectedNonce,
        expectedRecipient,
        useEvmTarget,
      } = req.body || {};
      // The verification key is fixed by the server (circuits/target); a request can't pick its own
      // key path (that used to be possible with customVkPath).

      if (!proofHex || !publicInputsHex) {
        res.status(400).json({
          success: false,
          valid: false,
          error:
            'Missing required parameters: proofHex and publicInputsHex are required.',
        });
        return;
      }
      const problem = proofInputProblem(proofHex, publicInputsHex, Boolean(useEvmTarget));
      if (problem) {
        res.status(400).json({ success: false, valid: false, error: problem });
        return;
      }

      const result = verifyPaymentProof({
        proofHex,
        publicInputsHex,
        expectedCommitment,
        expectedAmount,
        expectedMerchantHash,
        expectedNonce,
        expectedRecipient,
        useEvmTarget: Boolean(useEvmTarget),
      });

      res.json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      if (
        err instanceof VerifierDependencyError ||
        err instanceof VerifierKeyError ||
        err.name === 'VerifierDependencyError' ||
        err.name === 'VerifierKeyError'
      ) {
        // Loud system failure: dependency or key missing
        console.error(
          `[LEASH VERIFIER HTTP 503] Fatal setup error: ${err.message}`
        );
        res.status(503).json({
          success: false,
          valid: false,
          fatal: true,
          errorType: err.code || 'FATAL_VERIFIER_ERROR',
          error: err.message,
        });
        return;
      }

      console.error(`[LEASH VERIFIER HTTP 500] Unexpected error:`, err);
      res.status(500).json({
        success: false,
        valid: false,
        fatal: false,
        error: `Verifier internal error: ${err.message}`,
      });
    }
  });

  return router;
}

/**
 * CORS for the gateway and verifier apps: none by default (the console calls its own same-origin
 * routes); browsers on the origins in LEASH_GATEWAY_CORS_ORIGINS (comma list) may read them.
 */
export function applyCors(app: Express): void {
  const origins = (process.env.LEASH_GATEWAY_CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length) app.use(cors({ origin: origins }));
}

/** JSON body cap: an UltraHonk proof is ~16 KB (~32 KB as hex); nothing these apps accept is near 128 KB. */
export const JSON_LIMIT = '128kb';

export function createVerifierApp(): Express {
  const app = express();
  applyCors(app);
  app.use(express.json({ limit: JSON_LIMIT }));

  const verifierRouter = createVerifierRouter();
  app.use(verifierRouter);

  return app;
}

/** Loopback by default; LEASH_VERIFIER_HOST exposes it on purpose. Port 0 picks a free port. */
export function startVerifierServer(port?: number, host: string = process.env.LEASH_VERIFIER_HOST ?? '127.0.0.1') {
  const listenPort =
    port ??
    (Number(process.env.VERIFIER_PORT) ||
    Number(process.env.LEASH_VERIFIER_PORT) ||
    3002);

  // Verify dependencies on boot and print status
  try {
    assertVerifierDependencies();
    console.log('[LEASH Verifier Service] Barretenberg and verification keys verified.');
  } catch (err: any) {
    console.error(
      `[LEASH Verifier Service WARNING] Startup dependency check failed: ${err.message}`
    );
  }

  const app = createVerifierApp();
  return app.listen(listenPort, host, () => {
    console.log(
      `[LEASH Verifier Service] Running at http://${host.includes(':') ? `[${host}]` : host}:${listenPort}`
    );
    console.log(
      `[LEASH Verifier Service] POST /verify - Real Noir UltraHonk proof verification`
    );
  });
}

// Start if executed directly
if (
  process.argv[1]?.endsWith('service.ts') ||
  process.argv[1]?.endsWith('service.js')
) {
  startVerifierServer();
}
