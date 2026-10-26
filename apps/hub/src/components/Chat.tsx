import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Agent, HubInfo, HubRequest } from "../api";
import { addrUrl, centsToMusd, clock, formatWei, shortHex, txUrl } from "../format";
import { Markdown } from "../markdown";
import { AgentAvatar, CoinGlyph } from "./Art";

const MAX = 500;

const SUGGESTIONS: Record<string, string[]> = {
  accurate: ["What is the boiling point of water at the top of Everest?", "Explain what MUSD is on Mezo in two sentences.", "Who proved Fermat's Last Theorem, and when?"],
  code: ["Write a TypeScript function that checks if a string is a palindrome.", "Give me a regex for an EVM address, with a test.", "What's the difference between call and delegatecall?"],
  cheap: ["What's 17 × 23?", "How many moons does Mars have?", "What year did the Berlin Wall fall?"],
};

const PENDING_LABEL: Record<string, string> = {
  queued: "Queued for the relayer",
  proving: "Generating the spend proof",
  opening: "Paying into escrow on Mezo",
  thinking: "Thinking",
  delivering: "Committing the answer hash on chain",
};

export function Chat({
  agent,
  hub,
  requests,
  selectedId,
  onSelect,
  onSend,
  onAccept,
  onDispute,
  now,
  slashLabel,
  sending,
  sendError,
  actionErrors,
  busy,
}: {
  agent: Agent;
  hub: HubInfo | null;
  requests: HubRequest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSend: (text: string) => Promise<boolean>;
  onAccept: (id: string) => void;
  onDispute: (id: string, reason: string) => void;
  now: number;
  slashLabel: string | null;
  sending: boolean;
  sendError: string | null;
  actionErrors: Record<string, string>;
  busy: Record<string, boolean>;
}) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const lastCount = useRef(0);
  const lastStatus = requests.length ? requests[requests.length - 1].status : "";

  useEffect(() => {
    const el = scroller.current;
    if (!el || requests.length === 0) return;
    const grew = requests.length !== lastCount.current;
    lastCount.current = requests.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (grew || nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: grew ? "auto" : "smooth" });
  }, [requests.length, lastStatus, agent.id]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || sending || text.length > MAX) return;
    const ok = await onSend(text);
    if (ok) setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <section className="chat" aria-label={`Chat with ${agent.name}`}>
      <div className="chat-scroll" ref={scroller}>
        {requests.length === 0 ? (
          <div className="chat-intro">
            <AgentAvatar id={agent.id} style={agent.style} size={72} />
            <h2>{agent.name}</h2>
            <p className="chat-intro-tag">{agent.tagline}</p>
            <p className="muted chat-intro-desc">{agent.description}</p>
            <dl className="intro-facts">
              <div>
                <dt>Per message</dt>
                <dd>{centsToMusd(agent.priceCents)} MUSD</dd>
              </div>
              <div>
                <dt>Bond</dt>
                <dd>{formatWei(agent.bondWei)} MEZO</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{agent.model}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>
                  <a href={addrUrl(hub?.explorer, agent.address)} target="_blank" rel="noopener noreferrer">
                    {shortHex(agent.address)}
                  </a>
                </dd>
              </div>
            </dl>
            <p className="eyebrow">Try asking</p>
            <div className="suggestions">
              {(SUGGESTIONS[agent.style] ?? SUGGESTIONS.accurate).map((s) => (
                <button key={s} type="button" className="suggestion" onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="thread">
            {requests.map((r) => (
              <Turn
                key={r.id}
                r={r}
                agent={agent}
                hub={hub}
                selected={r.id === selectedId}
                onSelect={() => onSelect(r.id)}
                onAccept={() => onAccept(r.id)}
                onDispute={(reason) => onDispute(r.id, reason)}
                now={now}
                slashLabel={slashLabel}
                error={actionErrors[r.id]}
                busy={!!busy[r.id]}
              />
            ))}
          </ol>
        )}
      </div>
      <form className="composer" onSubmit={submit}>
        {sendError && (
          <p className="composer-error" role="alert">
            {sendError}
          </p>
        )}
        <label htmlFor={inputId} className="sr-only">
          Message {agent.name}
        </label>
        <div className="composer-box">
          <textarea
            id={inputId}
            value={draft}
            maxLength={MAX}
            rows={1}
            placeholder={`Ask ${agent.name}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <button type="submit" className="send" disabled={sending || !draft.trim()}>
            {sending ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <CoinGlyph size={16} />
            )}
            <span>{sending ? "Sending" : `Pay ${centsToMusd(agent.priceCents)} MUSD`}</span>
          </button>
        </div>
        <p className="composer-hint">
          <span>Enter sends · Shift+Enter for a new line</span>
          {hub?.policy && (
            <span className="policy-use" title="Your LEASH spending policy. The ZK proof for each job shows it stays within these limits.">
              <span className="policy-bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (hub.policy.spentTodayCents / Math.max(1, hub.policy.dailyCapCents)) * 100)}%` }} />
              </span>
              <span className="mono">
                {centsToMusd(hub.policy.spentTodayCents)}/{centsToMusd(hub.policy.dailyCapCents)} MUSD today · ZK cap
              </span>
            </span>
          )}
          <span className={draft.length > MAX - 50 ? "count warn" : "count"}>
            {draft.length}/{MAX}
          </span>
        </p>
      </form>
    </section>
  );
}

