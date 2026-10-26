# AKINDO submission: Mezo Buildathon Wave 1 (deadline Oct 26, 20:30 IST)

Paste each block into the matching field. Links:

- **Live project:** https://leash-hub.vercel.app (chat with the agents; no wallet needed)
- Jobs board: https://leash-console.vercel.app/mezo
- Hub API (for the curious): https://hub-api.201-18-198-162.sslip.io/api/hub
- Code: https://github.com/nickthelegend/leash
  - `apps/hub`: the hub UI
  - `packages/hub`: the hub API
  - `contracts/src/LeashClawback.sol`
  - `packages/mezo`: the live runs
- Deck: `docs/mezo/LEASH-Clawback-on-Mezo-deck.pdf`
- Video: upload `LEASH-Hub-pitch.mp4` (kept out of git) to YouTube unlisted and paste the link

**Project name:** LEASH Hub

**Project category (3-5 words):** AI agent marketplace, payments

**TL;DR:** An AI agent hub on Mezo: chat with AI agents, pay per answer in MUSD held in escrow, and if an answer is
wrong an AI arbiter claws your MUSD back on chain and slashes the agent's MEZO bond.

**How it works:**

- **Problem:** AI agents now pay other agents and APIs for answers, and those payments are final. A wrong answer
  still costs you, the agent risks nothing, and an agent with a wallet can pay anyone any amount.
- **How it functions:** LEASH Hub is a marketplace of AI agents on Mezo with pay-on-delivery. Each chat message is a
  real job in our `LeashClawback` contract on Mezo testnet:
  1. The hub pays for the job with a LEASH zero-knowledge proof. The hub's hidden spending policy allowlists the
     agents and caps each job at 1 MUSD and each day at 50 MUSD, and the proof is verified on chain by an UltraHonk
     verifier. The MUSD moves into the job's escrow, not to the agent.
  2. The agent answers with a real LLM and commits the answer's hash on chain (`deliver`). Satoshi, the Mezo analyst,
     reads Mezo's own contracts live on every question: the BTC price from Mezo's PriceFeed, MUSD supply, open troves,
     system collateral and debt, MCR, CCR, borrowing fee and minimum debt. Its answers carry a "Live Mezo data · block N"
     badge, and the arbiter judges with the same live facts.
  3. You click "Looks good, pay" (`accept`), or "Wrong, refund me" (`dispute`) within the 90 s window.
  4. If you dispute, an AI arbiter reads the question, the answer and your complaint, and rules on chain
     (`resolve`). A refund claws the MUSD back to the escrow and moves 5 MEZO from the agent's bond to the user.
     Undisputed answers are released to the agent after the window; undelivered jobs are clawed back after the
     deadline.
- **How we use and position MUSD and MEZO:**
  - MUSD is the unit of agent work. The hub's MUSD is borrowed against BTC on Mezo Borrow (a real trove on testnet),
    then escrowed per message, and paid or refunded.
  - MEZO is the agent's stake: agents must bond MEZO to take jobs, and lose it when they're wrong or don't deliver.
  - Every step is a Mezo transaction, linked to the explorer from the receipt next to each message.
- **Live on Mezo testnet now:**
  - 20+ real jobs so far, paid and clawed back.
  - Three agents: Satoshi (a Mezo/Bitcoin analyst with live Mezo data), Forge (code), and Quickie (the bargain agent, which estimates
    instead of computing, so you can watch a clawback).
  - Contract `LeashClawback` 0xFc895aFe2eE6d647d7b9512d82E37a4ABE009028.

**Target group:**

- People and teams using AI agents that buy answers or work from other agents.
- AI agent builders who want to sell on Mezo with a reputation backed by stake.
- Track 1: MUSD as escrowed productive capital, MEZO as slashable stake.
- Track 2: a consumer-friendly hub that puts MUSD in front of AI users, with no wallet needed to try it.
- Desktop and mobile web.
- Global.

**Tech stack:**

- Solidity 0.8.27 and Foundry, with 18 fork tests on Mezo testnet using real MUSD and real proofs.
- Noir circuit with a Barretenberg UltraHonk on-chain verifier (the LEASH circuit, unchanged).
- Node API with viem: the LEASH prover, an LLM for the agents and the arbiter, and a per-key transaction queue.
- Vite and React hub UI.
- Next.js jobs board.
- Docker on a VPS, with the frontends on Vercel.
- Mezo contracts: MUSD, BorrowerOperations, TroveManager, HintHelpers, SortedTroves, MEZO.

**Track:** Both (Track 1 and Track 2)

**Chain deployed on:** Mezo (testnet, chain 31611)

**Project status:** An existing project with new features. LEASH (https://github.com/nickthelegend/leash) is a
zero-knowledge spending policy for AI agents. During this Wave it gained:

- `LeashClawback` (MUSD job escrow, MEZO bonds, dispute and arbiter, clawback);
- `LeashMUSD` (MUSD escrow with a Mezo trove guard);
- LEASH Hub (the live agent chat with on-chain clawbacks);
- the jobs board;
- 18 fork tests.

**Project readiness:** Testnet deployment (Mezo testnet), live and usable at https://leash-hub.vercel.app

**Future milestones:**

1. **Wave 2, by Nov 15:**
   - users connect their own wallet and their own MUSD (Mezo Passport);
   - agents can be listed by anyone who bonds MEZO;
   - a multi-model arbiter panel, with appeal.
2. **December 2026:**
   - agent reputation from bond and clawback history;
   - an x402 gateway so any paid API call becomes a clawback job;
   - idle escrow MUSD earns in the Stability Pool.
3. **Q1 2027:** Mezo mainnet, with an SDK and an MCP server so any agent framework can sell and buy with clawback.

**Team:** Nivesh Gajengi (nickthelegend): solo builder, full stack and ZK. GitHub https://github.com/nickthelegend,
X: add your handle.
