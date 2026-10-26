import type { Agent, FeedItem } from "../api";
import { ago, centsToMusd, txUrl } from "../format";
import { AgentAvatar } from "./Art";

const VERB: Record<string, string> = {
  queued: "queued",
  proving: "proving",
  opening: "in escrow",
  thinking: "thinking",
  delivering: "delivering",
  delivered: "answered · in dispute window",
  accepting: "being paid",
  paid: "paid",
  disputing: "disputed",
  judging: "arbiter judging",
  clawed_back: "clawed back",
  undelivered: "not delivered · clawback pending",
  releasing: "releasing",
  released: "released",
  failed: "failed",
};

export function Feed({ items, agents, explorer, now, error }: { items: FeedItem[] | null; agents: Agent[]; explorer?: string; now: number; error: string | null }) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  if (error && !items) {
    return (
      <div className="feed feed-msg" role="status">
        Live feed unavailable: {error}
      </div>
    );
  }
  if (!items) return <div className="feed feed-msg">Loading the live feed…</div>;
  if (items.length === 0) return <div className="feed feed-msg">No jobs yet. Yours will be the first on the live feed.</div>;
  const list = [...items].sort((a, b) => b.ts - a.ts);
  const render = (dup: boolean) =>
    list.map((it) => {
      const a = byId.get(it.agentId);
      const tx = it.txs?.resolve || it.txs?.clawback || it.txs?.accept || it.txs?.release || it.txs?.deliver || it.txs?.open;
      const content = (
        <>
          {a && <AgentAvatar id={a.id} style={a.style} size={18} />}
          <b>{a?.name ?? it.agentId}</b> {it.status === "undelivered" || (it.status === "clawed_back" && !it.txs?.deliver) ? "took" : "answered"} {centsToMusd(it.priceCents)} MUSD
          <span className={`feed-status fs-${it.status}`}>· {VERB[it.status] ?? it.status}</span>
          <span className="feed-ago">{ago(it.ts, now)}</span>
        </>
      );
      return (
        <li key={(dup ? "d-" : "") + it.id} aria-hidden={dup || undefined}>
          {tx ? (
            <a href={txUrl(explorer, tx)} target="_blank" rel="noopener noreferrer" tabIndex={dup ? -1 : undefined}>
              {content}
            </a>
          ) : (
            <span>{content}</span>
          )}
        </li>
      );
    });
  return (
    <div className="feed" aria-label="Live jobs across the hub">
      <span className="feed-label">
        <span className="live-dot" aria-hidden="true" /> Live
      </span>
      <div className="feed-track">
        <ul className={`feed-run${list.length > 3 ? " is-moving" : ""}`} style={{ animationDuration: `${Math.max(30, list.length * 6)}s` }}>
          {render(false)}
          {list.length > 3 && render(true)}
        </ul>
      </div>
    </div>
  );
}
