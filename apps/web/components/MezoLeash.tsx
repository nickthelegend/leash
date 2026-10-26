'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, RefreshCw } from 'lucide-react';
import {
  CENT_WEI,
  LOG_RANGE,
  MEZO,
  SEL,
  TOPIC,
  abiString,
  addressUrl,
  blockUrl,
  encAddress,
  encBytes32,
  ethCall,
  fmtMusd,
  fmtToken,
  fmtUsd,
  fromE18,
  parseDeployment,
  rpc,
  short,
  toHex,
  txUrl,
  word,
  wordAddress,
  wordHex,
  type Deployment,
  type JobNote,
} from '@/lib/mezo';

const REPO_URL = 'https://github.com/nickthelegend/leash';
const REFRESH_MS = 15_000;
const MAX_JOBS = 30; // newest jobs read from storage each refresh

/* ------------------------------------------------------------------ types */

type DeploymentState = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; dep: Deployment };

type Ev = { tx: string; block: number };
type JobEvents = {
  opened?: Ev & { amountCents: bigint; deadline: number; taskHash: string };
  delivered?: Ev & { resultHash: string; uri: string };
  disputed?: Ev & { reasonHash: string };
  released?: Ev & { amountWei: bigint };
  clawed?: Ev & { amountWei: bigint; slashed: bigint };
};

type Job = {
  id: number;
  policyId: string;
  owner: string;
  provider: string;
  amountCents: bigint;
  deadline: number;
  deliveredAt: number;
  status: number;
  taskHash: string;
  resultHash: string;
};

type Board = {
  block: number;
  blockTs: number; // chain time of `block`
  readAtMs: number; // local time of the read, to tick countdowns between reads
  price: bigint;
  deployed: boolean;
  jobCount: number | null;
  escrow: bigint | null;
  bond: bigint | null;
  minBond: bigint | null;
  slashAmount: bigint | null;
  disputeWindow: number | null;
  jobs: Job[];
};

type RpcLog = { blockNumber: string; transactionHash: string; logIndex: string; topics: string[]; data: string };

const ZERO32 = `0x${'0'.repeat(64)}`;

/* ------------------------------------------------------------------ data */

