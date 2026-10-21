import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDefaultPolicy } from '../src/policy/policy.js';
import { generatePaymentProof } from '../src/prover/prover.js';
import {
  assertVerifierDependencies,
  checkVerifierHealth,
  VerifierKeyError,
  verifyPaymentProof,
} from '../src/verifier/verifier.js';
import { createVerifierApp } from '../src/verifier/service.js';

describe('LEASH Noir Verifier Service', () => {
  // The --demo policy (fixed, public salt): fine for tests, never for real use.
  const policy = getDefaultPolicy({ demo: true });
  const OPENAI_PAYEE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

  // Pre-generate a real Noir UltraHonk proof for test assertions
  const validProof = generatePaymentProof({
    policy,
    merchantName: 'openai',
    amountCents: 300,
    nonce: '42001',
  });

  describe('Dependency & Key Assertions (Fail Loudly)', () => {
    it('successfully locates bb binary and real circuit verification keys', () => {
      const deps = assertVerifierDependencies();
      expect(deps.bbPath).toBeTruthy();
      expect(deps.vkPath).toContain('circuits/target/vk/vk');
      expect(deps.bytecodePath).toContain('circuits/target/leash_circuit.json');
    });

    it('reports healthy verifier diagnostics', () => {
      const health = checkVerifierHealth();
      expect(health.status).toBe('ok');
      expect(health.bb.available).toBe(true);
      expect(health.keys.vkExists).toBe(true);
      expect(health.circuits.bytecodeExists).toBe(true);
    });

    it('FAILS LOUDLY when verification key is missing', () => {
      expect(() => {
        verifyPaymentProof({
          proofHex: validProof.proofHex,
          publicInputsHex: validProof.publicInputsHex,
          vkPath: '/tmp/nonexistent_fake_vk_path_404',
        });
      }).toThrowError(VerifierKeyError);
    });
  });

  describe('Cryptographic Proof Verification (Real Barretenberg)', () => {
    it('verifies a valid Noir UltraHonk proof with matching public inputs', () => {
      const result = verifyPaymentProof({
        proofHex: validProof.proofHex,
        publicInputsHex: validProof.publicInputsHex,
        expectedCommitment: policy.policyCommitment,
        expectedAmount: 300,
        expectedMerchantHash: validProof.publicInputs.merchant_id_hash,
        expectedNonce: '42001',
      });

      expect(result.valid).toBe(true);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.extractedPublicInputs?.amount).toBe('300');
      expect(result.extractedPublicInputs?.nonce).toBe('42001');
      // The payee bound in the proof is the payee listed for openai in the policy leaf.
      expect(result.extractedPublicInputs?.recipient).toBe(OPENAI_PAYEE);
      expect(result.extractedPublicInputs?.prev_spend_commit).toBe(`0x${'0'.repeat(64)}`);
      expect(result.extractedPublicInputs?.new_spend_commit).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('rejects verification if the expected recipient differs from the proven payee', () => {
      const result = verifyPaymentProof({
        proofHex: validProof.proofHex,
        publicInputsHex: validProof.publicInputsHex,
        expectedRecipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Public input mismatch: recipient');
    });

    it('rejects public inputs whose recipient slot was swapped (bb verify fails)', () => {
      const pub = Buffer.from(validProof.publicInputsHex.slice(2), 'hex');
      Buffer.from('3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 'hex').copy(pub, 4 * 32 + 12);
      const result = verifyPaymentProof({ proofHex: validProof.proofHex, publicInputsHex: `0x${pub.toString('hex')}` });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Barretenberg verification failed');
    });

    it('rejects verification if expected amount does not match public inputs', () => {
      const result = verifyPaymentProof({
        proofHex: validProof.proofHex,
        publicInputsHex: validProof.publicInputsHex,
        expectedCommitment: policy.policyCommitment,
        expectedAmount: 99999, // Tampered expected amount
        expectedMerchantHash: validProof.publicInputs.merchant_id_hash,
        expectedNonce: '42001',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Public input mismatch: amount');
    });

    it('rejects a cryptographically tampered proof', () => {
      // Flip characters in the proof hex to corrupt the polynomial commitments
      const rawHex = validProof.proofHex.startsWith('0x')
        ? validProof.proofHex.slice(2)
        : validProof.proofHex;
      const flipped = (rawHex[0] === 'a' ? 'b' : 'a') + rawHex.slice(1);
      const tamperedProofHex = `0x${flipped}`;

      const result = verifyPaymentProof({
        proofHex: tamperedProofHex,
        publicInputsHex: validProof.publicInputsHex,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('HTTP Endpoint Integration (Express)', () => {
    const app = createVerifierApp();

    it('GET /health returns 200 with operational status', async () => {
      // In-memory request using express handler
      const server = app.listen(0);
      const port = (server.address() as any).port;
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe('ok');
        expect(data.bb.available).toBe(true);
      } finally {
        server.close();
      }
    });

    it('POST /verify returns 400 when missing required parameters', async () => {
      const server = app.listen(0);
      const port = (server.address() as any).port;
      try {
        const res = await fetch(`http://localhost:${port}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.success).toBe(false);
      } finally {
        server.close();
      }
    });

    it('POST /verify returns 200 and valid=true for real Noir proof', async () => {
      const server = app.listen(0);
      const port = (server.address() as any).port;
      try {
        const res = await fetch(`http://localhost:${port}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proofHex: validProof.proofHex,
            publicInputsHex: validProof.publicInputsHex,
            expectedCommitment: policy.policyCommitment,
            expectedAmount: 300,
            expectedMerchantHash: validProof.publicInputs.merchant_id_hash,
            expectedNonce: '42001',
          }),
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.valid).toBe(true);
        expect(data.extractedPublicInputs.amount).toBe('300');
      } finally {
        server.close();
      }
    });

    it('POST /verify ignores a client-supplied key path (customVkPath is not an HTTP option)', async () => {
      const server = app.listen(0);
      const port = (server.address() as any).port;
      try {
        const res = await fetch(`http://localhost:${port}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proofHex: validProof.proofHex,
            publicInputsHex: validProof.publicInputsHex,
            customVkPath: '/tmp/attacker_chosen_vk',
            vkPath: '/tmp/attacker_chosen_vk',
          }),
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.valid).toBe(true);
      } finally {
        server.close();
      }
    });

    it('POST /verify FAILS LOUDLY with 503 when the server has no verification key', async () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-novk-'));
      fs.writeFileSync(path.join(empty, 'Nargo.toml'), '[package]\nname = "x"\ntype = "bin"\n');
      const prev = process.env.LEASH_CIRCUITS_DIR;
      process.env.LEASH_CIRCUITS_DIR = empty;
      const server = app.listen(0);
      const port = (server.address() as any).port;
      try {
        const res = await fetch(`http://localhost:${port}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proofHex: validProof.proofHex, publicInputsHex: validProof.publicInputsHex }),
        });
        expect(res.status).toBe(503);
        const data = await res.json();
        expect(data.fatal).toBe(true);
        expect(data.errorType).toBe('VERIFIER_KEY_MISSING');
      } finally {
        server.close();
        if (prev === undefined) delete process.env.LEASH_CIRCUITS_DIR;
        else process.env.LEASH_CIRCUITS_DIR = prev;
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });
});
