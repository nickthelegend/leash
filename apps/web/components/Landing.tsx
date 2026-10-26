import React from 'react';
import { ArrowRight, ArrowDown, Lock, X, Check } from 'lucide-react';
import { LeashLogo } from './Logo';
import { CollarTag } from './CollarTag';
import { RetractableLead } from './RetractableLead';
import { PayPalSetupCard } from './PayPalSetupCard';
import { RUN, SNAPS, SUMCHECKS, RECEIPT_CHECKS, short, type Snap } from '@/lib/recordedRun';

const REPO_URL = 'https://github.com/nickthelegend/leash';

export function LandingHero() {
  return (
    <header className="lz-hero" id="top">
      <div className="lz-wrap lz-hero-grid">
        <div className="lz-hero-copy">
          <p className="lz-kicker">ZK spending policy for AI agents</p>
          <h1 className="lz-h1">A spending leash your agent can&rsquo;t slip.</h1>
          <p className="lz-lead">
            Every payment carries a zero-knowledge proof it&rsquo;s inside the owner&rsquo;s secret caps, checked
            before money moves.
          </p>
          <div className="lz-cta">
            <a className="btn btn-dark" href="#console">
              Open the console <ArrowRight aria-hidden="true" />
            </a>
            <a className="btn btn-line" href="#how">
              How it works <ArrowDown aria-hidden="true" />
            </a>
          </div>
        </div>
        <div className="lz-hero-art">
          <CollarTag className="lz-collar" />
          <p className="lz-art-note">
            The real commitment from the recorded Anvil run, {RUN.date}.
          </p>
        </div>
      </div>
    </header>
  );
}

const STEPS: Array<[string, string]> = [
  ['Write the policy', 'Caps and allowed payees stay on the owner’s device. Only a commitment goes on the tag.'],
  ['Prove each payment', 'The agent’s request carries a Noir proof that it fits inside the policy.'],
  ['Release or snap', 'The verifier releases the escrowed payment, or refuses it before anything moves.'],
];