function useDeployment(): DeploymentState {
  const [state, setState] = useState<DeploymentState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    fetch('/mezo/deployment.json', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`deployment.json: HTTP ${r.status}`);
        return parseDeployment(await r.json());
      })
      .then((dep) => live && setState({ status: 'ok', dep }))
      .catch((e: Error) => live && setState({ status: 'error', error: e.message }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

type Immutables = { minBond: bigint; slashAmount: bigint; disputeWindow: number; policyId: string | null };

async function readBoard(dep: Deployment | null, cache: { current: Immutables | null }, signal: AbortSignal): Promise<Board> {
  const [chainHex, blockHex] = await Promise.all([rpc<string>('eth_chainId', [], signal), rpc<string>('eth_blockNumber', [], signal)]);
  if (Number(chainHex) !== MEZO.chainId) throw new Error(`RPC is on chain ${Number(chainHex)}, not Mezo testnet (${MEZO.chainId})`);
  const at = blockHex; // every read below is pinned to this block
  const [blk, priceHex] = await Promise.all([
    rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [at, false], signal, false),
    ethCall(MEZO.priceFeed, SEL.fetchPrice, at, signal),
  ]);
  if (!blk) throw new Error(`Block ${Number(blockHex)} not found`);
  const board: Board = {
    block: Number(blockHex),
    blockTs: Number(blk.timestamp),
    readAtMs: Date.now(),
    price: word(priceHex),
    deployed: !!dep?.leashClawback,
    jobCount: null,
    escrow: null,
    bond: null,
    minBond: null,
    slashAmount: null,
    disputeWindow: null,
    jobs: [],
  };
  const c = dep?.leashClawback;
  if (!c) return board;

  if (!cache.current) {
    const [mb, sa, dw, pid] = await Promise.all([
      ethCall(c, SEL.minBond, at, signal),
      ethCall(c, SEL.slashAmount, at, signal),
      ethCall(c, SEL.disputeWindow, at, signal),
      dep.owner && dep.policyCommitment
        ? ethCall(c, SEL.policyIdOf + encAddress(dep.owner) + encBytes32(dep.policyCommitment), at, signal)
        : Promise.resolve(null),
    ]);
    cache.current = { minBond: word(mb), slashAmount: word(sa), disputeWindow: Number(word(dw)), policyId: pid ? wordHex(pid) : null };
  }
  const im = cache.current;
  board.minBond = im.minBond;
  board.slashAmount = im.slashAmount;
  board.disputeWindow = im.disputeWindow;

  const [countHex, escrowHex, bondHex] = await Promise.all([
    ethCall(c, SEL.jobCount, at, signal),
    im.policyId ? ethCall(c, SEL.policyBalance + encBytes32(im.policyId), at, signal) : Promise.resolve(null),
    dep.provider ? ethCall(c, SEL.bondOf + encAddress(dep.provider), at, signal) : Promise.resolve(null),
  ]);
  const count = Number(word(countHex));
  board.jobCount = count;
  board.escrow = escrowHex ? word(escrowHex) : null;
  board.bond = bondHex ? word(bondHex) : null;

  const ids: number[] = [];
  for (let i = count; i >= 1 && ids.length < MAX_JOBS; i--) ids.push(i);
  const raw = await Promise.all(ids.map((i) => ethCall(c, SEL.jobs + i.toString(16).padStart(64, '0'), at, signal)));
  board.jobs = raw.map((h, k) => ({
    id: ids[k],
    policyId: wordHex(h, 0),
    owner: wordAddress(h, 1),
    provider: wordAddress(h, 2),
    amountCents: word(h, 3),
    deadline: Number(word(h, 4)),
    deliveredAt: Number(word(h, 5)),
    status: Number(word(h, 6)),
    taskHash: wordHex(h, 7),
    resultHash: wordHex(h, 8),
  }));
  return board;
}

function useBoard(dep: Deployment | null, ready: boolean) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const cache = useRef<Immutables | null>(null);

  const refresh = useCallback(async () => {
    if (!ready || inFlight.current) return;
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setBusy(true);
    try {
      setBoard(await readBoard(dep, cache, ctrl.signal));
      setError(null);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setError(String((e as Error)?.message ?? e));
    } finally {
      inFlight.current = null;
      setBusy(false);
    }
  }, [dep, ready]);

  useEffect(() => {
    if (!ready) return;
    refresh();
    const t = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [ready, refresh]);

  return { board, error, busy, refresh };
}

/** Job events since deployBlock, scanned incrementally in 10k-block windows; block times for each event's block. */
function useJobEvents(contract: string | null, deployBlock: number | null, latestBlock: number | null) {
  const [events, setEvents] = useState<Record<number, JobEvents>>({});
  const [times, setTimes] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const cursor = useRef<number | null>(null);
  const first = useRef<number | null>(null);
  const running = useRef(false);
  const store = useRef<Record<number, JobEvents>>({});
  const timeStore = useRef<Record<number, number>>({});

  useEffect(() => {
    if (!contract || latestBlock === null || running.current) return;
    const start = cursor.current ?? deployBlock ?? Math.max(0, latestBlock - LOG_RANGE);
    if (first.current === null) first.current = start;
    if (start > latestBlock) return;
    running.current = true;
    (async () => {
      try {
        const windows: Array<[number, number]> = [];
        for (let a = start; a <= latestBlock; a += LOG_RANGE + 1) windows.push([a, Math.min(a + LOG_RANGE, latestBlock)]);
        const logs: RpcLog[] = [];
        for (let i = 0; i < windows.length; i += 4) {
          const batch = await Promise.all(
            windows.slice(i, i + 4).map(([a, b]) =>
              rpc<RpcLog[]>('eth_getLogs', [
                {
                  address: contract,
                  fromBlock: toHex(a),
                  toBlock: toHex(b),
                  topics: [[TOPIC.jobOpened, TOPIC.jobDelivered, TOPIC.jobDisputed, TOPIC.jobReleased, TOPIC.jobClawedBack]],
                },
              ])
            )
          );
          batch.forEach((b) => logs.push(...b));
        }
        const next = { ...store.current };
        for (const l of logs) {
          const id = Number(BigInt(l.topics[1] ?? '0x0'));
          const ev: Ev = { tx: l.transactionHash, block: Number(l.blockNumber) };
          const j: JobEvents = { ...(next[id] ?? {}) };
          if (l.topics[0] === TOPIC.jobOpened)
            j.opened = { ...ev, amountCents: word(l.data, 0), deadline: Number(word(l.data, 1)), taskHash: wordHex(l.data, 2) };
          else if (l.topics[0] === TOPIC.jobDelivered) {
            let uri = '';
            try {
              uri = abiString(l.data, 1);
            } catch {
              uri = '';
            }
            j.delivered = { ...ev, resultHash: wordHex(l.data, 0), uri };
          } else if (l.topics[0] === TOPIC.jobDisputed) j.disputed = { ...ev, reasonHash: wordHex(l.data, 0) };
          else if (l.topics[0] === TOPIC.jobReleased) j.released = { ...ev, amountWei: word(l.data, 0) };
          else if (l.topics[0] === TOPIC.jobClawedBack) j.clawed = { ...ev, amountWei: word(l.data, 0), slashed: word(l.data, 1) };
          next[id] = j;
        }
        store.current = next;
        cursor.current = latestBlock + 1;
        setEvents(next);
        setRange({ from: first.current ?? start, to: latestBlock });
        setError(null);
        const want = Array.from(new Set(logs.map((l) => Number(l.blockNumber))))
          .sort((a, b) => b - a)
          .slice(0, 80)
          .filter((n) => timeStore.current[n] === undefined);
        if (want.length) {
          const blocks = await Promise.all(
            want.map((n) => rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [toHex(n), false], undefined, false).catch(() => null))
          );
          blocks.forEach((b, i) => {
            if (b) timeStore.current[want[i]] = Number(b.timestamp);
          });
          setTimes({ ...timeStore.current });
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        running.current = false;
      }
    })();
  }, [contract, deployBlock, latestBlock]);

  return { events, times, error, range };
}

type Receipts = Record<string, TxRecord['status']>;

type TxRecord = { key: string; label: string; hash: string; note?: string; status?: 'success' | 'reverted' | 'pending' | 'error'; block?: number };

function humanize(key: string) {
  const s = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function useRecordedTxs(dep: Deployment | null) {
  const [txs, setTxs] = useState<TxRecord[]>([]);
  useEffect(() => {
    if (!dep) return;
    const list: TxRecord[] = Object.entries(dep.txs)
      .map(([key, v]) =>
        typeof v === 'string'
          ? { key, label: humanize(key), hash: v }
          : v && typeof v === 'object'
            ? { key, label: v.label ?? humanize(key), hash: v.hash, note: v.note }
            : null
      )
      .filter((t): t is TxRecord => !!t && /^0x[0-9a-fA-F]{64}$/.test(t.hash));
    setTxs(list);
    let live = true;
    Promise.all(
      list.map((t) =>
        rpc<{ status: string; blockNumber: string } | null>('eth_getTransactionReceipt', [t.hash], undefined, false)
          .then((r): TxRecord => (r ? { ...t, status: r.status === '0x1' ? 'success' : 'reverted', block: Number(r.blockNumber) } : { ...t, status: 'pending' }))
          .catch((): TxRecord => ({ ...t, status: 'error' }))
      )
    ).then((done) => live && setTxs(done));
    return () => {
      live = false;
    };
  }, [dep]);
  return txs;
}

/** Seconds of chain time, ticking every second between reads. */
function useChainNow(board: Board | null) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!board) return;
    const tick = () => setNow(board.blockTs + Math.floor((Date.now() - board.readAtMs) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [board]);
  return now;
}

/* ------------------------------------------------------------------ small pieces */

function NotDeployed({ children = 'Not deployed on Mezo testnet yet' }: { children?: React.ReactNode }) {
  return <span className="mz-nd">{children}</span>;
}

function ExtLink({ href, children, className = '' }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a className={`mz-ext ${className}`} href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function fmtDuration(s: number) {
  const v = Math.max(0, Math.floor(s));
  const d = Math.floor(v / 86400);
  const h = Math.floor((v % 86400) / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = v % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}


/* ------------------------------------------------------------------ job card */

/** An answer as written; a long integer is also read as an 18-decimal token amount, to make it legible. */
function Answer({ value }: { value: string }) {
  const big = /^\d{19,}$/.test(value);
  return (
    <span className="mz-answer">
      <span className="mono">{value}</span>
      {big && <small>= {fmtToken(BigInt(value), 2)} at 18 decimals</small>}
    </span>
  );
}

type Outcome = 'pending' | 'delivered' | 'disputed' | 'paid' | 'clawed' | 'unknown';
const outcomeOf = (status: number): Outcome =>
  status === 1 ? 'pending' : status === 2 ? 'delivered' : status === 3 ? 'disputed' : status === 4 ? 'paid' : status === 5 ? 'clawed' : 'unknown';

const STATUS_LABEL: Record<Outcome, string> = {
  pending: 'Awaiting delivery',
  delivered: 'Delivered',
  disputed: 'Disputed',
  paid: 'Paid',
  clawed: 'Clawed back',
  unknown: 'Unknown',
};

const ReceiptsCtx = React.createContext<Receipts>({});

function Step({
  state,
  label,
  ev,
  times,
  detail,
}: {
  state: 'done' | 'now' | 'todo' | 'miss' | 'paid' | 'clawed';
  label: string;
  ev?: Ev;
  times: Record<number, number>;
  detail?: React.ReactNode;
}) {
  const receipts = React.useContext(ReceiptsCtx);
  const rx = ev ? receipts[ev.tx.toLowerCase()] : undefined;
  const ts = ev ? times[ev.block] : undefined;
  const when = ts ? new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
  return (
    <li className="mz-step" data-state={state}>
      <i aria-hidden="true" />
      <div>
        <b>{label}</b>
        {detail && <span className="mz-step-detail">{detail}</span>}
        {ev && (
          <span className="mz-step-tx">
            <ExtLink href={txUrl(ev.tx)} className="mono">
              <span title={ts ? new Date(ts * 1000).toLocaleString() : undefined}>{when ?? `block ${ev.block.toLocaleString('en-US')}`}</span>
            </ExtLink>
            {rx === 'success' && <span className="mz-rx-ok">receipt status 1</span>}
          </span>
        )}
      </div>
    </li>
  );
}

function JobCard({
  job,
  ev,
  note,
  times,
  now,
  disputeWindow,
  arbiter,
}: {
  job: Job;
  ev: JobEvents;
  note?: JobNote;
  times: Record<number, number>;
  now: number | null;
  disputeWindow: number | null;
  arbiter: string | null;
}) {
  const o = outcomeOf(job.status);
  const delivered = job.deliveredAt > 0 || !!ev.delivered;
  const resultHash = job.resultHash !== ZERO32 ? job.resultHash : ev.delivered?.resultHash ?? null;
  const windowEnd = job.deliveredAt && disputeWindow !== null ? job.deliveredAt + disputeWindow : null;

  let clock: React.ReactNode = null;
  if (o === 'pending' && now !== null)
    clock =
      now <= job.deadline ? (
        <>
          Deadline in <b>{fmtDuration(job.deadline - now)}</b>
        </>
      ) : (
        <>
          <b>Deadline passed.</b> Anyone can claw this back now.
        </>
      );
  else if (o === 'delivered' && now !== null && windowEnd !== null)
    clock =
      now <= windowEnd ? (
        <>
          Dispute window closes in <b>{fmtDuration(windowEnd - now)}</b>
        </>
      ) : (
        <>
          <b>Window closed.</b> Anyone can release the payment.
        </>
      );
  else if (o === 'disputed')
    clock = <>The policy&rsquo;s arbiter{arbiter ? ` ${short(arbiter)}` : ''} decides: pay the provider, or claw back and slash.</>;

  const releasedBy = ev.released
    ? ev.disputed
      ? 'Arbiter released it'
      : windowEnd !== null && times[ev.released.block] !== undefined && times[ev.released.block] <= windowEnd
        ? 'Owner accepted'
        : 'Released after the window'
    : null;
  const clawReason = ev.disputed ? 'Arbiter upheld the dispute' : !delivered ? 'Missed the deadline' : null;

  return (
    <article className="mz-job" data-outcome={o} aria-labelledby={`job-${job.id}`}>
      {o === 'clawed' && (
        <div className="mz-stamp" aria-hidden="true">
          Clawed back
        </div>
      )}
      <header className="mz-job-top">
        <h3 id={`job-${job.id}`}>Job #{job.id}</h3>
        <span className="mz-chip" data-outcome={o}>
          {STATUS_LABEL[o]}
        </span>
      </header>

      <div className="mz-job-amount">
        <b>{fmtMusd(job.amountCents * CENT_WEI)}</b> MUSD
        <small>{job.amountCents.toString()} cents · provider <ExtLink href={addressUrl(job.provider)} className="mono">{short(job.provider)}</ExtLink></small>
      </div>

      <dl className="mz-job-io">
        <div>
          <dt>Task</dt>
          <dd>
            {note?.task ? <q>{note.task}</q> : null}
            <span className="mono mz-hash" title={job.taskHash}>
              {note?.task ? 'hash ' : ''}
              {short(job.taskHash, 10, 8)}
            </span>
          </dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>
            {note?.answer ? <Answer value={note.answer} /> : null}
            {resultHash ? (
              <span className="mono mz-hash" title={resultHash}>
                {note?.answer ? 'hash ' : ''}
                {short(resultHash, 10, 8)}
              </span>
            ) : (
              <span className="mz-muted">{o === 'clawed' || (o === 'pending' && now !== null && now > job.deadline) ? 'Never delivered' : 'Not delivered yet'}</span>
            )}
            {ev.delivered?.uri && <span className="mono mz-hash">uri {ev.delivered.uri}</span>}
          </dd>
        </div>
        {note?.correct && (
          <div>
            <dt>Correct</dt>
            <dd>
              <Answer value={note.correct} />
              <span className="mz-note-src">the arbiter&rsquo;s re-check, from the run&rsquo;s notes</span>
            </dd>
          </div>
        )}
        {note?.verdict && (
          <div>
            <dt>Verdict</dt>
            <dd>
              {note.verdict}
              <span className="mz-note-src">note from the run, off-chain</span>
            </dd>
          </div>
        )}
      </dl>

      {o === 'clawed' && (
        <div className="mz-claw">
          <p>
            <b>+{fmtMusd(ev.clawed?.amountWei ?? job.amountCents * CENT_WEI)} MUSD</b> back to the owner&rsquo;s escrow
          </p>
          <p>
            <b>{ev.clawed ? `${fmtToken(ev.clawed.slashed, 4)} MEZO` : '—'}</b> slashed from the provider&rsquo;s bond
          </p>
          {clawReason && <p className="mz-claw-why">{clawReason}</p>}
        </div>
      )}
      {o === 'paid' && (
        <div className="mz-paid">
          <b>{fmtMusd(ev.released?.amountWei ?? job.amountCents * CENT_WEI)} MUSD</b> paid to the provider
          {releasedBy && <span> · {releasedBy}</span>}
        </div>
      )}
      {clock && (
        <p className="mz-clock" role="timer" aria-live="off">
          {clock}
        </p>
      )}

      <ol className="mz-steps-line" aria-label={`Job ${job.id} lifecycle`}>
        <Step state="done" label="Opened" ev={ev.opened} times={times} detail="ZK-proven payment held in escrow" />
        {delivered ? (
          <Step state="done" label="Delivered" ev={ev.delivered} times={times} />
        ) : o === 'clawed' || (now !== null && now > job.deadline) ? (
          <Step state="miss" label="No delivery" times={times} detail="deadline missed" />
        ) : (
          <Step state="now" label="Delivery" times={times} detail="due before the deadline" />
        )}
        {(ev.disputed || o === 'disputed') && <Step state={o === 'disputed' ? 'now' : 'done'} label="Disputed" ev={ev.disputed} times={times} />}
        {o === 'paid' ? (
          <Step state="paid" label="Paid" ev={ev.released} times={times} />
        ) : o === 'clawed' ? (
          <Step state="clawed" label="Clawed back" ev={ev.clawed} times={times} />
        ) : (
          <Step state="todo" label="Paid or clawed back" times={times} />
        )}
      </ol>
    </article>
  );
}

/* ------------------------------------------------------------------ sections */

function Hero({ hasHero }: { hasHero: boolean }) {
  return (
    <header className={`mz-hero${hasHero ? ' has-art' : ''}`} id="top">
      <div className="lz-wrap mz-hero-inner">
        <div className="mz-hero-copy">
          <p className="mz-kicker">
            <span>LEASH</span> on <span>Mezo</span> · pay on delivery in MUSD
          </p>
          <h1 className="mz-h1">
            AI agents get paid in MUSD. <em>Bad work gets clawed back.</em>
          </h1>
          <p className="mz-lead">
            Your agent hires other agents on Mezo. Payment waits in escrow until the work is delivered: miss the deadline
            or return a wrong answer, and the MUSD comes back to you, plus a slice of the provider&rsquo;s MEZO bond.
          </p>
          <div className="lz-cta">
            <a className="btn btn-dark" href="#jobs">
              See the live jobs <ArrowDown aria-hidden="true" />
            </a>
            <a className="btn btn-line" href={REPO_URL} target="_blank" rel="noreferrer">
              GitHub <ArrowUpRight aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
      </div>
      {hasHero && <div className="mz-hero-art" aria-hidden="true" />}
    </header>
  );
}

function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="mz-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {note && <p>{note}</p>}
    </div>
  );
}

function JobsBoard({ dep, depError }: { dep: Deployment | null; depError: string | null }) {
  const ready = dep !== null || depError !== null;
  const { board, error, busy, refresh } = useBoard(dep, ready);
  const contract = dep?.leashClawback ?? null;
  const { events, times, error: logError, range } = useJobEvents(contract, dep?.deployBlock ?? null, board?.deployed ? board.block : null);
  const now = useChainNow(board);
  const deployed = !!contract;

  const all = Object.values(events);
  const paid = all.filter((e) => e.released).length;
  const clawed = all.filter((e) => e.clawed);
  const returned = clawed.reduce((s, e) => s + (e.clawed?.amountWei ?? BigInt(0)), BigInt(0));
  const slashed = clawed.reduce((s, e) => s + (e.clawed?.slashed ?? BigInt(0)), BigInt(0));
  const logsReady = range !== null && !logError;
  const skel = <span className="mz-skel" />;
  // Seven 'not deployed' badges would shout; the board below says it once.
  const nd = (
    <span className="mz-dash">
      —<span className="sr-only"> not deployed yet</span>
    </span>
  );
  const fromLogs = (v: React.ReactNode) => (!deployed ? nd : logsReady ? v : logError ? 'Unavailable' : skel);
  const notes = new Map((dep?.jobs ?? []).map((n) => [n.jobId, n]));

  return (
    <section className="mz-live" id="jobs" aria-labelledby="jobs-h">
      <div className="lz-wrap">
        <div className="mz-sec-head">
          <div>
            <p className="lz-num">Live from Mezo testnet · chain {MEZO.chainId}</p>
            <h2 className="lz-h2" id="jobs-h">
              The jobs board, read live.
            </h2>
          </div>
          <p className="mz-sec-sub">
            Read in your browser from <span className="mono">rpc.test.mezo.org</span>: each job&rsquo;s state from
            LeashClawback&rsquo;s storage, its history from the contract&rsquo;s events. Nothing here is recorded or
            replayed.
          </p>
        </div>

        <div className="mz-board-top">
          <div className="mz-pill" data-state={error ? 'error' : board ? 'live' : 'loading'} role="status" aria-live="polite">
            <i aria-hidden="true" />
            {error ? 'RPC error' : board ? `Live · block ${board.block.toLocaleString('en-US')}` : 'Reading Mezo testnet…'}
          </div>
          {board && (
            <span className="mz-btc">
              BTC <b>{fmtUsd(fromE18(board.price))}</b> <span>Mezo PriceFeed</span>
            </span>
          )}
          <button type="button" className="btn btn-ghost-light btn-sm mz-refresh" aria-label="Refresh now" onClick={refresh} disabled={busy || !ready}>
            <RefreshCw aria-hidden="true" className={busy ? 'mz-spin' : ''} />
            <span className="mz-refresh-label">Refresh</span>
          </button>
        </div>

        {(error || depError) && (
          <div role="alert" className="mz-alert">
            {depError && <p>Could not load the LEASH deployment record: {depError}</p>}
            {error && (
              <p>
                {error}
                {board ? ` Showing block ${board.block.toLocaleString('en-US')} from ${new Date(board.readAtMs).toLocaleTimeString()}.` : ''}
              </p>
            )}
          </div>
        )}

        <dl className="mz-strip" aria-label="Totals">
          <Stat label="Jobs opened" value={!deployed ? nd : board?.jobCount != null ? board.jobCount : skel} />
          <Stat label="Paid" value={fromLogs(paid)} />
          <Stat label="Clawed back" value={fromLogs(clawed.length)} />
          <Stat
            label="MUSD returned"
            value={fromLogs(fmtMusd(returned))}
            note={deployed ? 'to owners, by clawbacks' : undefined}
          />
          <Stat label="MEZO slashed" value={fromLogs(fmtToken(slashed, 4))} note={deployed ? 'from provider bonds' : undefined} />
          <Stat
            label="Owner escrow"
            value={!deployed ? nd : !dep?.owner || !dep.policyCommitment ? <span className="mz-dash">not set</span> : board?.escrow != null ? <>{fmtMusd(board.escrow)} <small>MUSD</small></> : skel}
            note={deployed ? 'policyBalance' : undefined}
          />
          <Stat
            label="Provider bond"
            value={!deployed ? nd : !dep?.provider ? <span className="mz-dash">not set</span> : board?.bond != null ? <>{fmtToken(board.bond, 4)} <small>MEZO</small></> : skel}
            note={board?.minBond != null ? `min ${fmtToken(board.minBond, 4)} · slash ${fmtToken(board.slashAmount ?? BigInt(0), 4)}` : undefined}
          />
        </dl>

        {!deployed ? (
          <div className="mz-board-empty">
            <h3>Not deployed on Mezo testnet yet</h3>
            <p>
              When LeashClawback is live, every job it holds shows up here with its amount, provider, task and result
              hashes, deadline, and how it ended. Until then there is nothing to show, so nothing is shown.
            </p>
            <ol className="mz-flow" aria-label="How a job moves">
              <li>Opened</li>
              <li>Delivered</li>
              <li className="ok">Paid</li>
              <li className="no">or clawed back</li>
            </ol>
          </div>
        ) : !board ? (
          <div className="mz-board-empty">
            <h3>{error ? 'Could not read the jobs' : 'Reading the jobs…'}</h3>
          </div>
        ) : board.jobs.length === 0 ? (
          <div className="mz-board-empty">
            <h3>No jobs yet</h3>
            <p>
              LeashClawback at <span className="mono">{short(contract)}</span> has jobCount 0 at block{' '}
              {board.block.toLocaleString('en-US')}.
            </p>
          </div>
        ) : (
          <>
            <div className="mz-jobs">
              {[...board.jobs].sort((a, b) => a.id - b.id).map((j) => (
                <JobCard
                  key={j.id}
                  job={j}
                  ev={events[j.id] ?? {}}
                  note={notes.get(j.id)}
                  times={times}
                  now={now}
                  disputeWindow={board.disputeWindow}
                  arbiter={dep?.arbiter ?? null}
                />
              ))}
            </div>
            {logError && (
              <div role="alert" className="mz-alert">
                <p>Could not read the job events (tx links and totals): {logError}</p>
              </div>
            )}
          </>
        )}

        <p className="mz-board-foot">
          {board ? (
            <>
              Last read at block{' '}
              <a href={blockUrl(board.block)} target="_blank" rel="noreferrer" className="mono">
                {board.block.toLocaleString('en-US')}
              </a>
              , {new Date(board.readAtMs).toLocaleTimeString()} · refreshes every 15 s
              {range ? ` · events from block ${range.from.toLocaleString('en-US')}` : ''}
              {deployed && dep?.deployBlock == null && range ? ' (deployBlock not set: last 10,000 blocks only)' : ''}
              {board.jobCount !== null && board.jobCount > MAX_JOBS ? ` · newest ${MAX_JOBS} of ${board.jobCount} jobs shown` : ''}
            </>
          ) : (
            'Waiting for the first read…'
          )}
        </p>
      </div>
    </section>
  );
}

const STEPS: Array<[string, string]> = [
  ['Borrow MUSD against BTC', 'Open a Mezo Borrow trove with Bitcoin as collateral, mint MUSD, and fund your LEASH policy escrow with it.'],
  [
    'Your agent hires a provider',
    'It pays with a zero-knowledge proof that the payment fits your hidden policy (payees, per-payment cap, daily cap). The MUSD moves into the job, not to the provider.',
  ],
  ['The provider delivers', 'A bonded provider agent posts a hash of its result, and where to fetch it, before the deadline.'],
  [
    'Good work is paid. Bad work is clawed back.',
    'Accept it, or let the dispute window pass, and the provider is paid. Miss the deadline, or lose a dispute, and the MUSD returns to you with a slice of the provider’s MEZO bond.',
  ],
];

function HowItWorks() {
  return (
    <section className="lz-sec lz-cream" id="how" aria-labelledby="how-h">
      <div className="lz-wrap">
        <h2 className="lz-h2" id="how-h">
          Pay on delivery, enforced on‑chain.
        </h2>
        <ol className="lz-steps mz-steps-4">
          {STEPS.map(([title, body], i) => (
            <li key={title}>
              <span className="lz-num">0{i + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
        <p className="lz-fine">
          Amounts in proofs are cents; 1 cent settles as 10<sup>16</sup> MUSD wei. A provider can&rsquo;t withdraw its bond
          while it holds open jobs, and disputes go to an arbiter the owner names when registering the policy.
        </p>
      </div>
    </section>
  );
}

function Contracts({ dep, depError, txs }: { dep: Deployment | null; depError: string | null; txs: TxRecord[] }) {
  const rows: Array<{ name: string; role: string; addr: string | null; nd?: string }> = [
    { name: 'LeashClawback', role: 'Job escrow in MUSD, MEZO bonds, clawbacks', addr: dep?.leashClawback ?? null },
    { name: 'LeashVerifier', role: 'UltraHonk verifier for the Noir policy circuit', addr: dep?.verifier ?? null },
    { name: 'MUSD', role: 'Mezo’s Bitcoin-backed stablecoin', addr: MEZO.musd },
    { name: 'MEZO', role: 'Mezo token; providers bond it, clawbacks slash it', addr: MEZO.mezo },
    { name: 'BorrowerOperations', role: 'Open a trove and borrow MUSD against BTC', addr: MEZO.borrowerOperations },
  ];
  const parties: Array<[string, string, string | null]> = [
    ['Policy owner', 'Borrowed the MUSD; funds the escrow, gets clawbacks and slashes', dep?.owner ?? null],
    ['Owner’s agent', 'Relays the ZK-proven payments that open jobs', dep?.agent ?? null],
    ['Provider', 'Bonded agent that does the work', dep?.provider ?? null],
    ['Arbiter', 'Resolves the owner’s disputes', dep?.arbiter ?? null],
  ];
  return (
    <section className="lz-sec lz-paper" id="contracts" aria-labelledby="contracts-h">
      <div className="lz-wrap">
        <div className="mz-sec-head">
          <div>
            <p className="lz-num">Mezo testnet · chain {MEZO.chainId}</p>
            <h2 className="lz-h2" id="contracts-h">
              Contracts
            </h2>
          </div>
          <p className="mz-sec-sub">
            MUSD and BorrowerOperations are from the mezo-org/musd matsnet deployment. The LEASH addresses come from{' '}
            <span className="mono">/mezo/deployment.json</span>
            {depError ? ', which could not be loaded.' : '.'}
          </p>
        </div>
        <ul className="mz-contracts">
          {rows.map((r) => (
            <li key={r.name}>
              <div>
                <h3>{r.name}</h3>
                <p>{r.role}</p>
              </div>
              {r.addr ? (
                <ExtLink href={addressUrl(r.addr)} className="mono mz-addr">
                  {r.addr}
                </ExtLink>
              ) : (
                <NotDeployed />
              )}
            </li>
          ))}
          {parties
            .filter(([, , a]) => a)
            .map(([name, role, a]) => (
              <li key={name}>
                <div>
                  <h3>{name}</h3>
                  <p>{role}</p>
                </div>
                <ExtLink href={addressUrl(a!)} className="mono mz-addr">
                  {a}
                </ExtLink>
              </li>
            ))}
          {dep?.policyCommitment && (
            <li>
              <div>
                <h3>Policy commitment</h3>
                <p>Pedersen commitment to the hidden policy</p>
              </div>
              <span className="mono mz-addr">{dep.policyCommitment}</span>
            </li>
          )}
        </ul>

        {txs.length > 0 && (
          <>
            <h3 className="mz-h3">Recorded transactions</h3>
            <ul className="mz-contracts">
              {txs.map((t) => (
                <li key={t.key}>
                  <div>
                    <h3>{t.label}</h3>
                    <p>
                      <span className="mz-rx" data-status={t.status ?? 'loading'}>
                        {t.status === 'success'
                          ? `Succeeded in block ${t.block?.toLocaleString('en-US')}`
                          : t.status === 'reverted'
                            ? `Reverted on-chain in block ${t.block?.toLocaleString('en-US')}`
                            : t.status === 'pending'
                              ? 'No receipt yet'
                              : t.status === 'error'
                                ? 'Receipt not returned by the RPC (retried once)'
                                : 'Reading receipt…'}
                      </span>
                      {t.note ? ` · ${t.note}` : ''}
                    </p>
                  </div>
                  <ExtLink href={txUrl(t.hash)} className="mono mz-addr">
                    {t.hash}
                  </ExtLink>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ page */

export function MezoLeash({ hasHero }: { hasHero: boolean }) {
  const depState = useDeployment();
  const dep = depState.status === 'ok' ? depState.dep : null;
  const depError = depState.status === 'error' ? depState.error : null;
  const txs = useRecordedTxs(dep);
  const receipts = React.useMemo(() => Object.fromEntries(txs.map((t) => [t.hash.toLowerCase(), t.status])) as Receipts, [txs]);
  return (
    <ReceiptsCtx.Provider value={receipts}>
      <Hero hasHero={hasHero} />
      <JobsBoard dep={dep} depError={depError} />
      <HowItWorks />
      <Contracts dep={dep} depError={depError} txs={txs} />
    </ReceiptsCtx.Provider>
  );
}
