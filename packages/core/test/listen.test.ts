import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, describe, expect, it } from 'vitest';

// The servers hold receipts and registrations for the owner device: they bind loopback unless told otherwise.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-listen-'));
process.env.LEASH_HOME = home;
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const listening = (server: { address(): AddressInfo | string | null; once(e: 'listening', f: () => void): unknown; listening: boolean }) =>
  new Promise<AddressInfo>((resolve) => {
    const done = () => resolve(server.address() as AddressInfo);
    if (server.listening) done();
    else server.once('listening', done);
  });

describe('servers bind 127.0.0.1 by default', () => {
  it('the verify-only gateway (startGatewayServer)', async () => {
    const { startGatewayServer } = await import('../src/gateway/server.js');
    const server = startGatewayServer(0);
    try {
      expect((await listening(server)).address).toBe('127.0.0.1');
    } finally {
      server.close();
    }
  });

  it('the verifier service (startVerifierServer), including port 0', async () => {
    const { startVerifierServer } = await import('../src/verifier/service.js');
    const server = startVerifierServer(0);
    try {
      const a = await listening(server);
      expect(a.address).toBe('127.0.0.1');
      expect(a.port).not.toBe(3002);
    } finally {
      server.close();
    }
  });
});
