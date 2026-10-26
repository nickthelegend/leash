'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, RefreshCw } from 'lucide-react';
import {
  CENT_WEI,
  ICR_UNBOUNDED,
  LOG_RANGE,
  MCR,
  MEZO,
  SEL,
  TOPIC,
  TROVE_STATUS,
  addressUrl,
  blockUrl,
  encAddress,
  encBytes32,
  ethCall,
  fmtMusd,
  fmtPct,
  fmtUsd,
  fromE18,
  parseDeployment,
  rpc,
  short,
  toHex,
  txUrl,
  word,
  wordAddress,
  type Deployment,
} from '@/lib/mezo';

const REPO_URL = 'https://github.com/nickthelegend/leash';
const REFRESH_MS = 15_000;

type DeploymentState = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ok'; dep: Deployment };

type Live = {
  block: number;
  readAt: Date;
  price: bigint; // PriceFeed.fetchPrice(), USD per BTC, 1e18
  musdSupply: bigint;
  // Present only when LeashMUSD and the owner are in deployment.json.
  trove: { status: number; icr: bigint } | null;
  policyId: string | null;
  balance: bigint | null; // policy escrow, MUSD wei
  floor: bigint | null; // minTroveICR, 1e18; 0 = guard off
};

type FeedItem = {
  key: string;
  kind: 'payment' | 'guard';
  block: number;
  txHash: string;
  policyId: string;
  amountCents?: bigint;
  recipient?: string;
  icr?: bigint;
  floor?: bigint;
};

type RpcLog = { blockNumber: string; transactionHash: string; logIndex: string; topics: string[]; data: string };

/* ------------------------------------------------------------------ data hooks */

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

async function readLive(dep: Deployment | null, policyIdCache: { current: string | null }, signal: AbortSignal): Promise<Live> {
  const [chainHex, blockHex] = await Promise.all([rpc<string>('eth_chainId', [], signal), rpc<string>('eth_blockNumber', [], signal)]);
  if (Number(chainHex) !== MEZO.chainId) throw new Error(`RPC is on chain ${Number(chainHex)}, not Mezo testnet (${MEZO.chainId})`);
  const at = blockHex; // every read below is pinned to this one block
  const [priceHex, supplyHex] = await Promise.all([
    ethCall(MEZO.priceFeed, SEL.fetchPrice, at, signal),
    ethCall(MEZO.musd, SEL.totalSupply, at, signal),
  ]);
  const live: Live = {
    block: Number(blockHex),
    readAt: new Date(),
    price: word(priceHex),
    musdSupply: word(supplyHex),
    trove: null,
    policyId: null,
    balance: null,
    floor: null,
  };
  if (!dep?.leashMUSD || !dep.owner) return live;
  const leash = dep.leashMUSD;
  const health = await ethCall(leash, SEL.troveHealth + encAddress(dep.owner), at, signal);
  live.trove = { status: Number(word(health, 0)), icr: word(health, 1) };
  if (dep.policyCommitment) {
    if (!policyIdCache.current) {
      const pid = await ethCall(leash, SEL.policyIdOf + encAddress(dep.owner) + encBytes32(dep.policyCommitment), at, signal);
      policyIdCache.current = `0x${pid.replace(/^0x/, '').slice(0, 64)}`;
    }
    const pid = encBytes32(policyIdCache.current);
    const [bal, floor] = await Promise.all([
      ethCall(leash, SEL.policyBalance + pid, at, signal),
      ethCall(leash, SEL.minTroveICR + pid, at, signal),
    ]);
    live.policyId = policyIdCache.current;
    live.balance = word(bal);
    live.floor = word(floor);
  }
  return live;
}

function useLiveLeash(dep: Deployment | null, ready: boolean) {
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const policyIdCache = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ready || inFlight.current) return;
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setBusy(true);
    try {
      const next = await readLive(dep, policyIdCache, ctrl.signal);
      setLive(next);
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
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [ready, refresh]);

  return { live, error, busy, refresh };
}