/** The landing below the hero: how it works, proof, and what is live. Everything else is on /evidence. */
export function LandingBands() {
  return (
    <>
      <section className="lz-sec lz-paper" id="how" aria-labelledby="how-h">
        <div className="lz-wrap">
          <h2 className="lz-h2" id="how-h">
            Three steps between an agent and your money.
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
        </div>
      </section>
      <section className="lz-sec lz-cream" id="proof" aria-labelledby="proof-h">
        <div className="lz-wrap">
          <h2 className="lz-h2" id="proof-h">
            One payment released. Every tug refused.
          </h2>
          <p className="lz-sub">The recorded Anvil run, {RUN.date}: an agent with only the leash-mcp tools.</p>
          <dl className="lz-big">
            <div>
              <dt>Released</dt>
              <dd>
                {RUN.release.amountCents}
                <small>¢</small>
              </dd>
            </div>
            <div>
              <dt>Refused</dt>
              <dd>6</dd>
            </div>
            <div>
              <dt>Tests</dt>
              <dd>229</dd>
            </div>
          </dl>
          <a className="lz-more" href="/evidence">
            See the evidence <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </section>
      <section className="lz-sec lz-paper" id="live" aria-labelledby="live-h">
        <div className="lz-wrap">
          <h2 className="lz-h2" id="live-h">
            What&rsquo;s live today
          </h2>
          <div className="lz-status">
            <div>
              <h3>
                <i className="ok" aria-hidden="true" />
                Live
              </h3>
              <p>Proof verification on the hosted gateway: try Live verify in the console below.</p>
            </div>
            <div>
              <h3>
                <i aria-hidden="true" />
                Setup required
              </h3>
              <p>
                PayPal sandbox orders need <code className="mono">PAYPAL_CLIENT_ID</code> and{' '}
                <code className="mono">PAYPAL_CLIENT_SECRET</code>. The contract path has run on local Anvil only.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** The evidence page's header: what moved off the landing, and a way into the walk log. */
export function EvidenceHero() {
  return (
    <header className="lz-hero lz-hero-short" id="top">
      <div className="lz-wrap">
        <p className="lz-kicker">Evidence · the recorded Anvil run, {RUN.date}</p>
        <h1 className="lz-h1">The tag, the lead and every snap.</h1>
        <div className="lz-cta">
          <a className="btn btn-dark" href="#walk">
            Read the walk log <ArrowDown aria-hidden="true" />
          </a>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full load starts the console fresh */}
          <a className="btn btn-line" href="/#console">
            Open the console <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </div>
    </header>
  );
}

const PUBLIC_INPUTS = [
  ['policy_commitment', 'the tag'],
  ['amount', 'cents'],
  ['merchant_id_hash', 'salted'],
  ['nonce', 'once per policy'],
  ['recipient', 'the bound payee'],
  ['epoch', 'UTC day'],
  ['prev_spend_commit', 'today so far'],
  ['new_spend_commit', 'after this one'],
];

const PRIVATE_WITNESS = [
  ['max_per_tx', 'per-payment cap'],
  ['daily_cap', 'per UTC day'],
  ['merkle_root + path', '(merchant, payee) allowlist'],
  ['merchant_id', 'who is paid'],
  ['spent_before', 'today’s running total'],
  ['salts', 'so nothing can be guessed'],
];

function TagSection() {
  return (
    <section className="lz-sec lz-paper" id="tag" aria-labelledby="tag-h">
      <div className="lz-wrap">
        <div className="lz-sec-head">
          <p className="lz-num">01 · The tag</p>
          <h2 className="lz-h2" id="tag-h">
            Anyone can read the tag. Nobody can read the rules.
          </h2>
          <p className="lz-sub">
            The front carries what a verifier sees with every payment. The back is the private witness: it only
            ever lives on the owner&rsquo;s device, and the circuit proves it hashes to the front.
          </p>
        </div>
        <div className="lz-tags">
          <article className="lz-dogtag lz-dogtag-front" aria-labelledby="front-h">
            <span className="lz-dogtag-hole" aria-hidden="true" />
            <h3 id="front-h">
              Front <span>· 8 public inputs</span>
            </h3>
            <ul>
              {PUBLIC_INPUTS.map(([k, v]) => (
                <li key={k}>
                  <code className="mono">{k}</code>
                  <span>{v}</span>
                </li>
              ))}
            </ul>
          </article>
          <article className="lz-dogtag lz-dogtag-back" aria-labelledby="back-h">
            <span className="lz-dogtag-hole" aria-hidden="true" />
            <h3 id="back-h">
              Back <span>· private witness</span>
            </h3>
            <ul>
              {PRIVATE_WITNESS.map(([k, v]) => (
                <li key={k}>
                  <code className="mono">{k}</code>
                  <span>{v}</span>
                </li>
              ))}
            </ul>
            <p className="lz-dogtag-note">
              On chain, a policy is keyed by <code className="mono">keccak256(owner, commitment)</code>. Only that
              owner can fund or withdraw it; a copied tag only creates the copier&rsquo;s own empty policy.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

function LeadSection() {
  return (
    <section className="lz-sec lz-cream" id="lead" aria-labelledby="lead-h">
      <div className="lz-wrap">
        <div className="lz-sec-head lz-sec-head-split">
          <div>
            <p className="lz-num">02 · The lead</p>
            <h2 className="lz-h2" id="lead-h">
              The cord pays out with each real payment and locks at the cap.
            </h2>
          </div>
          <p className="lz-sub">
            In the recorded run the cord was 700 cents long (the daily cap) with a stop at 500 (the per-payment
            cap). It paid out once: 300 cents to openai&rsquo;s bound payee, from the owner&rsquo;s escrow, relayed
            by an account that sent no value.
          </p>
        </div>
        <RetractableLead />
        <p className="lz-fine">
          Amounts are in cents. The demo chain settles 1 cent as 1 wei; it is a settlement stand-in for the PayPal
          rail. The caps are captions from the recording, never on chain.
        </p>
      </div>
    </section>
  );
}

const SCALE = 1000;

function MiniLead({ held, stop, pull, stopLabel }: { held: number; stop: number; pull: number; stopLabel: string }) {
  const p = (c: number) => `${(c / SCALE) * 100}%`;
  return (
    <div className="ml" aria-hidden="true">
      <div className="ml-rail" />
      {held > 0 && <div className="ml-held" style={{ width: p(held) }} />}
      <div className="ml-pull" style={{ left: p(held), width: p(pull - held) }} />
      <div className="ml-stop" style={{ left: p(stop) }}>
        <Lock />
      </div>
      <div className="ml-x" style={{ left: p(pull) }}>
        <X />
      </div>
      <div className="ml-labels">
        <span style={{ left: p(stop) }}>{stopLabel}</span>
        <span style={{ left: p(pull) }}>asked {pull}</span>
      </div>
    </div>
  );
}

function SnapGraphic({ snap }: { snap: Snap }) {
  if (snap.kind === 'over-cap') return <MiniLead held={0} stop={500} pull={900} stopLabel="stop 500" />;
  if (snap.kind === 'daily-cap') return <MiniLead held={300} stop={700} pull={800} stopLabel="lock 700" />;
  if (snap.kind === 'payee') {
    return (
      <div className="sg-pair" aria-hidden="true">
        <span className="ok">
          <Check /> clipped to <b className="mono">{short(RUN.payee)}</b>
        </span>
        <span className="no">
          <X /> asked <b className="mono">{short(RUN.attacker)}</b>
        </span>
      </div>
    );
  }
  return (
    <div className="sg-pair" aria-hidden="true">
      <span className="ok">
        <Check /> nonce <b className="mono">3001</b> used at block {RUN.release.block}
      </span>
      <span className="no">
        <X /> nonce <b className="mono">3001</b> again
      </span>
    </div>
  );
}

function SnapsSection() {
  return (
    <section className="lz-sec lz-paper" id="snaps" aria-labelledby="snaps-h">
      <div className="lz-wrap">
        <div className="lz-sec-head">
          <p className="lz-num">03 · Snapped taut</p>
          <h2 className="lz-h2" id="snaps-h">
            Four tugs the agent was told to try. The lead held every time.
          </h2>
          <p className="lz-sub">
            Same run, same policy. Each error below is the exact text leash-mcp returned to the agent.
          </p>
        </div>
        <ol className="lz-snaps">
          {SNAPS.map((s) => (
            <li key={s.kind} className="lz-snap">
              <div className="lz-snap-top">
                <span className="lz-snap-badge">Snapped</span>
                <span className="mono lz-snap-nonce">nonce {s.nonce}</span>
              </div>
              <h3>{s.title}</h3>
              <p className="lz-snap-req">{s.request}</p>
              <SnapGraphic snap={s} />
              <p className="lz-snap-err mono">{s.error}</p>
              <p className="lz-snap-at">Stopped at: {s.stoppedAt}</p>
            </li>
          ))}
        </ol>
        <div className="lz-sum">
          <p className="lz-sum-h">
            Two more, both refused by the on-chain verifier. <code className="mono">SumcheckFailed</code> is
            LeashPayment rejecting a proof whose public inputs don&rsquo;t match the payment, not a crash.
          </p>
          <ul>
            {SUMCHECKS.map((s) => (
              <li key={s.request}>
                <span>{s.request}</span>
                <code className="mono">{s.error}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

type WalkKind = 'set' | 'paid' | 'snap' | 'check' | 'setup';
const WALK: Array<{ kind: WalkKind; step: string; title: React.ReactNode; body?: React.ReactNode }> = [
  {
    kind: 'set',
    step: 'deploy',
    title: 'HonkVerifier and LeashPayment deployed on local Anvil',
    body: (
      <>
        verifier <code className="mono">{RUN.verifier}</code>
        <br />
        LeashPayment <code className="mono">{RUN.leashPayment}</code>
      </>
    ),
  },
  {
    kind: 'set',
    step: 'register',
    title: 'Owner (Anvil #0) registers the commitment and funds 2000 wei escrow in one call',
    body: (
      <>
        owner <code className="mono">{RUN.owner}</code>
        <br />
        commitment <code className="mono">{RUN.commitment}</code>
      </>
    ),
  },
  {
    kind: 'paid',
    step: '3001',
    title: '300 cents to openai: proved, verified, released from escrow',
    body: (
      <>
        tx <code className="mono">{RUN.release.txHash}</code>
        <br />
        block {RUN.release.block} · 300 wei to <code className="mono">{RUN.payee}</code> · proof {RUN.release.proofBytes} bytes,
        proved in {RUN.release.proveMs} ms, verified in {RUN.release.verifyMs} ms · relayer (Anvil #9) sent no value
      </>
    ),
  },
  { kind: 'snap', step: '3002', title: '900 cents: over the per-payment cap', body: SNAPS[0].error },
  { kind: 'snap', step: '3003', title: '200 cents to 0x3C44…93BC: attacker payee', body: SNAPS[1].error },
  { kind: 'snap', step: '3004', title: '500 cents on top of 300: daily cap', body: SNAPS[2].error },
  { kind: 'snap', step: '3001', title: 'Replay of the released proof', body: SNAPS[3].error },
  { kind: 'snap', step: '3005', title: 'Valid 200-cent proof redirected to 0x3C44…93BC', body: 'SumcheckFailed (proof rejected: it does not verify for these public inputs)' },
  { kind: 'snap', step: 'cast', title: 'Direct call to LeashPayment claiming 900 cents with that proof', body: `custom error ${RUN.sumcheckSelector}: SumcheckFailed` },
  {
    kind: 'check',
    step: 'receipt',
    title: 'verify:receipt 3001: receipt verified',
    body: (
      <span className="lz-pass">
        {RECEIPT_CHECKS.map((c) => (
          <span key={c}>PASS {c}</span>
        ))}
      </span>
    ),
  },
  { kind: 'setup', step: 'paypal', title: 'paypal:e2e: Setup required (PAYPAL_CLIENT_ID), exit code 1', body: 'also missing: PAYPAL_CLIENT_SECRET, PAYPAL_PAYEE_MERCHANT_ID' },
  {
    kind: 'check',
    step: 'state',
    title: 'Chain state after the walk',
    body: (
      <>
        payee <code className="mono">{short(RUN.payee)}</code> +300 wei · attacker <code className="mono">{short(RUN.attacker)}</code> +0 wei ·
        escrow 1700 wei left of 2000 · PaymentReleased events: 1
      </>
    ),
  },
];

function WalkLog() {
  return (
    <section className="lz-sec lz-deep" id="walk" aria-labelledby="walk-h">
      <div className="lz-wrap">
        <div className="lz-sec-head lz-sec-head-split">
          <div>
            <p className="lz-num">04 · Walk log</p>
            <h2 className="lz-h2" id="walk-h">
              The recorded Anvil run, start to finish.
            </h2>
          </div>
          <p className="lz-sub">
            {RUN.date}, repo {RUN.commit}: {RUN.agent} with only the leash-mcp tools. A replay of that run, not a
            live feed. Anvil is a local chain (id {RUN.chainId}), so there is no public explorer to link to; the
            hashes are as printed.
          </p>
        </div>
        <ol className="lz-walk">
          {WALK.map((w, i) => (
            <li key={i} className={`lz-walk-${w.kind}`}>
              <span className="lz-walk-node" aria-hidden="true" />
              <span className="lz-walk-step mono">{w.step}</span>
              <div className="lz-walk-body">
                <p className="lz-walk-title">
                  <span className="sr-only">
                    {w.kind === 'paid' ? 'Released: ' : w.kind === 'snap' ? 'Refused: ' : w.kind === 'setup' ? 'Setup required: ' : ''}
                  </span>
                  {w.title}
                </p>
                {w.body && <div className="lz-walk-detail">{w.body}</div>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'Can a prompt-injected agent raise its own cap?',
    a: 'No. The cap is a private input bound to the public commitment. Lying about max_per_tx breaks the commitment, and nargo refuses a witness over the cap.',
  },
  {
    q: 'What stops a replay or a redirected payment?',
    a: 'Nonces are scoped per policy and consumed once. Each merchant’s payee is inside its allowlist leaf, so a proof can only name that payee; sent to any other address it fails verification with SumcheckFailed.',
  },
  {
    q: 'Can an agent split a big payment into small ones?',
    a: 'Only up to the daily cap. Each proof opens the previous spend commitment and commits to the new total, and the contract (or gateway) stores the latest one, so two proofs built on the same total can’t both land. The circuit, contract and gateway hold one spend chain per settlement rail; leash-mcp adds up every rail a policy pays on (chain, PayPal gateway, PayPal MCP proxy) and refuses a payment that takes the total over the cap.',
  },
  {
    q: 'Is this on a public network?',
    a: 'No. The contract path has run on a local Anvil chain only, as a settlement stand-in (1 cent settles as 1 wei), and leash-mcp’s on-chain tool refuses any chain id other than 31337.',
  },
];

function RailAndFinePrint() {
  return (
    <section className="lz-sec lz-paper" id="paypal" aria-labelledby="paypal-h">
      <div className="lz-wrap lz-rail-grid">
        <div>
          <p className="lz-num">05 · The PayPal lead</p>
          <h2 className="lz-h2" id="paypal-h">
            Built, not clipped on yet.
          </h2>
          <p className="lz-sub">
            Orders v2 create (custom_id bound to the proof), buyer approval or a vaulted wallet, and a capture
            checked against the proven cents are in the code. No sandbox order has run: the keys are not set, so the
            gateway answers &ldquo;Setup required&rdquo; and consumes nothing.
          </p>
          <div className="mt-6">
            <PayPalSetupCard tone="light" />
          </div>
        </div>
        <div>
          <p className="lz-num">Fine print</p>
          <div className="lz-faq">
            {FAQ.map((item, i) => (
              <details key={item.q} open={i === 0}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
          <pre className="lz-pre" aria-label="Run it locally">{`pnpm install
pnpm setup:tools  # pinned nargo+bb
pnpm test         # real proofs
pnpm demo:anvil   # local chain
pnpm paypal:e2e   # sandbox keys`}</pre>
          <div className="lz-cta">
            <a className="btn btn-dark" href={REPO_URL} target="_blank" rel="noreferrer">
              Get the code <ArrowRight aria-hidden="true" />
            </a>
            <a className="btn btn-line" href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer">
              README
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Tag, lead, snaps, walk log, PayPal rail and fine print: served at /evidence. */
export function EvidenceSections() {
  return (
    <>
      <TagSection />
      <LeadSection />
      <SnapsSection />
      <WalkLog />
      <RailAndFinePrint />
    </>
  );
}

export function SiteFooter({ page = 'landing' }: { page?: 'landing' | 'evidence' | 'mezo' }) {
  const links: Array<[string, string]> =
    page === 'mezo'
      ? [
          ['Jobs', '#jobs'],
          ['How it works', '#how'],
          ['Contracts', '#contracts'],
          ['Console', '/#console'],
        ]
      : page === 'evidence'
      ? [
          ['Tag', '#tag'],
          ['Lead', '#lead'],
          ['Snaps', '#snaps'],
          ['Walk log', '#walk'],
          ['Console', '/#console'],
        ]
      : [
          ['How it works', '#how'],
          ['Proof', '#proof'],
          ['What’s live', '#live'],
          ['Console', '#console'],
          ['Evidence', '/evidence'],
        ];
  return (
    <footer className="lz-foot">
      <div className="lz-strap" aria-hidden="true" />
      <div className="lz-wrap lz-foot-cta">
        <h2>Put your agent on a leash.</h2>
        <div className="lz-cta">
          <a className="btn btn-accent" href={REPO_URL} target="_blank" rel="noreferrer">
            Get the code <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className="lz-wrap lz-foot-row">
        <LeashLogo tone="accent" className="text-white" />
        <nav aria-label="Footer">
          {links.map(([label, href]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <span className="lz-legal">© 2026 Nivesh Gajengi · MIT License</span>
      </div>
    </footer>
  );
}
