import cors from 'cors';
import dotenv from 'dotenv';
import express, { Express, Request, Response } from 'express';
import path from 'path';
import { runInjectionHarness } from '../harness/injectionSuite.js';
import { paypalService } from '../paypal/paypal.js';
import {
  createSpendingPolicy,
  getDefaultPolicy,
  SpendingPolicy,
} from '../policy/policy.js';
import { generatePaymentProof } from '../prover/prover.js';
import { verifyPaymentProof } from '../verifier/verifier.js';
import { createVerifierRouter } from '../verifier/service.js';
import { nonceStore } from './nonceStore.js';

// Load .env.local if present, else .env
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const app: Express = express();
const PORT = process.env.GATEWAY_PORT || process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Mount the real Noir verifier service router (POST /verify, POST /api/verify, GET /health)
app.use(createVerifierRouter());

// In-memory store of registered policy commitments & policies
const activePolicies: Map<string, SpendingPolicy> = new Map();
const registeredCommitments: Set<string> = new Set();

export function ensureDefaultPolicyRegistered(): SpendingPolicy {
  const defaultPolicy = getDefaultPolicy();
  if (!activePolicies.has(defaultPolicy.policyCommitment)) {
    activePolicies.set(defaultPolicy.policyCommitment, defaultPolicy);
    registeredCommitments.add(defaultPolicy.policyCommitment);
  }
  return defaultPolicy;
}

/**
 * Health & status check
 */
app.get(['/health', '/api/health'], (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'LEASH ZK Gateway',
    version: '1.0.0',
    paypal: {
      configured: paypalService.isConfigured(),
      environment: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
    },
    registeredPoliciesCount: registeredCommitments.size,
    usedNoncesCount: nonceStore.getAuditLog().length,
    timestamp: new Date().toISOString(),
  });
});

/**
 * List registered policy commitments
 * Notice: Returns strictly public commitments.
 */
app.get('/api/policies', (_req: Request, res: Response) => {
  const policies = Array.from(activePolicies.values()).map((p) => ({
    id: p.id,
    name: p.name,
    policyCommitment: p.policyCommitment,
    merkleRoot: p.merkleRoot,
    maxPerTxCents: p.maxPerTxCents,
    merchantsCount: p.merchants.length,
    createdAt: p.createdAt,
    // Included only for local console convenience:
    merchants: p.merchants,
  }));

  res.json({
    commitments: Array.from(registeredCommitments),
    policies,
  });
});

/**
 * Create a new policy
 */
