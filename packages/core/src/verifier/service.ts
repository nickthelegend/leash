import cors from 'cors';
import express, { Express, Request, Response, Router } from 'express';
import {
  assertVerifierDependencies,
  checkVerifierHealth,
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
        useEvmTarget,
        customVkPath,
      } = req.body || {};

      if (!proofHex || !publicInputsHex) {
        res.status(400).json({
          success: false,
          valid: false,
          error:
            'Missing required parameters: proofHex and publicInputsHex are required.',
        });
        return;
      }

      const result = verifyPaymentProof({
        proofHex,
        publicInputsHex,
        expectedCommitment,
        expectedAmount,
        expectedMerchantHash,
        expectedNonce,
        useEvmTarget: Boolean(useEvmTarget),
        customVkPath,
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

export function createVerifierApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  const verifierRouter = createVerifierRouter();
  app.use(verifierRouter);

  return app;
}

export function startVerifierServer(port?: number) {
  const listenPort =
    port ||
    Number(process.env.VERIFIER_PORT) ||
    Number(process.env.LEASH_VERIFIER_PORT) ||
    3002;

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
  return app.listen(listenPort, () => {
    console.log(
      `[LEASH Verifier Service] Running at http://localhost:${listenPort}`
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
