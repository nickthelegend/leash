import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { afterAll, describe, expect, it } from 'vitest';
import { addressOfPublicKey, eip191Hash, recoverEip191Signer } from '../src/crypto/eip191.js';
import { policyIdOf } from '../src/crypto/evm.js';
import { GatewayError, PayGateway, registrationMessage } from '../src/gateway/payGateway.js';
import { createGatewayApp } from '../src/gateway/server.js';
import { PayPalService } from '../src/paypal/paypal.js';

// Owner-signed gateway registration (EIP-191). Keys are generated per run; no key is stored.
const ownerKey = secp256k1.utils.randomPrivateKey();
const attackerKey = secp256k1.utils.randomPrivateKey();
const OWNER = addressOfPublicKey(secp256k1.getPublicKey(ownerKey, false));
const COMMITMENT = `0x${'ab'.repeat(32)}`;
const POLICY_ID = policyIdOf(OWNER, COMMITMENT);

function sign(message: string, key: Uint8Array): string {
  const sig = secp256k1.sign(eip191Hash(message), key);
  return `0x${sig.toCompactHex()}${(27 + sig.recovery).toString(16)}`;
}
const signed = (threshold: number, version: number, key = ownerKey, vaultId?: string) => ({
  owner: OWNER,
  policyCommitment: COMMITMENT,
  approvalThresholdCents: threshold,
  ...(vaultId ? { vaultId } : {}),
  version,
  signature: sign(registrationMessage({ policyId: POLICY_ID, approvalThresholdCents: threshold, vaultId, version }), key),
});

const dirs: string[] = [];
const freshGateway = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-reg-'));
  dirs.push(dir);
  return new PayGateway({ dir, paypal: new PayPalService({ clientId: '', clientSecret: '' }) });
};
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function refusal(f: () => unknown): GatewayError {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayError);
    return e as GatewayError;
  }
  throw new Error('expected the gateway to refuse');
}

describe('EIP-191 signatures', () => {
  it('recovers the signer, and cast wallet verify accepts the same signature', () => {
    const msg = registrationMessage({ policyId: POLICY_ID, approvalThresholdCents: 300, version: 1 });
    const sig = sign(msg, ownerKey);
    expect(recoverEip191Signer(msg, sig)).toBe(OWNER);
    // Independent check with Foundry: the format is what wallets and `cast wallet sign` produce.
    execFileSync('cast', ['wallet', 'verify', '--address', OWNER, msg, sig], { stdio: 'pipe' });
  });

  it('a signature over different text recovers a different address; malformed ones throw', () => {
    const sig = sign('LEASH gateway registration', ownerKey);
    expect(recoverEip191Signer('LEASH gateway registration ', sig)).not.toBe(OWNER);
    expect(() => recoverEip191Signer('x', '0x1234')).toThrow(/65 bytes/);
  });
});

describe('Gateway registration needs the owner (closes the unauthenticated-threshold gap)', () => {
  it('an unsigned registration is refused with 401 and the text to sign', () => {
    const gw = freshGateway();
    const e = refusal(() => gw.register({ owner: OWNER, policyCommitment: COMMITMENT, approvalThresholdCents: 300 }));
    expect(e.status).toBe(401);
    expect(e.extra.message).toBe(registrationMessage({ policyId: POLICY_ID, approvalThresholdCents: 300, version: 1 }));
    expect(gw.policy(POLICY_ID)).toBeUndefined();
  });

  it('the owner registers with a signature; version 1 is stored', () => {
    const gw = freshGateway();
    expect(gw.register(signed(300, 1))).toMatchObject({ policyId: POLICY_ID, approvalThresholdCents: 300, version: 1 });
  });

  it('someone else cannot register or raise the threshold of the owner\'s policy', () => {
    const gw = freshGateway();
    expect(refusal(() => gw.register(signed(300, 1, attackerKey))).status).toBe(401);
    gw.register(signed(300, 1));
    // The attack the judge described: lift the threshold so a vaulted wallet is charged without the buyer.
    expect(refusal(() => gw.register(signed(1_000_000, 2, attackerKey))).status).toBe(401);
    expect(gw.policy(POLICY_ID)?.approvalThresholdCents).toBe(300);
  });

  it('a signed body whose threshold was changed in transit does not verify', () => {
    const gw = freshGateway();
    const body = { ...signed(300, 1), approvalThresholdCents: 1_000_000 };
    expect(refusal(() => gw.register(body)).status).toBe(401);
  });

  it('an old signed registration cannot be replayed after the owner lowered the threshold', () => {
    const gw = freshGateway();
    const high = signed(5000, 1);
    gw.register(high);
    gw.register(signed(0, 2)); // owner lowers it
    const e = refusal(() => gw.register(high));
    expect(e.status).toBe(409);
    expect(gw.policy(POLICY_ID)?.approvalThresholdCents).toBe(0);
  });

  it('a vault id is part of what the owner signs', () => {
    const gw = freshGateway();
    gw.register(signed(300, 1, ownerKey, 'jwgvx42'));
    const swapped = { ...signed(300, 2, ownerKey, 'jwgvx42'), vaultId: 'attackerVault' };
    expect(refusal(() => gw.register(swapped)).status).toBe(401);
    expect(gw.policy(POLICY_ID)?.vaultId).toBe('jwgvx42');
  });

  it('the owner device registers in-process without a network signature', () => {
    const gw = freshGateway();
    expect(gw.register({ owner: OWNER, policyCommitment: COMMITMENT, approvalThresholdCents: 300 }, { trustedOwnerDevice: true }).version).toBe(1);
    expect(gw.register({ owner: OWNER, policyCommitment: COMMITMENT, approvalThresholdCents: 100 }, { trustedOwnerDevice: true }).version).toBe(2);
  });
});

describe('Express gateway POST /api/policies', () => {
  it('401 unsigned, message endpoint gives the text, signed registration succeeds', async () => {
    const gw = freshGateway();
    const server = createGatewayApp(gw).listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const base = `http://localhost:${port}`;
      const post = (body: unknown) =>
        fetch(`${base}/api/policies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

      const unsigned = await post({ owner: OWNER, policyCommitment: COMMITMENT, approvalThresholdCents: 300 });
      expect(unsigned.status).toBe(401);

      const m = await (await fetch(`${base}/api/policies/message?owner=${OWNER}&policyCommitment=${COMMITMENT}&approvalThresholdCents=300`)).json();
      expect(m).toMatchObject({ policyId: POLICY_ID, version: 1 });
      const ok = await post({ owner: OWNER, policyCommitment: COMMITMENT, approvalThresholdCents: 300, version: m.version, signature: sign(m.message, ownerKey) });
      expect(ok.status).toBe(200);
      expect((await ok.json()).policy.version).toBe(1);

      const forged = await post(signed(1_000_000, 2, attackerKey));
      expect(forged.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
