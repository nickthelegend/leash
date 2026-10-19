# CLAUDE.md: guidance for coding agents

This repo holds the judged hackathon ideas and build plans. Each idea gets its **own build repo**. Read `README.md` (verdicts) and `ideas/<slug>.md` (plan) before writing code.

## Build priority (do not reorder without Nick)
1. **Blackbox Receipts:** Open Agent (sign-up Oct 20, sprint Oct 22–27) and GitLab Transcend (Oct 27).
2. **TasteProbe:** Qloo and Nebius x NVIDIA (both Oct 30).
3. **LEASH, stateless 2-rule version:** PayPal AI (Nov 12). **Do not build the rolling-cap nullifier circuit** before Nov 12.
4. **Mnemosyne:** Walrus Total Recall (Nov 10), only if 1–3 are on track.
5. **SensorSeal: CUT.** Don't start it.

## Hard rule: no mock data in final demos
- Demos, videos and submissions use **real** API calls, real agent runs, real proofs and real listings. No hardcoded responses, fake personas, seeded "example" receipts or `setTimeout` fake loaders.
- Fixtures are fine **in tests only** (`/test/fixtures`), and must never be imported by app code.
- If a dependency is unavailable (no API key, sandbox down), show an honest error or empty state and tell Nick. Don't fake it.
- Before submitting, grep for `mock`, `fake`, `dummy`, `lorem` and `TODO` in `src/`. The verifier agent will audit this.

## Stack suggestions
- **Language:** TypeScript (Node 20+) everywhere unless the sponsor requires otherwise; Python is acceptable for TasteProbe stats.
- **Web:** Next.js (App Router) + Tailwind + shadcn/ui; deploy on Vercel.
- **Agents/tools:** MCP servers (`@modelcontextprotocol/sdk`). GitLab entries must use the GitLab Duo Agent Platform.
- **ZK:** Noir (`nargo`) + `bb.js`; keep circuits minimal; Solidity verifiers via Foundry.
- **Storage:** Postgres (Neon/Supabase) for indexes; Walrus for tamper-evident blobs or memory.
- **Chains:** an EVM testnet for dev; whatever chain the sponsor requires for submission (Arc mainnet, Celo, Arbitrum).
- **Sponsor requirements are non-negotiable:** Qloo API for TasteProbe-Qloo; an NVIDIA open model on Nebius for TasteProbe-Nebius; PayPal plus AI for LEASH-PayPal; Walrus Memory on mainnet plus Tatum for Mnemosyne.

## Repo conventions
- Repo names: `blackbox-receipts`, `tasteprobe`, `leash`, `mnemosyne` under `nickthelegend`. MIT license (GitLab Path B needs MIT).
- Layout: `apps/web`, `packages/<core>`, `circuits/` (Noir), `contracts/` (Foundry), `test/`, `docs/demo.md`.
- Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Small commits, **push often**; never force-push `main`.
- Secrets live in `.env.local` only; commit `.env.example`. Never commit keys. Nick creates sponsor API keys himself.
- Each repo README must include: a one-line pitch, an architecture diagram, setup steps, the demo video link, sponsor tech used, and honest limitations.
- Tests: chain-verify (Blackbox), circuit pass/fail cases (LEASH) and stats (TasteProbe) must run in CI.

## Scope discipline
- Follow each plan's **cut order**. Never cut the item marked "never cut".
- Treat deadlines as the listing dates, then confirm timezones on the event page. Aim to submit 12h early.
