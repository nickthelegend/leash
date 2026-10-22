import fs from 'fs';
import os from 'os';
import path from 'path';

/** Repo root: the nearest ancestor (of this module, then cwd) holding pnpm-workspace.yaml. */
export function repoRoot(): string | undefined {
  for (const start of [__dirname, process.cwd()]) {
    let dir = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return undefined;
}

/**
 * Binary for nargo / bb: $NARGO / $BB, else the pinned copy in <repo>/.tools (TOOLCHAIN.md), else PATH.
 * The pinned copy wins over PATH so a newer global bb can't silently produce incompatible proofs.
 */
export function toolPath(name: 'nargo' | 'bb'): string {
  const env = process.env[name.toUpperCase()];
  if (env) return env;
  const root = repoRoot();
  const pinned = root ? path.join(root, '.tools', name) : undefined;
  if (pinned && fs.existsSync(pinned)) return pinned;
  return name;
}

/** Owner-device state (policy secrets, spend state, receipts). Gitignored. $LEASH_HOME overrides. */
export function leashHome(): string {
  const dir = process.env.LEASH_HOME ?? path.join(repoRoot() ?? process.cwd(), '.leash');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Prover_<tag>.toml files the code before the private-temp-dir change wrote next to the circuits. */
const STALE_PROVER = /^Prover_\d+_\d+_[a-z0-9]+\.toml$/;
const swept = new Set<string>();

/**
 * Run `fn` with a nargo prover file holding `contents` (policy secrets: salts, caps, allowlist). The
 * file is Prover.toml in a fresh private directory (mkdtemp, 0700) under the OS temp dir, written 0600,
 * and the directory is removed afterwards, so a crash never leaves the secrets in the repo tree where
 * `git add -A` would pick them up. `fn` gets the absolute path without `.toml`, which is what
 * `nargo execute --prover-name` takes. The first call per circuit dir also deletes stale
 * Prover_<tag>.toml files that older versions left in `circuitDir`.
 */
export function withPrivateProverFile<T>(circuitDir: string, contents: string, fn: (proverName: string) => T): T {
  if (!swept.has(circuitDir)) {
    swept.add(circuitDir);
    try {
      for (const f of fs.readdirSync(circuitDir)) if (STALE_PROVER.test(f)) fs.rmSync(path.join(circuitDir, f), { force: true });
    } catch {
      // unreadable dir: nargo will report it
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leash-prover-'));
  try {
    const file = path.join(dir, 'Prover.toml');
    fs.writeFileSync(file, contents, { encoding: 'utf-8', mode: 0o600 });
    return fn(file.replace(/\.toml$/, ''));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Options for every nargo / bb child process: a hard timeout (LEASH_TOOL_TIMEOUT_MS, default 30 s)
 * with SIGKILL, so a hung tool can't block the gateway's or console's event loop indefinitely.
 */
export function toolExecOptions(): { timeout: number; killSignal: 'SIGKILL' } {
  const ms = Number(process.env.LEASH_TOOL_TIMEOUT_MS);
  return { timeout: Number.isFinite(ms) && ms > 0 ? ms : 30_000, killSignal: 'SIGKILL' };
}

/** "bb verify timed out after 30000 ms" when execFileSync hit toolExecOptions().timeout, else undefined. */
export function toolTimeoutMessage(what: string, err: unknown): string | undefined {
  const e = err as { code?: string; signal?: string | null; error?: { code?: string } };
  const timedOut = e?.code === 'ETIMEDOUT' || e?.error?.code === 'ETIMEDOUT' || e?.signal === 'SIGKILL';
  return timedOut ? `${what} timed out after ${toolExecOptions().timeout} ms` : undefined;
}