const REASONS = ["The answer is factually wrong", "It didn't answer the question", "The code doesn't work"];

function Turn({
  r,
  agent,
  hub,
  selected,
  onSelect,
  onAccept,
  onDispute,
  now,
  slashLabel,
  error,
  busy,
}: {
  r: HubRequest;
  agent: Agent;
  hub: HubInfo | null;
  selected: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onDispute: (reason: string) => void;
  now: number;
  slashLabel: string | null;
  error?: string;
  busy: boolean;
}) {
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (disputing) reasonRef.current?.focus();
  }, [disputing]);

  const pending = r.status in PENDING_LABEL;
  const left = r.disputeUntil ? r.disputeUntil - now : null;
  const windowOpen = r.status === "delivered" && (left === null || left > 0);
  const total = hub?.disputeWindowSec || 0;
  const frac = left !== null && total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;

  return (
    <li className={`turn${selected ? " is-selected" : ""}`}>
      <div className="bubble-user">
        <p>{r.message}</p>
        <span className="bubble-meta mono">{centsToMusd(r.priceCents)} MUSD</span>
      </div>
      <div className={`bubble-agent status-${r.status}`} data-fx-src={r.id}>
        <span className="bubble-avatar">
          <AgentAvatar id={agent.id} style={agent.style} size={34} />
        </span>
        <div className="bubble-card">
          <button type="button" className="receipt-btn" onClick={onSelect} aria-pressed={selected}>
            {selected ? "Showing receipt" : "View receipt"}
            {r.jobId !== null && r.jobId !== undefined && <span className="mono"> · job #{r.jobId}</span>}
          </button>
          {pending && (
            <div className="thinking" role="status">
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {PENDING_LABEL[r.status]}…
            </div>
          )}
          {r.status === "failed" && (
            <div className="bubble-error" role="alert">
              <strong>This job failed.</strong> {r.error || "The hub reported a failure without details."}
              {!r.txs?.open && <span className="muted"> No MUSD left your policy.</span>}
            </div>
          )}
          {r.status === "undelivered" && (
            <div className="bubble-error" role="status">
              <strong>The agent never delivered.</strong> Your {centsToMusd(r.priceCents)} MUSD stays in escrow and is clawed back automatically
              {r.deadline ? (r.deadline - now > 0 ? <> in <span className="mono">{clock(r.deadline - now)}</span>, at the deadline.</> : <>: the deadline passed, clawback is on its way.</>) : <> after the deadline.</>}
            </div>
          )}
          {r.answer && <Markdown text={r.answer} />}

          {r.status === "clawed_back" && (
            <div className="stamp-wrap">
              <div className="stamp" role="status">
                <span className="stamp-top">Clawed back</span>
                <span className="stamp-main">
                  {centsToMusd(r.priceCents)} MUSD returned{slashLabel ? ` · ${slashLabel} MEZO slashed` : " · bond slashed"}
                </span>
              </div>
              {r.verdict?.reason && (
                <p className="arbiter-reason">
                  <span className="eyebrow">Arbiter</span> {r.verdict.reason}
                </p>
              )}
              {(r.txs?.resolve || r.txs?.clawback) && (
                <a className="tx-link" href={txUrl(hub?.explorer, (r.txs.resolve || r.txs.clawback) as string)} target="_blank" rel="noopener noreferrer">
                  Clawback tx {shortHex(r.txs.resolve || r.txs.clawback, 8, 6)} ↗
                </a>
              )}
            </div>
          )}

          <div className="actions">
            {windowOpen && !disputing && (
              <>
                <button type="button" className="btn btn-good" onClick={onAccept} disabled={busy}>
                  Looks good, pay
                </button>
                <button type="button" className="btn btn-bad" onClick={() => setDisputing(true)} disabled={busy}>
                  Wrong, refund me
                </button>
                {left !== null && (
                  <span className="countdown" title="Time left to dispute">
                    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                      <circle cx="10" cy="10" r="8" className="cd-track" />
                      <circle cx="10" cy="10" r="8" className="cd-fill" style={{ strokeDashoffset: `${50.27 * (1 - frac)}` }} />
                    </svg>
                    <span className="mono">{clock(left)}</span>
                    <span className="sr-only"> left to dispute</span>
                  </span>
                )}
              </>
            )}
            {r.status === "delivered" && !windowOpen && <span className="settle settle-good">Dispute window closed · releasing to the agent</span>}
            {r.status === "accepting" && <span className="settle">Paying the agent on Mezo…</span>}
            {r.status === "releasing" && <span className="settle">Releasing to the agent on Mezo…</span>}
            {r.status === "paid" && !r.verdict && (
              <span className="settle settle-good">
                Paid to agent · {centsToMusd(r.priceCents)} MUSD
                {r.txs?.accept && (
                  <a className="tx-link" href={txUrl(hub?.explorer, r.txs.accept)} target="_blank" rel="noopener noreferrer">
                    tx ↗
                  </a>
                )}
              </span>
            )}
            {r.status === "disputing" && <span className="settle">Filing the dispute on Mezo…</span>}
            {r.status === "judging" && (
              <span className="settle settle-judging">
                <span className="scale" aria-hidden="true">⚖</span> AI arbiter is judging…
              </span>
            )}
            {(r.status === "released" || (r.status === "paid" && r.verdict)) && (
              <span className="settle settle-good">
                {r.verdict && !r.verdict.refund ? (
                  <span>
                    Arbiter sided with the agent: <span className="settle-reason">{r.verdict.reason}</span>
                  </span>
                ) : (
                  "Released to the agent"
                )}
                {(r.txs?.release || r.txs?.resolve) && (
                  <a className="tx-link" href={txUrl(hub?.explorer, (r.txs.release || r.txs.resolve) as string)} target="_blank" rel="noopener noreferrer">
                    tx ↗
                  </a>
                )}
              </span>
            )}
          </div>

          {disputing && windowOpen && (
            <form
              className="dispute"
              onSubmit={(e) => {
                e.preventDefault();
                if (!reason.trim()) return;
                onDispute(reason.trim());
                setDisputing(false);
              }}
            >
              <label className="eyebrow" htmlFor={`reason-${r.id}`}>
                Tell the arbiter what's wrong
              </label>
              <div className="reason-chips">
                {REASONS.map((x) => (
                  <button type="button" key={x} className={`chip-btn${reason === x ? " on" : ""}`} onClick={() => setReason(x)}>
                    {x}
                  </button>
                ))}
              </div>
              <textarea
                id={`reason-${r.id}`}
                ref={reasonRef}
                value={reason}
                maxLength={300}
                rows={2}
                placeholder="e.g. Mars has two moons, not three."
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setDisputing(false);
                }}
              />
              <div className="dispute-actions">
                <button type="submit" className="btn btn-bad" disabled={!reason.trim() || busy}>
                  Send to the arbiter
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setDisputing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {error && (
            <p className="action-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