app.post('/api/policies', (req: Request, res: Response) => {
  try {
    const { name, maxPerTxCents, merchants, salt } = req.body;
    if (!name || !maxPerTxCents || !merchants) {
      return res.status(400).json({
        error: 'Missing required fields: name, maxPerTxCents, merchants',
      });
    }

    const policy = createSpendingPolicy(
      name,
      Number(maxPerTxCents),
      merchants,
      salt
    );
    activePolicies.set(policy.policyCommitment, policy);
    registeredCommitments.add(policy.policyCommitment);

    res.json({
      success: true,
      policy: {
        id: policy.id,
        name: policy.name,
        policyCommitment: policy.policyCommitment,
        merkleRoot: policy.merkleRoot,
        maxPerTxCents: policy.maxPerTxCents,
        merchants: policy.merchants,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Agent Prover Endpoint:
 * Generates an UltraHonk proof for a requested payment against a policy.
 */
app.post('/api/prove', (req: Request, res: Response) => {
  try {
    const { policyCommitment, merchantName, amountCents, nonce, useEvmTarget } =
      req.body;

    const policy =
      activePolicies.get(policyCommitment) ||
      (policyCommitment ? undefined : ensureDefaultPolicyRegistered());

    if (!policy) {
      return res.status(404).json({
        error: `Policy commitment ${policyCommitment} not found on this node.`,
      });
    }

    const proofResult = generatePaymentProof({
      policy,
      merchantName,
      amountCents: Number(amountCents),
      nonce: nonce || Date.now().toString(),
      useEvmTarget: Boolean(useEvmTarget),
    });

    res.json({
      success: true,
      ...proofResult,
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * Leash Gateway Payment Release Endpoint:
 * Verifies the ZK proof against the committed policy before triggering payment.
 */
app.post('/api/pay', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const {
      policyCommitment,
      amountCents,
      merchantIdHash,
      nonce,
      proofHex,
      publicInputsHex,
      merchantName,
    } = req.body;

    if (
      !policyCommitment ||
      amountCents === undefined ||
      !merchantIdHash ||
      !nonce ||
      !proofHex ||
      !publicInputsHex
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Missing required parameters: policyCommitment, amountCents, merchantIdHash, nonce, proofHex, publicInputsHex',
      });
    }

    const nonceStr = nonce.toString();
    const amountNum = Number(amountCents);

    // 1. Verify policy is registered
    if (!registeredCommitments.has(policyCommitment.toLowerCase())) {
      nonceStore.addAuditEntry({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        policyCommitment,
        amountCents: amountNum,
        merchantIdHash,
        nonce: nonceStr,
        proofVerified: false,
        status: 'REJECTED',
        rejectionReason: 'Policy commitment not registered on Gateway',
        durationMs: Date.now() - startTime,
      });

      return res.status(400).json({
        success: false,
        error: 'Policy commitment not registered on Gateway',
      });
    }

    // 2. Replay Protection: Check if nonce was already used
    if (nonceStore.isNonceUsed(nonceStr)) {
      nonceStore.addAuditEntry({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        policyCommitment,
        amountCents: amountNum,
        merchantIdHash,
        nonce: nonceStr,
        proofVerified: false,
        status: 'REJECTED',
        rejectionReason: 'Nonce replay detected: nonce already used',
        durationMs: Date.now() - startTime,
      });

      return res.status(400).json({
        success: false,
        error: 'Nonce replay detected. Nonce has already been consumed.',
        nonce: nonceStr,
      });
    }

    // 3. Cryptographic Proof Verification
    const verifyResult = verifyPaymentProof({
      proofHex,
      publicInputsHex,
      expectedCommitment: policyCommitment,
      expectedAmount: amountNum,
      expectedMerchantHash: merchantIdHash,
      expectedNonce: nonceStr,
    });

    if (!verifyResult.valid) {
      nonceStore.addAuditEntry({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        policyCommitment,
        amountCents: amountNum,
        merchantIdHash,
        nonce: nonceStr,
        proofVerified: false,
        status: 'REJECTED',
        rejectionReason: verifyResult.error || 'Invalid ZK proof',
        durationMs: Date.now() - startTime,
      });

      return res.status(400).json({
        success: false,
        error: `Invalid ZK proof: ${verifyResult.error}`,
        nonce: nonceStr,
      });
    }

    // 4. Mark nonce as consumed
    nonceStore.recordNonce(nonceStr);

    // 5. Release payment through PayPal Orders API
    const effectiveMerchant = merchantName || 'Authorized Merchant';
    const paypalResult = await paypalService.executeOrder(
      amountNum,
      effectiveMerchant,
      nonceStr
    );

    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      policyCommitment,
      amountCents: amountNum,
      merchantIdHash,
      nonce: nonceStr,
      proofVerified: true,
      status: 'COMPLETED' as const,
      paypalOrderId: paypalResult.orderId,
      paypalStatus: paypalResult.status,
      durationMs: Date.now() - startTime,
    };
    nonceStore.addAuditEntry(logEntry);

    res.json({
      success: true,
      verified: true,
      nonce: nonceStr,
      policyCommitment,
      amountCents: amountNum,
      merchantIdHash,
      paypal: paypalResult,
      durationMs: Date.now() - startTime,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: `Gateway internal error: ${err.message}`,
    });
  }
});

/**
 * Public Audit Log: Shows all transaction logs without revealing secret rules
 */
app.get('/api/logs', (_req: Request, res: Response) => {
  res.json({
    logs: nonceStore.getAuditLog(),
  });
});

/**
 * Prompt Injection Harness Benchmark Runner
 */
app.get('/api/harness/run', async (_req: Request, res: Response) => {
  try {
    const summary = await runInjectionHarness(ensureDefaultPolicyRegistered());
    res.json({
      success: true,
      summary,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

export function startGatewayServer(port: number = Number(PORT)) {
  ensureDefaultPolicyRegistered();
  return app.listen(port, () => {
    console.log(`[LEASH Gateway] Running at http://localhost:${port}`);
    console.log(
      `[LEASH Gateway] PayPal Integration: ${
        paypalService.isConfigured() ? 'CONFIGURED (Real API)' : 'Awaiting credentials'
      }`
    );
  });
}

// Start immediately if executed as main module
if (require.main === module || process.argv[1]?.endsWith('server.ts')) {
  startGatewayServer();
}

export { app };
