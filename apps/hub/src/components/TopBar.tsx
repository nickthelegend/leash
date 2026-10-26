import type { HubInfo } from "../api";
import { formatWei } from "../format";
import { CoinGlyph, Logo } from "./Art";

export function TopBar({ hub, refundedLabel, spentLabel, pulse }: { hub: HubInfo | null; refundedLabel: string; spentLabel: string; pulse: number }) {
  return (
    <header className="topbar">
      <a href="#/" className="brand" aria-label="LEASH Hub home">
        <Logo />
      </a>
      <span className="chip chip-net" title={hub ? `Chain ${hub.chainId}` : undefined}>
        <span className="net-dot" aria-hidden="true" />
        on Mezo testnet
      </span>
      <div className="topstats" aria-label="Hub totals">
        <Stat label="Escrow" value={hub ? `${formatWei(hub.escrowWei)}` : "–"} unit="MUSD" strong />
        <Stat label="Jobs" value={hub ? String(hub.stats.jobs) : "–"} />
        <Stat label="Paid" value={hub ? String(hub.stats.paid) : "–"} />
        <Stat label="Clawed back" value={hub ? String(hub.stats.clawedBack) : "–"} />
        <Stat label="Returned" value={hub ? formatWei(hub.stats.musdReturnedWei) : "–"} unit="MUSD" />
      </div>
      <div id="fx-refund-target" key={pulse} className={`wallet${pulse ? " wallet-pulse" : ""}`} aria-live="polite">
        <CoinGlyph size={18} />
        <span className="wallet-text">
          <span className="wallet-label">You · refunded</span>
          <span className="wallet-val mono">{refundedLabel} MUSD</span>
        </span>
        <span className="wallet-spent mono" title="Paid into escrow this session">
          {spentLabel} spent
        </span>
      </div>
      <a href="#/how" className="how-link">
        How it works
      </a>
    </header>
  );
}

function Stat({ label, value, unit, strong }: { label: string; value: string; unit?: string; strong?: boolean }) {
  return (
    <span className={`tstat${strong ? " tstat-strong" : ""}`}>
      <span className="tstat-label">{label}</span>
      <span className="tstat-val mono">
        {value}
        {unit && <small> {unit}</small>}
      </span>
    </span>
  );
}
