import fs from 'fs';
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
