import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, ApiError, TERMINAL, api, errorText, type Agent, type FeedItem, type HubInfo, type HubRequest } from "./api";
import { centsToMusd, formatWei } from "./format";
import { flyCoins, prefersReducedMotion } from "./fx";
import { AgentAvatar } from "./components/Art";
import { Chat } from "./components/Chat";
import { Feed } from "./components/Feed";
import { Receipt } from "./components/Receipt";
import { AgentSwitcher, Roster } from "./components/Roster";
import { StatusPill } from "./components/StatusPill";
import { TopBar } from "./components/TopBar";

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

let memorySession: string | null = null;
function getSessionId(): string {
  const existing = store("leash-hub-session");
  if (existing) return existing;
  const id = memorySession ?? (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  memorySession = id;
  return store("leash-hub-session", id) ?? id;
}

function slashPerJob(hub: HubInfo | null): string | null {
  if (!hub) return null;
  if (hub.slashWei) return formatWei(hub.slashWei, 4);
  // The contract's slashAmount is a constant, so slashed total / clawbacks is the per-job slash.
  try {
    const n = BigInt(hub.stats.clawedBack || 0);
    if (n > 0n) return formatWei((BigInt(hub.stats.mezoSlashedWei) / n).toString(), 4);
  } catch {
    /* fall through */
  }
  return null;
}

export function Hub() {
  const sessionId = useMemo(getSessionId, []);
  const [hub, setHub] = useState<HubInfo | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [stale, setStale] = useState<string | null>(null);
  const [reqs, setReqs] = useState<Record<string, HubRequest>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(() => store("leash-hub-agent"));
  const [selectedByAgent, setSelectedByAgent] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pulse, setPulse] = useState(0);
  const [fxHold, setFxHold] = useState(0);
  const [slashedFlash, setSlashedFlash] = useState<{ agentId: string; label: string; key: number } | null>(null);
  const reqsRef = useRef(reqs);
  reqsRef.current = reqs;
  const hubRef = useRef(hub);
  hubRef.current = hub;
  const inflight = useRef(new Set<string>());
  const sheetClose = useRef<HTMLButtonElement>(null);
  const sheetOpener = useRef<HTMLButtonElement>(null);

  const clawbackFx = useCallback((r: HubRequest) => {
    const label = slashPerJob(hubRef.current);
    setSlashedFlash({ agentId: r.agentId, label: label ?? "bond", key: Date.now() });
    if (prefersReducedMotion()) {
      setPulse((p) => p + 1);
      return;
    }
    setFxHold((h) => h + r.priceCents);
    window.setTimeout(() => {
      const src =
        document.querySelector(`[data-fx-src="${CSS.escape(r.id)}"] .bubble-avatar`) ||
        document.querySelector(`[data-agent-card="${CSS.escape(r.agentId)}"] .agent-avatar-wrap`);
      const target = document.getElementById("fx-refund-target");
      void flyCoins(src, target).then(() => {
        setFxHold((h) => Math.max(0, h - r.priceCents));
        setPulse((p) => p + 1);
      });
    }, 420);
  }, []);

  const upsert = useCallback(
    (r: HubRequest, opts: { fx?: boolean } = { fx: true }) => {
      const prev = reqsRef.current[r.id];
      if (opts.fx && prev && prev.status !== "clawed_back" && r.status === "clawed_back") clawbackFx(r);
      setReqs((m) => ({ ...m, [r.id]: r }));
      setOrder((o) => (o.includes(r.id) ? o : [...o, r.id]));
    },
    [clawbackFx],
  );

  const boot = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      const [h, a] = await Promise.all([api.hub(), api.agents()]);
      setHub(h);
      setAgents(a);
      const mine = await api.session(sessionId);
      const map: Record<string, HubRequest> = {};
      for (const r of mine) map[r.id] = r;
      setReqs(map);
      setOrder(mine.map((r) => r.id));
    } catch (e) {
      setBootError(e instanceof ApiError && e.unreachable ? e.message : `${errorText(e)} (${API_BASE})`);
    } finally {
      setBooting(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Hub totals, agents and the live feed every 4 s.
  useEffect(() => {
    if (!hub) return;
    let alive = true;
    const tick = async () => {
      const [h, a, f] = await Promise.allSettled([api.hub(), api.agents(), api.feed()]);
      if (!alive) return;
      if (h.status === "fulfilled") setHub(h.value);
      if (a.status === "fulfilled") setAgents(a.value);
      if (f.status === "fulfilled") {
        setFeed(f.value);
        setFeedError(null);
      } else setFeedError(errorText(f.reason));
      const failed = [h, a].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
      setStale(failed ? errorText(failed.reason) : null);
    };
    void tick();
    const t = window.setInterval(tick, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [!!hub]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clock + 1 s polling for every request that is not terminal.
  useEffect(() => {
    const t = window.setInterval(() => {
      setNow(Date.now() / 1000);
      for (const r of Object.values(reqsRef.current)) {
        if (TERMINAL.has(r.status) || inflight.current.has(r.id)) continue;
        inflight.current.add(r.id);
        api
          .request(r.id)
          .then((next) => upsert(next))
          .catch((e) => {
            if (e instanceof ApiError && e.status === 404) setActionErrors((m) => ({ ...m, [r.id]: "The hub no longer knows this request (404)." }));
          })
          .finally(() => inflight.current.delete(r.id));
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [upsert]);

  const agent = useMemo(() => {
    if (!agents || agents.length === 0) return undefined;
    return agents.find((a) => a.id === agentId) ?? agents[0];
  }, [agents, agentId]);

  const pickAgent = (id: string) => {
    setAgentId(id);
    store("leash-hub-agent", id);
    setSendError(null);
  };

  const all = order.map((id) => reqs[id]).filter(Boolean);
  const thread = agent ? all.filter((r) => r.agentId === agent.id) : [];
  const selectedId = (agent && selectedByAgent[agent.id] && reqs[selectedByAgent[agent.id]] ? selectedByAgent[agent.id] : thread[thread.length - 1]?.id) ?? null;
  const selectedReq = selectedId ? reqs[selectedId] : undefined;

  const refundedCents = all.filter((r) => r.status === "clawed_back").reduce((s, r) => s + r.priceCents, 0);
  const spentCents = all.filter((r) => r.txs?.open).reduce((s, r) => s + r.priceCents, 0);
  const slashLabel = slashPerJob(hub);

  const onSend = async (text: string): Promise<boolean> => {
    if (!agent) return false;
    setSending(true);
    setSendError(null);
    try {
      const { requestId } = await api.chat(agent.id, text, sessionId);
      const placeholder: HubRequest = {
        id: requestId,
        sessionId,
        agentId: agent.id,
        message: text,
        status: "proving",
        jobId: null,
        priceCents: agent.priceCents,
        answer: null,
        resultHash: null,
        deadline: null,
        deliveredAt: null,
        disputeUntil: null,
        verdict: null,
        txs: {},
        error: null,
      };
      upsert(placeholder, { fx: false });
      setSelectedByAgent((m) => ({ ...m, [agent.id]: requestId }));
      api.request(requestId).then((r) => upsert(r)).catch(() => undefined);
      return true;
    } catch (e) {
      setSendError(errorText(e));
      return false;
    } finally {
      setSending(false);
    }
  };

  const act = async (id: string, fn: () => Promise<HubRequest>) => {
    setBusy((m) => ({ ...m, [id]: true }));
    setActionErrors((m) => {
      const n = { ...m };
      delete n[id];
      return n;
    });
    try {
      upsert(await fn());
    } catch (e) {
      setActionErrors((m) => ({ ...m, [id]: errorText(e) }));
    } finally {
      setBusy((m) => ({ ...m, [id]: false }));
    }
  };

  useEffect(() => {
    if (!sheetOpen) return;
    sheetClose.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const opener = sheetOpener.current;
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [sheetOpen]);

  const topbar = <TopBar hub={hub} refundedLabel={centsToMusd(Math.max(0, refundedCents - fxHold))} spentLabel={centsToMusd(spentCents)} pulse={pulse} />;

  if (bootError) {
    return (
      <div className="app">
        {topbar}
        <main className="state-page">
          <div className="state-card state-error" role="alert">
            <p className="eyebrow">Hub API unreachable</p>
            <h1>We can't reach the LEASH Hub API</h1>
            <p>
              Tried <code>{API_BASE}</code>
            </p>
            <p className="muted">{bootError}</p>
            <p className="muted">Nothing below is simulated: the hub shows only what the API and Mezo testnet return. Start the hub API, or set VITE_HUB_API, then retry.</p>
            <div className="state-actions">
              <button className="btn btn-primary" type="button" onClick={() => void boot()}>
                Retry
              </button>
              <a className="btn btn-ghost" href="#/">
                Back to the intro
              </a>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (booting || !agents) {
    return (
      <div className="app">
        {topbar}
        <main className="shell" aria-busy="true">
          <div className="roster skeleton-col">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skel skel-card" />
            ))}
          </div>
          <div className="center">
            <div className="state-inline">
              <span className="spinner" aria-hidden="true" /> Connecting to the hub at <code>{API_BASE}</code>…
            </div>
          </div>
          <div className="receipt-pane">
            <div className="skel skel-receipt" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      {topbar}
      <Feed items={feed} agents={agents} explorer={hub?.explorer} now={now} error={feedError} />
      {stale && (
        <p className="stale" role="status">
          Live updates paused: {stale}. Showing the last data the hub returned.
        </p>
      )}
      {agents.length === 0 || !agent ? (
        <main className="state-page">
          <div className="state-card">
            <p className="eyebrow">No agents</p>
            <h1>No agents are registered on this hub yet</h1>
            <p className="muted">The hub at {API_BASE} returned an empty roster.</p>
          </div>
        </main>
      ) : (
        <main className="shell">
          <Roster agents={agents} selected={agent.id} onSelect={pickAgent} slashedFlash={slashedFlash} />
          <div className="center">
            <div className="chat-head">
              <div className="chat-head-agent">
                <AgentAvatar id={agent.id} style={agent.style} size={36} />
                <div>
                  <p className="chat-head-name">{agent.name}</p>
                  <p className="chat-head-sub mono">
                    {agent.model} · {centsToMusd(agent.priceCents)} MUSD/msg · {formatWei(agent.bondWei, 0)} MEZO bond
                  </p>
                </div>
              </div>
            </div>
            <div className="mobile-bar">
              <AgentSwitcher agents={agents} selected={agent.id} onSelect={pickAgent} />
              <button ref={sheetOpener} type="button" className="sheet-toggle" onClick={() => setSheetOpen(true)} disabled={!selectedReq} aria-haspopup="dialog">
                <span>Receipt</span>
                {selectedReq ? <StatusPill status={selectedReq.status} /> : <span className="muted">none</span>}
              </button>
            </div>
            <Chat
              key={agent.id}
              agent={agent}
              hub={hub}
              requests={thread}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedByAgent((m) => ({ ...m, [agent.id]: id }));
                if (window.matchMedia("(max-width: 899px)").matches) setSheetOpen(true);
              }}
              onSend={onSend}
              onAccept={(id) => void act(id, () => api.accept(id, sessionId))}
              onDispute={(id, reason) => void act(id, () => api.dispute(id, reason, sessionId))}
              now={now}
              slashLabel={slashLabel}
              sending={sending}
              sendError={sendError}
              actionErrors={actionErrors}
              busy={busy}
            />
          </div>
          <aside className="receipt-pane" aria-label="Escrow receipt">
            <Receipt hub={hub} agent={agent} req={selectedReq} now={now} slashLabel={slashLabel} />
          </aside>
        </main>
      )}
      {sheetOpen && agent && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Escrow receipt" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" aria-hidden="true" />
            <button ref={sheetClose} type="button" className="sheet-close" onClick={() => setSheetOpen(false)}>
              Close
            </button>
            <Receipt hub={hub} agent={agent} req={selectedReq} now={now} slashLabel={slashLabel} />
          </div>
        </div>
      )}
    </div>
  );
}
