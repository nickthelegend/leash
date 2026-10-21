import React from 'react';
import { ArrowRight } from 'lucide-react';
import { LeashLogo } from './Logo';
import { PayPalSetupCard } from './PayPalSetupCard';

const REPO_URL = 'https://github.com/nickthelegend/leash';

// Anvil dev account #1, the proven payee in the recorded run (README "Demo video").
const PAYEE_SHORT = '0x7099…79C8';

function Arrow() {
  return <ArrowRight aria-hidden="true" />;
}

/** A large leash loop drawn behind the hero headline. Static. */
function HeroRing() {
  return (
    <svg className="lp-ring" viewBox="0 0 800 800" fill="none" aria-hidden="true" focusable="false">
      <circle cx="330" cy="330" r="230" stroke="currentColor" strokeWidth="56" />
      <path d="M500 500 L760 760" stroke="currentColor" strokeWidth="56" strokeLinecap="round" />
    </svg>
  );
}

export function LandingHero() {
  return (
    <header className="lp-hero" id="top">
      <HeroRing />
      <div className="lp-wrap">
        <div>
          <h1 className="lp-hero-h">A spending leash your agent can&rsquo;t slip.</h1>
          <p className="lp-lead">
            LEASH lets an AI agent pay only inside a secret policy: a merchant allowlist with each
            merchant&rsquo;s payee, a per-payment cap and a daily cap. Every payment carries a Noir proof
            that is checked before any money moves, even when the agent is prompt-injected.
          </p>
          <div className="lp-cta">
            <a className="btn btn-accent" href="#console">
              Open the console <Arrow />
            </a>
            <a className="btn btn-ghost-light" href="#evidence">
              See the recorded run
            </a>
          </div>
        </div>

        <aside className="lp-widget lp-rise" aria-label="Policy and one proof-verified payment from the recorded run">
          <div className="w-top">
            <span className="w-title">Policy</span>
            <span className="tag tag-deep">Recorded run</span>
          </div>
          <dl>
            <div>
              <dt>Per-transaction cap</dt>
              <dd>
                $5.00 <span className="text-[13px] font-normal text-[#5a6382]">private</span>
              </dd>
            </div>
            <div>
              <dt>Merchant</dt>
              <dd>
                openai <span className="text-[13px] font-normal text-[#5a6382]">allowlisted</span>
              </dd>
            </div>
          </dl>
          <div className="w-pay">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] text-[#5a6382]">Payment, proof verified</span>
              <span className="tag tag-ok">Released</span>
            </div>
            <div className="w-amount mt-3">
              300<small>cents ($3.00)</small>
            </div>
            <div className="mt-4 grid gap-1.5 text-[14px]">
              <div className="flex justify-between gap-3">
                <span className="text-[#5a6382]">Payee</span>
                <span className="mono text-[13px]">{PAYEE_SHORT}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#5a6382]">Nonce</span>
                <span className="mono text-[13px]">3001</span>
              </div>
            </div>
          </div>
          <p className="w-note">
            From the recorded run on 2026-10-20: an LLM agent paying through leash-mcp on a local Anvil
            chain. A replay of that run, not a live feed.
          </p>
        </aside>
      </div>
    </header>
  );
}

const BUILT_WITH = ['Noir', 'UltraHonk', 'Barretenberg', 'Foundry', 'Anvil', 'MCP', 'Next.js'];

const EVIDENCE: Array<{ attempt: React.ReactNode; result: string; released: boolean }> = [
  {
    attempt: (
      <>
        300 cents to the payee <span className="mono text-[13px]">{PAYEE_SHORT}</span>
      </>
    ),
    result: 'Proved, verified and released on-chain with executePayment(owner, commitment, …)',
    released: true,
  },
  {
    attempt: 'Injected 900-cent request',
    result: 'Refused by the policy (rule R2, cap $5.00); no proof issued',
    released: false,
  },
  {
    attempt: 'Replay of the 300-cent proof (nonce 3001)',
    result: 'Nonce already used, rejected on-chain',
    released: false,
  },
  {
    attempt: '200-cent proof sent to another recipient',
    result: 'SumcheckFailed: the verifier rejects the proof for those public inputs',
    released: false,
  },
  {
    attempt: 'Direct 900-cent call reusing the 200-cent proof, bypassing leash-mcp',
    result: 'SumcheckFailed',
    released: false,
  },
];

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'Can a prompt-injected agent raise its own cap?',
    a: 'No. The cap is a private input bound to the public policy commitment. Lying about max_per_tx breaks the commitment, and nargo refuses a witness over the cap.',
  },
  {
    q: 'What does everyone else see?',
    a: 'The policy commitment, the amount in cents, a salted merchant hash, the nonce, the payee, the UTC day and two spend commitments. Never the caps, the allowlist or how much was spent today.',
  },
  {
    q: 'What stops a replay or a redirected payment?',
    a: 'Nonces are scoped per policy and consumed once. Each merchant’s payee is inside its allowlist leaf, so a proof can only name that payee, and a proof sent to any other address fails verification with SumcheckFailed.',
  },
  {
    q: 'Can an agent split a big payment into small ones?',
    a: 'Only up to the daily cap. Each proof opens the previous spend commitment and commits to the new total; the contract (or gateway) stores the latest one, so two proofs built on the same total can’t both land.',
  },
  {
    q: 'Who can move the escrow?',
    a: 'Policies are keyed by keccak256(owner, commitment). Only the owner can fund or withdraw a policy. Anyone may relay a payment, but it can only spend that policy’s own balance.',
  },
  {
    q: 'Does the PayPal release work yet?',
    a: 'Implemented, live run pending sandbox keys. Orders v2 create (custom_id bound to the proof), buyer approval or a vaulted wallet, and capture checked against the proven cents are in the code; no sandbox order has run because PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set. Without them the gateway answers “Setup required” and consumes nothing.',
  },
  {
    q: 'Is this on a public network?',
    a: 'No. The contract path has run on a local Anvil chain only, as a settlement stand-in (1 cent settles as 1 wei), and leash-mcp’s on-chain tool refuses any chain id other than 31337.',
  },
];

