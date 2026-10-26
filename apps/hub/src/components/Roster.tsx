import type { Agent } from "../api";
import { centsToMusd, formatWei } from "../format";
import { AgentAvatar } from "./Art";

export function Roster({ agents, selected, onSelect, slashedFlash }: { agents: Agent[]; selected: string | null; onSelect: (id: string) => void; slashedFlash: { agentId: string; label: string; key: number } | null }) {
  return (
    <nav className="roster" aria-label="Agents">
      <p className="eyebrow roster-head">
        Agents <span className="count-badge">{agents.length}</span>
      </p>
      <ul>
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" className={`agent-card${selected === a.id ? " on" : ""}`} aria-current={selected === a.id ? "true" : undefined} onClick={() => onSelect(a.id)} data-agent-card={a.id}>
              <span className="agent-avatar-wrap">
                <AgentAvatar id={a.id} style={a.style} size={44} />
              </span>
              <span className="agent-main">
                <span className="agent-name">{a.name}</span>
                <span className="agent-tag">{a.tagline}</span>
                <span className="agent-nums">
                  <span className="price">
                    <b>{centsToMusd(a.priceCents)}</b> MUSD/msg
                  </span>
                  <span className="bond">{formatWei(a.bondWei, 0)} MEZO bond</span>
                </span>
                <span className="agent-stats">
                  <span className="st-paid">
                    <i aria-hidden="true" />
                    {a.stats.paid} paid
                  </span>
                  <span className="st-claw">
                    <i aria-hidden="true" />
                    {a.stats.clawedBack} clawed back
                  </span>
                </span>
              </span>
              {slashedFlash && slashedFlash.agentId === a.id && (
                <span key={slashedFlash.key} className="slash-float" aria-hidden="true">
                  −{slashedFlash.label} MEZO
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AgentSwitcher({ agents, selected, onSelect }: { agents: Agent[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="switcher" role="tablist" aria-label="Choose an agent">
      {agents.map((a) => (
        <button key={a.id} type="button" role="tab" aria-selected={selected === a.id} className={`switch${selected === a.id ? " on" : ""}`} onClick={() => onSelect(a.id)}>
          <AgentAvatar id={a.id} style={a.style} size={24} />
          <span>{a.name}</span>
          <span className="mono switch-price">{centsToMusd(a.priceCents)}</span>
        </button>
      ))}
    </div>
  );
}