function decodeLog(l: RpcLog): FeedItem | null {
  const base = {
    key: `${l.transactionHash}:${l.logIndex}`,
    block: Number(l.blockNumber),
    txHash: l.transactionHash,
    policyId: l.topics[1] ?? '',
  };
  if (l.topics[0] === TOPIC.paymentReleased)
    return { ...base, kind: 'payment', amountCents: word(l.data, 0), recipient: wordAddress(l.data, 1), icr: word(l.data, 2) };
  if (l.topics[0] === TOPIC.troveGuardSet) return { ...base, kind: 'guard', floor: word(l.data, 0) };
  return null;
}

/** PaymentReleased and TroveGuardSet logs since deployBlock, scanned incrementally in 10k-block windows. */
function useFeed(dep: Deployment | null, latestBlock: number | null) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [times, setTimes] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [scannedTo, setScannedTo] = useState<number | null>(null);
  const [fromBlock, setFromBlock] = useState<number | null>(null);
  const cursor = useRef<number | null>(null);
  const running = useRef(false);
  const timesRef = useRef<Record<number, number>>({});

  useEffect(() => {
    const leash = dep?.leashMUSD;
    if (!leash || latestBlock === null || running.current) return;
    const start = cursor.current ?? (dep.deployBlock ?? Math.max(0, latestBlock - LOG_RANGE));
    if (cursor.current === null) setFromBlock(start);
    if (start > latestBlock) return;
    running.current = true;
    (async () => {
      try {
        const windows: Array<[number, number]> = [];
        for (let a = start; a <= latestBlock; a += LOG_RANGE + 1) windows.push([a, Math.min(a + LOG_RANGE, latestBlock)]);
        const found: FeedItem[] = [];
        for (let i = 0; i < windows.length; i += 4) {
          const batch = await Promise.all(
            windows.slice(i, i + 4).map(([a, b]) =>
              rpc<RpcLog[]>('eth_getLogs', [
                { address: leash, fromBlock: toHex(a), toBlock: toHex(b), topics: [[TOPIC.paymentReleased, TOPIC.troveGuardSet]] },
              ])
            )
          );
          for (const logs of batch) for (const l of logs) {
            const it = decodeLog(l);
            if (it) found.push(it);
          }
        }
        cursor.current = latestBlock + 1;
        setScannedTo(latestBlock);
        setError(null);
        if (found.length) {
          setItems((prev) => {
            const seen = new Set(prev.map((p) => p.key));
            return [...prev, ...found.filter((f) => !seen.has(f.key))].sort((x, y) => y.block - x.block || (x.key < y.key ? 1 : -1));
          });
          // Block times for what the feed shows (newest 30), each block fetched once.
          const want = Array.from(new Set(found.map((f) => f.block)))
            .sort((a, b) => b - a)
            .slice(0, 30)
            .filter((n) => timesRef.current[n] === undefined);
          const blocks = await Promise.all(want.map((n) => rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [toHex(n), false])));
          blocks.forEach((b, i) => {
            if (b) timesRef.current[want[i]] = Number(b.timestamp);
          });
          setTimes({ ...timesRef.current });
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        running.current = false;
      }
    })();
  }, [dep, latestBlock]);

  return { items, times, error, scannedTo, fromBlock };
}

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
      .map(([key, v]) => (typeof v === 'string' ? { key, label: humanize(key), hash: v } : v && typeof v === 'object' ? { key, label: v.label ?? humanize(key), hash: v.hash, note: v.note } : null))
      .filter((t): t is TxRecord => !!t && /^0x[0-9a-fA-F]{64}$/.test(t.hash));
    setTxs(list);
    let live = true;
    Promise.all(
      list.map((t) =>
        rpc<{ status: string; blockNumber: string } | null>('eth_getTransactionReceipt', [t.hash])
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

/* ------------------------------------------------------------------ pieces */

type Tone = 'slack' | 'taut' | 'snap' | 'idle';

function toneOf(live: Live | null): Tone {
  if (!live?.trove) return 'idle';
  const { status, icr } = live.trove;
  const floor = live.floor ?? BigInt(0);
  if (status !== 1) return floor > BigInt(0) ? 'snap' : 'idle';
  const line = floor > BigInt(0) ? floor : MCR;
  if (icr < line) return 'snap';
  if (icr < (line * BigInt(110)) / BigInt(100)) return 'taut';
  return 'slack';
}

function TensionGauge({ live, deployed }: { live: Live | null; deployed: boolean }) {
  const icr = live?.trove && live.trove.status === 1 ? live.trove.icr : null;
  const floor = live?.floor && live.floor > BigInt(0) ? live.floor : null;
  const icrN = icr !== null ? (icr >= ICR_UNBOUNDED ? Infinity : fromE18(icr)) : null;
  const floorN = floor !== null ? fromE18(floor) : null;
  const mcrN = 1.1;
  const want = Math.max(2, Number.isFinite(icrN ?? 0) ? (icrN ?? 0) * 1.12 : 0, (floorN ?? 0) * 1.4);
  const maxN = Math.min(4, Math.ceil(want * 2) / 2);
  const pos = (x: number) => Math.max(0, Math.min(100, ((x - 1) / (maxN - 1)) * 100));
  const ticks: number[] = [];
  for (let t = 1; t <= maxN + 1e-9; t += maxN > 3 ? 1 : 0.5) ticks.push(t);
  const tone = toneOf(live);
  const offScale = icrN !== null && icrN > maxN;
  const label =
    icrN === null
      ? deployed
        ? 'No active trove to measure'
        : 'Not deployed on Mezo testnet yet'
      : `ICR ${icrN === Infinity ? 'unbounded' : `${(icrN * 100).toFixed(1)}%`}${floorN ? `, guard floor ${(floorN * 100).toFixed(0)}%` : ', guard off'}, Mezo MCR 110%`;

  return (
    <figure className="mz-gauge" data-tone={tone} aria-label={`Leash tension: ${label}`}>
      <div className="mz-gauge-track" role="img" aria-label={label}>
        <span className="mz-zone mz-zone-liq" style={{ left: 0, width: `${pos(mcrN)}%` }} />
        {(icrN !== null || floorN !== null) && (
          <span className="mz-zone mz-zone-slack" style={{ left: `${pos(floorN ?? mcrN)}%`, right: 0 }} />
        )}
        {floorN !== null && <span className="mz-zone mz-zone-taut" style={{ left: `${pos(mcrN)}%`, width: `${pos(floorN) - pos(mcrN)}%` }} />}
        {icrN !== null && <span className="mz-gauge-cord" style={{ width: `${pos(Math.min(icrN, maxN))}%` }} />}
        <span className="mz-line mz-line-mcr" style={{ left: `${pos(mcrN)}%` }} />
        {floorN !== null && <span className="mz-line mz-line-floor" style={{ left: `${pos(floorN)}%` }} />}
        {icrN !== null && (
          <span className="mz-knot" style={{ left: `${pos(Math.min(icrN, maxN))}%` }} data-off={offScale || undefined} />
        )}
      </div>
      <div className="mz-gauge-marks" aria-hidden="true">
        <span className="mz-mark mz-mark-mcr" style={{ left: `${pos(mcrN)}%` }}>
          MCR 110%
        </span>
        {floorN !== null && (
          <span className="mz-mark mz-mark-floor" style={{ left: `${pos(floorN)}%` }}>
            Guard {(floorN * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <ol className="mz-gauge-scale" aria-hidden="true">
        {ticks.map((t) => (
          <li key={t} style={{ left: `${pos(t)}%` }}>
            {(t * 100).toFixed(0)}%
          </li>
        ))}
      </ol>
      <figcaption className="mz-gauge-legend">
        <span>
          <i className="mz-key mz-key-liq" /> Below 110%: Mezo liquidation zone
        </span>
        <span>
          <i className="mz-key mz-key-taut" /> Under the guard: LeashMUSD refuses to pay
        </span>
        {offScale && <span className="mz-off">ICR is beyond the scale shown</span>}
      </figcaption>
    </figure>
  );
}

function Stat({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="mz-stat">
      <dt>{label}</dt>
      <dd>{children}</dd>
      {note && <p>{note}</p>}
    </div>
  );
}

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

/* ------------------------------------------------------------------ sections */

function Hero({ hasHero }: { hasHero: boolean }) {
  return (
    <header className={`mz-hero${hasHero ? ' has-art' : ''}`} id="top">
      <div className="lz-wrap mz-hero-inner">
        <div className="mz-hero-copy">
          <p className="mz-kicker">
            <span>LEASH</span> on <span>Mezo</span> · Bitcoin-backed MUSD
          </p>
          <h1 className="mz-h1">
            Bitcoin credit for AI agents. <em>On a leash.</em>
          </h1>
          <p className="mz-lead">
            Borrow MUSD against your BTC, then let an agent spend it only with zero-knowledge proofs, and only while
            your trove stays healthy.
          </p>
          <div className="lz-cta">
            <a className="btn btn-dark" href="#live">
              See the live leash <ArrowDown aria-hidden="true" />
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

function LivePanel({ dep, depError }: { dep: Deployment | null; depError: string | null }) {
  const ready = dep !== null || depError !== null;
  const { live, error, busy, refresh } = useLiveLeash(dep, ready);
  const deployed = !!dep?.leashMUSD;
  const tone = toneOf(live);
  const floor = live?.floor ?? null;
  const trove = live?.trove ?? null;
  const icrActive = trove && trove.status === 1;
  const unbounded = icrActive && trove.icr >= ICR_UNBOUNDED;

  let verdict: React.ReactNode = null;
  if (!deployed) verdict = 'LeashMUSD is not on Mezo testnet yet, so there is no owner trove or escrow to read. The BTC price and the MCR line are live.';
  else if (!dep?.owner) verdict = 'The owner address is not set in deployment.json yet.';
  else if (trove && floor !== null) {
    if (floor === BigInt(0)) verdict = 'Guard off: payments from this policy do not check the trove.';
    else if (!icrActive) verdict = `Trove ${TROVE_STATUS[trove.status] ?? `status ${trove.status}`}: LeashMUSD reverts every payment with TroveNotActive(owner).`;
    else if (tone === 'snap') verdict = 'Snapped: the ICR is under the guard, so LeashMUSD reverts with TroveBelowLeash(owner, icr, floor).';
    else if (tone === 'taut') verdict = 'Taut: within 10% of the guard floor. Payments still clear, but not for long if BTC keeps falling.';
    else verdict = 'Slack: the trove clears the guard, so a valid proof can release MUSD.';
  } else if (trove && !icrActive) verdict = `Trove ${TROVE_STATUS[trove.status] ?? `status ${trove.status}`}.`;

  // ICR scales linearly with price (collateral x price / debt), so the price where the leash snaps follows.
  const snapPrice = live && icrActive && !unbounded && floor && floor > BigInt(0) ? (live.price * floor) / trove.icr : null;
  const liqPrice = live && icrActive && !unbounded ? (live.price * MCR) / trove.icr : null;

  return (
    <section className="mz-live" id="live" aria-labelledby="live-h">
      <div className="lz-wrap">
        <div className="mz-sec-head">
          <div>
            <p className="lz-num">Live from Mezo testnet · chain {MEZO.chainId}</p>
            <h2 className="lz-h2" id="live-h">
              The leash, read live.
            </h2>
          </div>
          <p className="mz-sec-sub">
            Straight from <span className="mono">rpc.test.mezo.org</span> in your browser: Mezo&rsquo;s PriceFeed, the
            owner&rsquo;s trove through LeashMUSD, and the policy escrow. Every read is pinned to one block.
          </p>
        </div>

        <div className="mz-panel" data-tone={tone}>
          <div className="mz-panel-top">
            <div className="mz-pill" data-state={error ? 'error' : live ? 'live' : 'loading'} role="status" aria-live="polite">
              <i aria-hidden="true" />
              {error ? 'RPC error' : live ? `Live · block ${live.block.toLocaleString('en-US')}` : 'Reading Mezo testnet…'}
            </div>
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
                  {live ? ` Showing block ${live.block.toLocaleString('en-US')} from ${live.readAt.toLocaleTimeString()}.` : ''}
                </p>
              )}
            </div>
          )}

          <div className="mz-panel-grid">
            <div className="mz-icr">
              <p className="mz-label">Owner trove ICR</p>
              {!deployed ? (
                <>
                  <p className="mz-icr-num is-empty is-none" aria-label="No trove ICR: not deployed">
                    —
                  </p>
                  <NotDeployed />
                </>
              ) : !live ? (
                <p className="mz-icr-num is-empty" aria-label="Loading">
                  <span className="mz-skel" />
                </p>
              ) : !trove ? (
                <p className="mz-icr-num is-empty is-none">—</p>
              ) : icrActive ? (
                <p className="mz-icr-num" data-tone={tone}>
                  {unbounded ? 'No debt' : fmtPct(trove.icr)}
                </p>
              ) : (
                <p className="mz-icr-num is-empty" data-tone={tone}>
                  Inactive
                </p>
              )}
              {verdict && <p className="mz-verdict">{verdict}</p>}
              {dep?.owner && (
                <p className="mz-owner">
                  Owner <ExtLink href={addressUrl(dep.owner)}>{short(dep.owner)}</ExtLink>
                </p>
              )}
            </div>

            <dl className="mz-stats">
              <Stat label="BTC price" note="Mezo PriceFeed.fetchPrice()">
                {live ? fmtUsd(fromE18(live.price)) : error ? 'Unavailable' : <span className="mz-skel" />}
              </Stat>
              <Stat label="Policy escrow" note={deployed ? 'LeashMUSD.policyBalance' : undefined}>
                {!deployed ? (
                  <NotDeployed />
                ) : !dep?.policyCommitment ? (
                  <NotDeployed>Policy not set</NotDeployed>
                ) : live?.balance != null ? (
                  <>
                    {fmtMusd(live.balance)} <small>MUSD</small>
                  </>
                ) : (
                  <span className="mz-skel" />
                )}
              </Stat>
              <Stat label="Guard floor" note={deployed ? 'LeashMUSD.minTroveICR' : 'Must be ≥ Mezo’s 110% MCR'}>
                {!deployed ? (
                  <NotDeployed />
                ) : !dep?.policyCommitment ? (
                  <NotDeployed>Policy not set</NotDeployed>
                ) : floor != null ? (
                  floor === BigInt(0) ? (
                    'Off'
                  ) : (
                    fmtPct(floor, 0)
                  )
                ) : (
                  <span className="mz-skel" />
                )}
              </Stat>
            </dl>
          </div>

          <TensionGauge live={live} deployed={deployed} />

          <div className="mz-panel-foot">
            <p>
              {live ? (
                <>
                  Last read at block{' '}
                  <a href={blockUrl(live.block)} target="_blank" rel="noreferrer" className="mono">
                    {live.block.toLocaleString('en-US')}
                  </a>
                  , {live.readAt.toLocaleTimeString()} · refreshes every 15 s
                </>
              ) : (
                'Waiting for the first read…'
              )}
            </p>
            {snapPrice !== null && liqPrice !== null && (
              <p className="mz-derived">
                {tone === 'snap' ? 'Leash slackens again above BTC' : 'Leash snaps below BTC'} <b>{fmtUsd(fromE18(snapPrice), 0)}</b> ·{' '}
                {trove && trove.icr < MCR ? 'back above the MCR at' : 'MCR crossed below'} <b>{fmtUsd(fromE18(liqPrice), 0)}</b>
                <span> (price × line ÷ ICR, at this block)</span>
              </p>
            )}
            {live && (
              <p className="mz-derived">
                MUSD in circulation: <b>{fmtMusd(live.musdSupply)}</b>
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PaymentsFeed({ dep, latestBlock }: { dep: Deployment | null; latestBlock: number | null }) {
  const { items, times, error, scannedTo, fromBlock } = useFeed(dep, latestBlock);
  const deployed = !!dep?.leashMUSD;
  const shown = items.slice(0, 30);
  return (
    <section className="lz-sec lz-paper mz-feed" id="payments" aria-labelledby="pay-h">
      <div className="lz-wrap">
        <div className="mz-sec-head">
          <div>
            <p className="lz-num">PaymentReleased · eth_getLogs</p>
            <h2 className="lz-h2" id="pay-h">
              Every payment the leash let through.
            </h2>
          </div>
          <p className="mz-sec-sub">
            Each row is a <span className="mono">PaymentReleased</span> event: a proof verified on-chain and the
            trove&rsquo;s ICR at that moment. Guard changes are listed too.
          </p>
        </div>

        {!deployed ? (
          <div className="mz-empty">
            <h3>Not deployed on Mezo testnet yet</h3>
            <p>
              Once LeashMUSD is live, the payments it releases appear here, read from the chain with{' '}
              <span className="mono">eth_getLogs</span>. Nothing is shown until then.
            </p>
          </div>
        ) : (
          <>
            {error && (
              <div role="alert" className="mz-alert mz-alert-light">
                Could not read the payment logs: {error}
              </div>
            )}
            {shown.length === 0 ? (
              <div className="mz-empty">
                <h3>{scannedTo === null ? 'Reading the logs…' : 'No payments yet'}</h3>
                <p>
                  {scannedTo === null
                    ? 'Scanning LeashMUSD for PaymentReleased events.'
                    : `No PaymentReleased events from block ${fromBlock?.toLocaleString('en-US')} to ${scannedTo.toLocaleString('en-US')}.`}
                  {dep?.deployBlock == null && scannedTo !== null ? ' deployBlock is not set, so only the last 10,000 blocks were scanned.' : ''}
                </p>
              </div>
            ) : (
              <>
                <ol className="mz-rows" aria-label="LeashMUSD events, newest first">
                  <li className="mz-row mz-row-head" aria-hidden="true">
                    <span>Amount</span>
                    <span>Payee</span>
                    <span>Trove ICR</span>
                    <span>When</span>
                    <span>Tx</span>
                  </li>
                  {shown.map((it) => {
                    const ts = times[it.block];
                    const when = ts ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
                    return it.kind === 'payment' ? (
                      <li key={it.key} className="mz-row">
                        <span className="mz-cell" data-label="Amount">
                          <b>{fmtMusd((it.amountCents ?? BigInt(0)) * CENT_WEI)} MUSD</b>
                          <small>{it.amountCents?.toString()} cents</small>
                        </span>
                        <span className="mz-cell" data-label="Payee">
                          <ExtLink href={addressUrl(it.recipient!)} className="mono">
                            {short(it.recipient!)}
                          </ExtLink>
                        </span>
                        <span className="mz-cell" data-label="Trove ICR">
                          {it.icr === BigInt(0) ? <span className="mz-muted">guard off</span> : it.icr! >= ICR_UNBOUNDED ? 'no debt' : fmtPct(it.icr!)}
                        </span>
                        <span className="mz-cell" data-label="When">
                          {when ?? <span className="mz-muted">block {it.block.toLocaleString('en-US')}</span>}
                          {when && <small>block {it.block.toLocaleString('en-US')}</small>}
                        </span>
                        <span className="mz-cell" data-label="Tx">
                          <ExtLink href={txUrl(it.txHash)} className="mono">
                            {short(it.txHash, 8, 6)}
                          </ExtLink>
                        </span>
                      </li>
                    ) : (
                      <li key={it.key} className="mz-row mz-row-guard">
                        <span className="mz-cell mz-cell-wide" data-label="Guard">
                          <b>Guard floor set to {it.floor === BigInt(0) ? 'off' : fmtPct(it.floor!, 0)}</b>
                          <small>TroveGuardSet · policy {short(it.policyId, 8, 6)}</small>
                        </span>
                        <span className="mz-cell" data-label="When">
                          {when ?? <span className="mz-muted">block {it.block.toLocaleString('en-US')}</span>}
                          {when && <small>block {it.block.toLocaleString('en-US')}</small>}
                        </span>
                        <span className="mz-cell" data-label="Tx">
                          <ExtLink href={txUrl(it.txHash)} className="mono">
                            {short(it.txHash, 8, 6)}
                          </ExtLink>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {scannedTo !== null && (
                  <p className="lz-fine">
                    {items.length} event{items.length === 1 ? '' : 's'} from block {fromBlock?.toLocaleString('en-US')} to{' '}
                    {scannedTo.toLocaleString('en-US')}
                    {items.length > shown.length ? `; the newest ${shown.length} are shown` : ''}.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const STEPS: Array<[string, string]> = [
  ['Borrow MUSD against BTC', 'Open a Mezo Borrow trove with Bitcoin as collateral and mint MUSD, Mezo’s Bitcoin-backed stablecoin.'],
  [
    'Fund the leash',
    'Escrow MUSD in LeashMUSD under a hidden ZK policy (payees, per-payment cap, daily cap), and set a trove guard: the lowest collateral ratio the agent may spend at.',
  ],
  [
    'The agent pays with proofs',
    'Each payment carries an UltraHonk proof verified on-chain. Before releasing MUSD, the contract reads your trove at the live BTC price. Below the guard, it refuses.',
  ],
];

function HowItWorks() {
  return (
    <section className="lz-sec lz-cream" id="how" aria-labelledby="how-h">
      <div className="lz-wrap">
        <h2 className="lz-h2" id="how-h">
          As BTC falls, the leash tightens on its own.
        </h2>
        <ol className="lz-steps">
          {STEPS.map(([title, body], i) => (
            <li key={title}>
              <span className="lz-num">0{i + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
        <p className="lz-fine">
          Amounts in proofs are cents; 1 cent settles as 10<sup>16</sup> MUSD wei. The guard can&rsquo;t be set under
          Mezo&rsquo;s 110% MCR, and the policy&rsquo;s caps and payees never leave the owner&rsquo;s device.
        </p>
      </div>
    </section>
  );
}

function Contracts({ dep, depError }: { dep: Deployment | null; depError: string | null }) {
  const txs = useRecordedTxs(dep);
  const rows: Array<{ name: string; role: string; addr: string | null }> = [
    { name: 'LeashMUSD', role: 'LEASH escrow in MUSD with the trove guard', addr: dep?.leashMUSD ?? null },
    { name: 'LeashVerifier', role: 'UltraHonk verifier for the Noir policy circuit', addr: dep?.verifier ?? null },
    { name: 'MUSD', role: 'Mezo’s Bitcoin-backed stablecoin', addr: MEZO.musd },
    { name: 'TroveManager', role: 'Mezo Borrow troves; the guard reads ICR here', addr: MEZO.troveManager },
    { name: 'PriceFeed', role: 'BTC/USD price the guard uses', addr: MEZO.priceFeed },
    { name: 'BorrowerOperations', role: 'Open a trove and borrow MUSD', addr: MEZO.borrowerOperations },
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
            Mezo&rsquo;s MUSD addresses are from the mezo-org/musd matsnet deployment. The LEASH addresses come from{' '}
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
          {dep?.owner && (
            <li>
              <div>
                <h3>Policy owner</h3>
                <p>Holds the Mezo trove the guard reads</p>
              </div>
              <ExtLink href={addressUrl(dep.owner)} className="mono mz-addr">
                {dep.owner}
              </ExtLink>
            </li>
          )}
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
                      {t.status === 'success'
                        ? `Succeeded in block ${t.block?.toLocaleString('en-US')}`
                        : t.status === 'reverted'
                          ? `Reverted on-chain in block ${t.block?.toLocaleString('en-US')}`
                          : t.status === 'pending'
                            ? 'No receipt yet'
                            : t.status === 'error'
                              ? 'Receipt could not be read'
                              : 'Reading receipt…'}
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
  const [latestBlock, setLatestBlock] = useState<number | null>(null);

  // The feed follows the live panel's block; a cheap separate poll keeps the two components independent.
  useEffect(() => {
    if (!dep?.leashMUSD) return;
    let live = true;
    const tick = () =>
      document.visibilityState === 'visible' &&
      rpc<string>('eth_blockNumber', [])
        .then((b) => live && setLatestBlock(Number(b)))
        .catch(() => {});
    tick();
    const t = setInterval(tick, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [dep]);

  return (
    <>
      <Hero hasHero={hasHero} />
      <LivePanel dep={dep} depError={depError} />
      <PaymentsFeed dep={dep} latestBlock={latestBlock} />
      <HowItWorks />
      <Contracts dep={dep} depError={depError} />
    </>
  );
}
