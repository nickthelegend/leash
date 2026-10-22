import { spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/demo-anvil.sh starts a real Anvil, then deploys with forge. When a later step fails, the
// Anvil it started must not be left holding the port. The failing step here is a `forge` on PATH that
// exits 1 (the real anvil, cast and nargo run).
const ROOT = path.resolve(__dirname, '../../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-demo-script-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

describe('pnpm demo:anvil cleans up after a failed step', () => {
  it('a failing forge create exits non-zero and leaves no Anvil on the port', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'forge'), '#!/bin/sh\necho "forge: simulated deploy failure" >&2\nexit 1\n', { mode: 0o755 });
    const port = await freePort();
    const demoDir = path.join(tmp, 'demo');
    const r = spawnSync('bash', [path.join(ROOT, 'scripts/demo-anvil.sh')], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANVIL_PORT: String(port), LEASH_DEMO_DIR: demoDir },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/demo:anvil failed; stopped the Anvil it started/);
    expect(await listening(port)).toBe(false);
    const pid = Number(fs.readFileSync(path.join(demoDir, 'anvil.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 180_000);
});