interface LandingSectionsProps {
  paypalOrderId?: string;
  paypalStatus?: string;
}

export function LandingSections({ paypalOrderId, paypalStatus }: LandingSectionsProps) {
  return (
    <div className="lp-light">
      <div className="lp-built">
        <span className="pill">Proofs by Noir and Barretenberg, built for the PayPal AI Hackathon</span>
        <ul aria-label="Built with">
          {BUILT_WITH.map((name) => (
            <li key={name}>
              <i aria-hidden="true" />
              {name}
            </li>
          ))}
        </ul>
      </div>

      <section className="lp-sec">
        <div className="lp-wrap lp-intro">
          <div>
            <h2 className="lp-sec-h">A limit a prompt can&rsquo;t argue with</h2>
            <div className="lp-cta" style={{ marginTop: 34 }}>
              <a className="btn btn-dark" href={REPO_URL} target="_blank" rel="noreferrer">
                Run it locally <Arrow />
              </a>
              <a className="btn btn-outline" href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer">
                Read the README
              </a>
            </div>
          </div>
          <div className="copy lp-lead">
            <p>
              <b>The rules stay private.</b> Only a Pedersen commitment to the caps and the allowlist is
              public.
            </p>
            <p>
              <b>Every payment is proven.</b> The circuit checks the amount is within the per-payment and
              daily caps and that the merchant and its payee are in the allowlist. The gateway, or the
              LeashPayment contract, verifies the proof before anything is released.
            </p>
          </div>
        </div>
      </section>

      <section className="lp-sec" id="how" style={{ paddingTop: 0 }}>
        <div className="lp-wrap">
          <div className="lp-head">
            <h2 className="lp-sec-h">One policy, three guarantees</h2>
            <a className="btn btn-outline btn-sm" href={`${REPO_URL}#architecture`} target="_blank" rel="noreferrer">
              Learn more <Arrow />
            </a>
          </div>
          <div className="lp-bento">
            <article className="lp-card c-tint">
              <div className="lp-ui">
                <div className="text-[14px] text-[#5a6382]">Private witness</div>
                <div className="lp-chips mt-3">
                  {['max_per_tx', 'daily_cap', 'merkle_root', 'salts', 'merchant_id', 'spent_before'].map((c) => (
                    <span key={c} className="mono !bg-[#fff6d6] !text-[13px]">
                      {c}
                    </span>
                  ))}
                </div>
                <div className="mt-4 flex items-center gap-3 text-[14px] text-[#5a6382]">
                  <span aria-hidden="true">↓ Pedersen</span>
                </div>
                <div className="lp-chips mt-2">
                  <span className="on mono !text-[13px]">policy_commitment</span>
                </div>
              </div>
              <div>
                <h3 className="lp-card-h">The rules stay secret</h3>
                <p>
                  The caps and the allowlist are private inputs. The circuit proves they hash to the public
                  commitment, so an agent can&rsquo;t lie about any of them.
                </p>
              </div>
            </article>

            <article className="lp-card c-tint-2">
              <div>
                <h3 className="lp-card-h">Bound to one payment</h3>
                <p>
                  Eight public inputs tie each proof to exactly one payment and one step of the day&rsquo;s
                  spend chain. Change any of them and verification fails.
                </p>
              </div>
              <div className="lp-chips">
                {['policy_commitment', 'amount (cents)', 'merchant_id_hash', 'nonce', 'recipient', 'epoch', 'prev_spend', 'new_spend'].map((c, i) => (
                  <span key={c} className={`mono !text-[13px] ${i === 1 ? 'on' : ''}`}>
                    {c}
                  </span>
                ))}
              </div>
            </article>

            <article className="lp-card c-deep">
              <div>
                <h3 className="lp-card-h">Escrow only the owner touches</h3>
                <p>
                  On-chain policies are keyed by owner and commitment, so a copied commitment only creates
                  the copier&rsquo;s own empty policy.
                </p>
              </div>
              <div className="lp-rows">
                <div>
                  <span className="mono text-[13px]">registerPolicy{'{value}'}</span>
                  <span className="tag tag-accent">owner funds</span>
                </div>
                <div>
                  <span className="mono text-[13px]">deposit / withdraw</span>
                  <span className="tag tag-accent">owner only</span>
                </div>
                <div>
                  <span className="mono text-[13px]">executePayment</span>
                  <span className="tag tag-accent">proof + nonce</span>
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="lp-sec" style={{ paddingTop: 0 }} aria-label="Key numbers">
        <div className="lp-wrap lp-stats">
          <div className="lp-stat">
            <b>8</b>
            <span>public inputs bind each proof to one payment</span>
          </div>
          <div className="lp-stat">
            <b>16</b>
            <span>merchants per allowlist, a depth-4 Merkle tree</span>
          </div>
          <div className="lp-stat">
            <b>26</b>
            <span>cases in the policy-violation matrix: 22 violations, 4 legitimate</span>
          </div>
          <div className="lp-stat">
            <b>0</b>
            <span>PayPal sandbox orders so far. Setup required.</span>
          </div>
        </div>
      </section>

      <section className="lp-sec lp-dark" id="evidence">
        <div className="lp-wrap">
          <div className="lp-head">
            <div>
              <h2 className="lp-sec-h">The recorded Anvil run</h2>
              <p className="muted lp-lead" style={{ margin: '18px 0 0', maxWidth: '52ch' }}>
                On 2026-10-20, opencode drove OpenRouter minimax-m3.1-flash:free through leash-mcp against a
                local Anvil chain, policy owned by Anvil #0. Nothing mocked. It is a local chain, so there is
                no public explorer link.
              </p>
            </div>
          </div>

          <div className="lp-ev" role="table" aria-label="Recorded agent attempts and results">
            {EVIDENCE.map((row, i) => (
              <div className="row" role="row" key={i}>
                <span role="cell" className="font-medium">
                  {row.attempt}
                </span>
                <span role="cell" className="res">
                  {row.result}
                </span>
                <span role="cell">
                  <span className={`tag ${row.released ? 'tag-ok' : 'tag-no'}`}>
                    {row.released ? 'Released' : 'Blocked'}
                  </span>
                </span>
              </div>
            ))}
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="rounded-panel bg-cobalt-800 p-5 sm:p-6 ring-1 ring-inset ring-cobalt-line">
              <div className="text-lg font-medium tracking-tighter2">Reading the results</div>
              <p className="mt-3 text-sm leading-relaxed text-white/70">
                <span className="mono text-sun">SumcheckFailed</span> is the on-chain UltraHonk verifier
                rejecting the proof: its public inputs don&rsquo;t match the payment it was sent with. The
                900-cent attempt stops in leash-mcp&rsquo;s policy check before proving, but the cap is also a
                circuit constraint, so a forged 900-cent proof fails on-chain too.
              </p>
            </div>
            <PayPalSetupCard orderId={paypalOrderId} orderStatus={paypalStatus} />
          </div>

          <div className="lp-faq" id="faq" style={{ marginTop: 110 }}>
            <div>
              <h2 className="lp-sec-h">Frequently asked questions</h2>
              <p className="muted lp-lead" style={{ margin: '18px 0 0', maxWidth: '34ch' }}>
                Straight answers about the proof, the escrow and what is not done yet.
              </p>
            </div>
            <div>
              {FAQ.map((item, i) => (
                <details key={item.q} open={i === 0}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="lp-talk">
        <div className="lp-wrap">
          <h2 className="lp-sec-h">Put your agent on a leash</h2>
          <p>
            Run the gateway and this console locally with the pinned nargo and bb from TOOLCHAIN.md, then try to
            talk an agent past its cap.
          </p>
          <pre aria-label="Local setup commands">{`pnpm install
cp .env.example .env.local
pnpm dev:gateway
pnpm dev:web`}</pre>
          <div className="lp-cta" style={{ justifyContent: 'center' }}>
            <a className="btn btn-dark" href="#console">
              Open the console <Arrow />
            </a>
            <a className="btn btn-outline" href={REPO_URL} target="_blank" rel="noreferrer">
              Get the code
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="lp-foot">
      <div className="box">
        <div>
          <LeashLogo className="text-white" />
          <p>
            A ZK spending leash for AI agents: a secret policy, a Noir proof for every payment, verified before
            anything is released.
          </p>
        </div>
        <nav aria-label="Footer">
          <a href="#how">How it works</a>
          <a href="#evidence">Recorded run</a>
          <a href="#faq">FAQ</a>
          <a href="#console">Console</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <div className="legal">
          <span>© 2026 Nivesh Gajengi. MIT License.</span>
          <span>Built for the PayPal AI Hackathon</span>
        </div>
      </div>
    </footer>
  );
}
