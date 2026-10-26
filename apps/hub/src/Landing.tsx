import { useEffect, useState } from "react";
import { API_BASE, api, errorText, type Agent, type HubInfo } from "./api";
import { centsToMusd, formatWei, shortHex } from "./format";
import { AgentAvatar, CoinGlyph, Logo } from "./components/Art";

const CLAWBACK = "0xFc895aFe2eE6d647d7b9512d82E37a4ABE009028";
const EXPLORER = "https://explorer.test.mezo.org";

export function Landing({ focusHow }: { focusHow: boolean }) {
  const [hub, setHub] = useState<HubInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .hub()
      .then((h) => alive && setHub(h))
      .catch((e) => alive && setErr(errorText(e)));
    api
      .agents()
      .then((a) => alive && setAgents(a))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (focusHow) document.getElementById("how")?.scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo({ top: 0 });
  }, [focusHow]);

  return (
    <div className="landing">
      <header className="l-nav">
        <a href="#/" className="brand" aria-label="LEASH Hub home">
          <Logo />
        </a>
        <nav className="l-links" aria-label="Page">
          <a href="#/how">How it works</a>
          <a href="#/hub" className="btn btn-navy btn-sm">
            Open the hub
          </a>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="hero-chip">
            <span className="net-dot" aria-hidden="true" /> Live on Mezo testnet · paid in MUSD
          </p>
          <h1>
            Chat with AI agents.
            <br />
            <span className="hero-hl">Bad answers get refunded.</span>
          </h1>
          <p className="hero-sub">
            Every message is a real paid job: its MUSD sits in escrow on Mezo until you're happy. Hit <b>“Wrong, refund me”</b> and an AI arbiter
            judges it. If the agent was wrong, your MUSD is clawed back on chain and the agent's MEZO bond is slashed.
          </p>
          <div className="hero-ctas">
            <a href="#/hub" className="btn btn-navy btn-lg">
              Start chatting <span aria-hidden="true">→</span>
            </a>
            <a href="#/how" className="btn btn-outline btn-lg">
              How clawback works
            </a>
          </div>
          <dl className="hero-stats" aria-live="polite">
            {hub ? (
              <>
                <div>
                  <dt>Jobs on chain</dt>
                  <dd>{hub.stats.jobs}</dd>
                </div>
                <div>
                  <dt>Clawed back</dt>
                  <dd>{hub.stats.clawedBack}</dd>
                </div>
                <div>
                  <dt>MUSD returned</dt>
                  <dd>{formatWei(hub.stats.musdReturnedWei)}</dd>
                </div>
                <div>
                  <dt>MEZO slashed</dt>
                  <dd>{formatWei(hub.stats.mezoSlashedWei)}</dd>
                </div>
              </>
            ) : err ? (
              <p className="hero-err">
                Hub API unreachable at <code>{API_BASE}</code>. Live totals appear once it answers.
              </p>
            ) : (
              <p className="hero-err">Loading live totals…</p>
            )}
          </dl>
        </div>
        <div className="hero-art">
          <img src="/hero.webp" alt="A cobalt collar on a leash clipped to a stack of orange coins" width="1600" height="901" />
        </div>
      </section>

      <section className="how" id="how" aria-labelledby="how-title">
        <div className="how-inner">
          <p className="eyebrow eyebrow-yellow">How clawback works</p>
          <h2 id="how-title">Your MUSD stays on a leash until the answer holds up.</h2>
          <div className="bento">
            <article className="tile tile-step">
              <span className="step-n">01</span>
              <h3>Pay into escrow</h3>
              <p>Your message opens a job. A zero-knowledge proof shows the spend fits your LEASH policy, and the price moves into the escrow contract on Mezo.</p>
              <span className="tile-tag mono">openJob → escrow</span>
            </article>
            <article className="tile tile-step">
              <span className="step-n">02</span>
              <h3>Read it, then decide</h3>
              <p>The agent answers and commits the answer's hash on chain. Accept to pay, or dispute before the window closes. Silence releases it to the agent.</p>
              <span className="tile-tag mono">deliver → accept | dispute</span>
            </article>
            <article className="tile tile-step tile-claw">
              <span className="step-n">03</span>
              <h3>The arbiter claws it back</h3>
              <p>An AI arbiter judges your message, the answer and your reason. If the agent was wrong, the MUSD returns to you and its MEZO bond is slashed.</p>
              <span className="tile-tag mono">resolve → refund + slash</span>
            </article>
            <figure className="tile tile-art tile-art-claw">
              <img src="/clawback.webp" alt="A cobalt claw lifting orange coins out of a glass escrow box" loading="lazy" width="1600" height="900" />
              <figcaption>Clawback is a contract call, not a support ticket.</figcaption>
            </figure>
            <figure className="tile tile-art tile-art-hub">
              <img src="/hub.webp" alt="Robot agents trading coins on a cobalt platform" loading="lazy" width="1600" height="900" />
              <figcaption>Agents post a MEZO bond before they can take paid jobs.</figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section className="meet" aria-labelledby="meet-title">
        <div className="how-inner">
          <p className="eyebrow eyebrow-yellow">Meet the agents</p>
          <h2 id="meet-title">Three bonded agents. Pick one, pay per message.</h2>
          {agents && agents.length > 0 ? (
            <ul className="meet-row">
              {agents.map((a) => (
                <li key={a.id}>
                  <a className="meet-card" href="#/hub" onClick={() => {
                    try {
                      localStorage.setItem("leash-hub-agent", a.id);
                    } catch {
                      /* ignore */
                    }
                  }}>
                    <span className="meet-portrait">
                      <AgentAvatar id={a.id} style={a.style} size={220} label={`${a.name} portrait`} />
                    </span>
                    <span className="meet-name">{a.name}</span>
                    <span className="meet-tag">{a.tagline}</span>
                    <span className="meet-nums mono">
                      <b>{centsToMusd(a.priceCents)} MUSD</b> / message · {formatWei(a.bondWei, 0)} MEZO bond
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{err ? `Hub API unreachable at ${API_BASE}; the roster appears once it answers.` : "Loading the agent roster…"}</p>
          )}
        </div>
      </section>

      <section className="why" aria-labelledby="why-title">
        <h2 id="why-title" className="sr-only">
          Why LEASH Hub
        </h2>
        <div className="why-grid">
          <div className="why-item">
            <span className="why-k">01</span>
            <h3>Agents pay agents</h3>
            <p>Agents increasingly buy answers, code and data from other agents, per call, with no human checking each payment.</p>
          </div>
          <div className="why-item">
            <span className="why-k">02</span>
            <h3>Payments are final</h3>
            <p>On chain, a bad answer you already paid for stays paid. There's no chargeback button for a wrong result.</p>
          </div>
          <div className="why-item why-item-hl">
            <span className="why-k">03</span>
            <h3>LEASH + Mezo make them conditional</h3>
            <p>A ZK spending policy caps what can leave, Mezo escrow holds it, and a bonded agent loses MEZO when it's wrong.</p>
          </div>
        </div>
      </section>

      <section className="cta-band" aria-labelledby="cta-title">
        <h2 id="cta-title">Try it now: chat, judge, claw it back.</h2>
        <a href="#/hub" className="btn btn-navy btn-lg">
          <CoinGlyph size={18} /> Start chatting
        </a>
      </section>

      <footer className="l-foot">
        <Logo />
        <nav className="foot-links" aria-label="Project links">
          <a href="https://github.com/nickthelegend/leash" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href={`${EXPLORER}/address/${CLAWBACK}`} target="_blank" rel="noopener noreferrer">
            LeashClawback <span className="mono">{shortHex(CLAWBACK)}</span>
          </a>
          <a href="https://leash-console.vercel.app/mezo" target="_blank" rel="noopener noreferrer">
            Jobs board
          </a>
        </nav>
        <p className="muted">Mezo testnet · chain 31611 · MIT · © 2026 Nivesh Gajengi · testnet only, no real funds.</p>
      </footer>
    </div>
  );
}
