import fs from 'fs';
import path from 'path';
import { leashHome } from '../util/paths.js';

/**
 * Owner-device record of today's spending for one policy: the running total and the spend
 * commitment the last landed payment produced. The next proof opens `commit` (prev_spend_commit)
 * with `spentCents` (spent_before). The chain or gateway holds the same commitment, so a stale or
 * forged state can't produce an accepted proof; this file is only the owner's memory of the opening.
 */
export interface SpendState {
  epoch: number;
  spentCents: number;
  commit: string;
}

export interface SpendInputs {
  epoch: number;
  prevSpendCommit: string;
  spentBeforeCents: number;
}

/** UTC day number, the same as Solidity block.timestamp / 1 days. */
export function currentEpoch(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / 86400);
}

/** Inputs for the next proof: continue today's chain, or start a new epoch from (0, 0). */
export function spendInputsFor(state: SpendState | undefined, epoch: number = currentEpoch()): SpendInputs {
  if (!state || state.epoch !== epoch) return { epoch, prevSpendCommit: '0', spentBeforeCents: 0 };
  return { epoch, prevSpendCommit: state.commit, spentBeforeCents: state.spentCents };
}

export class SpendTracker {
  private mem = new Map<string, SpendState>();

  /** persist: write <LEASH_HOME>/spend/<key>.json; otherwise in-memory only (tests, harness). */
  constructor(private readonly persist = true) {}

  private file(key: string): string {
    const dir = path.join(leashHome(), 'spend');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${key.toLowerCase().replace(/[^0-9a-z]/g, '')}.json`);
  }

  get(key: string): SpendState | undefined {
    if (!this.persist) return this.mem.get(key.toLowerCase());
    const f = this.file(key);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as SpendState) : undefined;
  }

  inputs(key: string, epoch: number = currentEpoch()): SpendInputs {
    return spendInputsFor(this.get(key), epoch);
  }

  /** Record a payment that LANDED (on chain or at the gateway): advances the chain. */
  advance(key: string, landed: { epoch: number; spentBeforeCents: number; amountCents: number; newSpendCommit: string }): SpendState {
    const next: SpendState = {
      epoch: landed.epoch,
      spentCents: landed.spentBeforeCents + landed.amountCents,
      commit: landed.newSpendCommit,
    };
    if (this.persist) fs.writeFileSync(this.file(key), JSON.stringify(next, null, 2), { mode: 0o600 });
    else this.mem.set(key.toLowerCase(), next);
    return next;
  }
}
