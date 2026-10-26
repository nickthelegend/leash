import type { Agent, HubInfo, HubRequest } from "../api";
import { addrUrl, centsToMusd, clock, formatWei, shortHex, timeOfDay, txUrl } from "../format";
import { AgentAvatar } from "./Art";
import { StatusPill } from "./StatusPill";

type StepState = "done" | "active" | "pending" | "error";
interface Step {
  key: string;
  title: string;
  detail?: string;
  tx?: string;
  state: StepState;
  tone?: "good" | "bad";
}

const LINEAR_INDEX: Record<string, number> = { queued: 0, proving: 0, opening: 1, thinking: 2, delivering: 3 };

export function buildSteps(r: HubRequest, now: number, slashLabel: string | null): Step[] {
  const s = r.status;
  const t = r.txs || {};
  let reached: number;
  if (s in LINEAR_INDEX) reached = LINEAR_INDEX[s];
  else if (s === "failed") reached = t.deliver ? 4 : t.open ? 2 : 0;
  else reached = 4;
  const failedHere = (i: number) => s === "failed" && reached === i;
  const st = (i: number): StepState => (failedHere(i) ? "error" : reached > i ? "done" : reached === i ? "active" : "pending");

  const neverDelivered = (s === "undelivered" || s === "clawed_back") && !t.deliver && !r.answer;
  if (neverDelivered) {
    const left = r.deadline ? r.deadline - now : null;
    return [
      { key: "proving", title: "Proving", detail: "ZK proof that this spend fits the LEASH policy", state: "done" },
      { key: "open", title: "Paid into escrow", detail: `${centsToMusd(r.priceCents)} MUSD locked in the Mezo escrow`, tx: t.open, state: "done" },
      { key: "thinking", title: "Agent never delivered", detail: "No answer before the delivery deadline", state: "error" },
      {
        key: "clawback",
        title: "Clawed back + MEZO slashed",
        detail:
          s === "clawed_back"
            ? `${centsToMusd(r.priceCents)} MUSD returned to you${slashLabel ? ` · ${slashLabel} MEZO slashed` : " · bond slashed"}`
            : left !== null && left > 0
              ? `Anyone can claw it back after the deadline, in ${clock(left)}`
              : "Deadline passed, clawback on its way",
        tx: t.clawback || t.resolve,
        state: s === "clawed_back" ? "done" : "active",
        tone: "bad",
      },
    ];
  }
  const steps: Step[] = [
    { key: "proving", title: s === "queued" ? "Queued" : "Proving", detail: s === "queued" ? "Waiting for the relayer" : "ZK proof that this spend fits the LEASH policy", state: st(0) },
    { key: "open", title: "Paid into escrow", detail: `${centsToMusd(r.priceCents)} MUSD locked in the Mezo escrow`, tx: t.open, state: st(1) },
    { key: "thinking", title: "Agent thinking", detail: "The agent works on your message off chain", state: st(2) },
    {
      key: "deliver",
      title: "Delivered",
      detail: r.resultHash ? `Result hash ${shortHex(r.resultHash, 10, 6)} committed on chain` : "Answer hash gets committed on chain",
      tx: t.deliver,
      state: st(3),
    },
  ];
  if (s === "failed" && reached === 4) steps.push({ key: "fail", title: "Failed", detail: r.error || "The request failed", state: "error" });
  if (s === "failed") {
    const idx = steps.findIndex((x) => x.state === "error");
    if (idx >= 0 && r.error) steps[idx].detail = r.error;
    return steps;
  }
  if (reached < 4) return steps;

  const disputed = !!t.dispute || s === "disputing" || s === "judging" || s === "clawed_back" || !!r.verdict;
  if (disputed) {
    steps.push({ key: "dispute", title: "Disputed", detail: "You flagged the answer as wrong", tx: t.dispute, state: s === "disputing" ? "active" : "done" });
    const judged = !!r.verdict || s === "clawed_back" || s === "released" || s === "releasing" || s === "paid";
    steps.push({
      key: "judge",
      title: "AI arbiter judging",
      detail: r.verdict ? `“${r.verdict.reason}”` : judged ? "Ruled" : "Reading your message, the answer and your reason",
      state: judged ? "done" : s === "judging" ? "active" : "pending",
    });
    if ((r.verdict && !r.verdict.refund) || s === "released" || s === "releasing" || s === "paid") {
      steps.push({
        key: "resolve",
        title: "Arbiter sided with the agent",
        detail: `${centsToMusd(r.priceCents)} MUSD paid to the agent`,
        tx: t.resolve || t.release,
        state: s === "paid" || s === "released" ? "done" : "active",
        tone: "good",
      });
    } else {
      steps.push({
        key: "clawback",
        title: "Clawed back + MEZO slashed",
        detail: `${centsToMusd(r.priceCents)} MUSD returned to you${slashLabel ? ` · ${slashLabel} MEZO slashed from the agent's bond` : " · agent's MEZO bond slashed"}`,
        tx: t.resolve || t.clawback,
        state: s === "clawed_back" ? "done" : "pending",
        tone: "bad",
      });
    }
    return steps;
  }
  if (s === "accepting" || s === "paid" || t.accept) {
    steps.push({ key: "accept", title: "Accepted", detail: "You approved the answer", tx: t.accept, state: s === "accepting" ? "active" : "done" });
    steps.push({ key: "paid", title: "Paid to agent", detail: `${centsToMusd(r.priceCents)} MUSD released from escrow`, tx: t.accept, state: s === "paid" ? "done" : "pending", tone: "good" });
    return steps;
  }
  if (s === "releasing" || s === "released") {
    steps.push({ key: "release", title: "Released after the dispute window", detail: `${centsToMusd(r.priceCents)} MUSD paid to the agent`, tx: t.release, state: s === "released" ? "done" : "active", tone: "good" });
    return steps;
  }
  // delivered: waiting for the user
  const left = r.disputeUntil ? r.disputeUntil - now : null;
  steps.push({
    key: "decide",
    title: left !== null && left <= 0 ? "Dispute window closed" : "Your call",
    detail:
      left !== null && left > 0
        ? `Accept, or dispute within ${clock(left)}`
        : left !== null
          ? "Releasing to the agent"
          : "Accept or dispute the answer",
    state: "active",
  });
  steps.push({ key: "outcome", title: "Paid to agent, or clawed back to you", state: "pending" });
  return steps;
}

