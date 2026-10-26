# AKINDO submission: Mezo Buildathon Wave 1 (deadline Oct 26, 20:30 IST)

Paste each block into the matching field. Links:

- Live: https://leash-console.vercel.app/mezo
- Code: https://github.com/nickthelegend/leash (Mezo work: `contracts/src/LeashClawback.sol`, `packages/mezo/`, `apps/web` `/mezo`)
- Deck: `docs/mezo/LEASH-Clawback-on-Mezo-deck.pdf`
- Video: `docs/mezo/LEASH-Clawback-pitch.mp4` (upload to YouTube unlisted and paste the link)

**Project name:** LEASH Clawback

**Project category (3-5 words):** AI agent payments, escrow

**TL;DR:** AI agents hire other agents on Mezo and pay in MUSD into escrow: good work gets paid, while a wrong answer
or no answer gets clawed back to the user, with the provider's MEZO bond slashed.

**How it works:**

- **Problem:** AI agents now pay other agents and APIs for work, and those payments are final. A wrong answer or
  no answer still costs the user, the provider risks nothing, and an agent with a wallet can pay anyone any amount.
- **How it functions:** LEASH Clawback makes Mezo the hub where agents work and get paid safely.
  1. The user borrows MUSD against BTC on Mezo Borrow (`openTrove`) and funds a LEASH policy escrow in MUSD. The
     policy (allowlisted providers, a per-job cap, a daily cap) stays hidden in a zero-knowledge commitment.
  2. The user's agent hires a provider agent with `openJob`. It pays with an UltraHonk proof that the payment fits
     the policy, verified on chain, and the MUSD moves into the job's escrow, not to the provider. Providers must
     hold a MEZO bond.
  3. The provider delivers a result hash and URI before the deadline. The user's agent checks it.
  4. Good work is accepted, or released once the dispute window passes, and the provider is paid in MUSD. A bad
     answer is disputed and the policy's arbiter rules on it. No answer before the deadline can be clawed back
     by anyone. A clawback returns the MUSD to the user and slashes the provider's MEZO bond to the user.
- **How we use and position MUSD and MEZO:**
  - MUSD is the unit of agent work: borrowed against BTC, escrowed per job, paid or refunded.
  - MEZO is the provider's stake: bonded to earn, slashed for ghosting or bad work.
- **Live on Mezo testnet:** 18 transactions, all succeeded.
  - A real trove borrowed 2,000 MUSD.
  - A provider bonded 20 MEZO.
  - Three real jobs:
    1. A correct answer, verified on chain and paid 3 MUSD.
    2. A wrong answer, disputed, and 4 MUSD clawed back with 5 MEZO slashed.
    3. No answer, and 5 MUSD clawed back after the deadline with 5 MEZO slashed.

**Target group:**

- Builders and users of AI agents that buy work from other agents or paid APIs (research, data, code, answers).
- Track 1 (DeFi): MUSD as escrowed productive capital, MEZO as slashable stake.
- Track 2 (Access): agents get a safe way to spend MUSD.
- Developers on desktop first; agent frameworks call the contract directly.
- Global.

**Tech stack:**

- Solidity 0.8.27 and Foundry.
- Noir circuit with a Barretenberg UltraHonk on-chain verifier: the existing LEASH circuit, unchanged.
- TypeScript prover (`@leash/core`).
- Next.js console with live JSON-RPC reads.
- Mezo contracts: MUSD, BorrowerOperations, TroveManager, HintHelpers, SortedTroves, MEZO.
- Mezo testnet (chain 31611).

**Track:** Both (Track 1 and Track 2)

**Chain deployed on:** Mezo (testnet)

**Project status:** An existing project with new features. LEASH (https://github.com/nickthelegend/leash,
https://leash-console.vercel.app) is a zero-knowledge spending policy for AI agents. During this Wave it gained:

- `LeashClawback` (MUSD job escrow, MEZO bonds, clawback and arbiter);
- `LeashMUSD` (MUSD escrow with a Mezo trove guard);
- the Mezo testnet deployment;
- 18 fork tests;
- the `/mezo` live page.

**Project readiness:** Testnet deployment (Mezo testnet)

**Contracts:**

- LeashClawback: `0xFc895aFe2eE6d647d7b9512d82E37a4ABE009028`
- LEASH HonkVerifier: `0xc505B0E4d6b7B6E4162f5F82D7966FD73310e336`

**Future milestones:**

1. **Wave 2, by Nov 15:** an AI arbiter panel that judges disputes from the evidence, with appeal to a human, and an
   x402 gateway where any paid API call opens a clawback job in MUSD.
2. **December 2026:** provider reputation from bond history (smaller bonds for proven providers), and idle escrow
   MUSD earning in the Stability Pool.
3. **Q1 2027:** a Mezo mainnet launch with an SDK and an MCP server, so any agent framework can hire with clawback.

**Team:** Nivesh Gajengi (nickthelegend): solo builder, full stack and ZK. GitHub https://github.com/nickthelegend,
X: add your handle.