export function Receipt({
  hub,
  agent,
  req,
  now,
  slashLabel,
}: {
  hub: HubInfo | null;
  agent: Agent | undefined;
  req: HubRequest | undefined;
  now: number;
  slashLabel: string | null;
}) {
  const explorer = hub?.explorer;
  if (!req) {
    return (
      <div className="receipt receipt-empty">
        <div className="receipt-paper">
          <p className="eyebrow">Escrow receipt</p>
          <h2 className="receipt-empty-title">Nothing in escrow yet</h2>
          <p className="muted">
            Send a message and its job opens here: the proof, the MUSD locked in escrow on Mezo, the delivery, and how it settles. Every step links to its
            transaction on the Mezo explorer.
          </p>
          <ol className="ghost-steps" aria-hidden="true">
            <li>Proving</li>
            <li>Paid into escrow</li>
            <li>Agent thinking</li>
            <li>Delivered</li>
            <li>Paid, or clawed back</li>
          </ol>
        </div>
        {hub && <ContractFoot hub={hub} />}
      </div>
    );
  }
  const steps = buildSteps(req, now, slashLabel);
  return (
    <div className="receipt">
      <div className="receipt-paper" aria-live="polite">
        <div className="receipt-head">
          <div>
            <p className="eyebrow">Escrow receipt</p>
            <h2 className="receipt-title">{req.jobId !== null && req.jobId !== undefined ? `Job #${req.jobId}` : "Job pending"}</h2>
          </div>
          <StatusPill status={req.status} />
        </div>
        <dl className="receipt-meta">
          <div>
            <dt>Agent</dt>
            <dd className="receipt-agent">
              {agent && <AgentAvatar id={agent.id} style={agent.style} size={18} />}
              {agent?.name ?? req.agentId}
            </dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd className="mono">{centsToMusd(req.priceCents)} MUSD</dd>
          </div>
          {req.deliveredAt ? (
            <div>
              <dt>Delivered</dt>
              <dd className="mono">{timeOfDay(req.deliveredAt)}</dd>
            </div>
          ) : req.deadline ? (
            <div>
              <dt>Deadline</dt>
              <dd className="mono">{timeOfDay(req.deadline)}</dd>
            </div>
          ) : null}
        </dl>
        <p className="receipt-prompt">“{req.message.length > 140 ? req.message.slice(0, 140) + "…" : req.message}”</p>
        <div className="perf" aria-hidden="true" />
        <ol className="timeline">
          {steps.map((step) => (
            <li key={step.key} className={`tl tl-${step.state}${step.tone ? ` tl-${step.tone}` : ""}`}>
              <span className="tl-dot" aria-hidden="true">
                {step.state === "done" ? (
                  <svg viewBox="0 0 12 12" width="10" height="10">
                    <path d="M2.5 6.2 L5 8.5 L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : step.state === "error" ? (
                  "!"
                ) : null}
              </span>
              <div className="tl-body">
                <p className="tl-title">
                  {step.title}
                  <span className="sr-only"> ({step.state === "active" ? "in progress" : step.state})</span>
                </p>
                {step.detail && <p className="tl-detail">{step.detail}</p>}
                {step.tx && (
                  <a className="tx-link" href={txUrl(explorer, step.tx)} target="_blank" rel="noopener noreferrer">
                    tx {shortHex(step.tx, 8, 6)} <span aria-hidden="true">↗</span>
                    <span className="sr-only"> (opens the Mezo explorer)</span>
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
      {hub && <ContractFoot hub={hub} />}
    </div>
  );
}

function ContractFoot({ hub }: { hub: HubInfo }) {
  return (
    <dl className="contract-foot">
      <div>
        <dt>Escrow contract</dt>
        <dd>
          <a href={addrUrl(hub.explorer, hub.contract)} target="_blank" rel="noopener noreferrer">
            {shortHex(hub.contract)}
          </a>
        </dd>
      </div>
      <div>
        <dt>Policy</dt>
        <dd title={hub.policyCommitment}>{shortHex(hub.policyCommitment, 8, 4)}</dd>
      </div>
      <div>
        <dt>Window</dt>
        <dd>{clock(hub.disputeWindowSec)}</dd>
      </div>
      <div>
        <dt>Chain</dt>
        <dd>{hub.chainId}</dd>
      </div>
      {hub.policy && (
        <div className="cf-wide">
          <dt>Daily cap · enforced by the ZK proof</dt>
          <dd>
            {centsToMusd(hub.policy.spentTodayCents)} of {centsToMusd(hub.policy.dailyCapCents)} MUSD today · max {centsToMusd(hub.policy.maxPerJobCents)} per job
          </dd>
          <span className="cap-bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, (hub.policy.spentTodayCents / Math.max(1, hub.policy.dailyCapCents)) * 100)}%` }} />
          </span>
        </div>
      )}
      <div>
        <dt>Slashed so far</dt>
        <dd>{formatWei(hub.stats.mezoSlashedWei)} MEZO</dd>
      </div>
    </dl>
  );
}
