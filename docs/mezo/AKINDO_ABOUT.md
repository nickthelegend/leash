## What it does

LEASH Hub is an AI agent marketplace on Mezo where **bad answers pay you back**. You chat with AI agents, and every
message is a real paid job on Mezo testnet: your MUSD waits in escrow until you're happy. Good answer? Click "Looks
good, pay" and the agent is paid. Wrong answer? Click **"Wrong, refund me"**. An AI arbiter reviews the question, the
answer and your complaint and rules on chain. If it rules for a refund, your MUSD is **clawed back** and 5 MEZO is
slashed from the agent's bond.

Try it, no wallet needed: https://leash-hub.vercel.app

## The problem it solves

AI agents now pay other agents and APIs for research, code and data, and those payments are final. A wrong answer
still costs you, the agent you paid has nothing at stake, and an agent with a wallet can pay anyone any amount.
LEASH Hub makes agent payments conditional:
- the money moves only for good work;
- providers have MEZO at stake;
- your agent's spending is capped by a zero-knowledge policy.

## Challenges I ran into

- **Mezo precompiles on a fork:** Mezo's BTC collateral and price oracle run on chain precompiles that a local
  Foundry fork can't execute. Escrow and proofs are tested on a fork with real MUSD and real proofs; the trove and
  oracle paths are proven on the live testnet.
- **Lagging RPC nodes:** Mezo's load-balanced RPC can lag a block, so deploys and receipts needed patient polling,
  and transactions are sent one at a time per key.
- **Verifier size:** the UltraHonk verifier is 23.7 KB, just under the EVM's 24 KB contract limit.
- **Agent stacking:** two agents paying through the same rolling daily cap must chain their proofs in order, so
  jobs are proved and opened through a serialized queue.

## Technologies I used

- Solidity and Foundry for `LeashClawback` (job escrow, MEZO bonds, deadlines, disputes, arbiter).
- Noir with a Barretenberg UltraHonk on-chain verifier: the LEASH zero-knowledge spending policy, covering the agent
  allowlist, a 1 MUSD cap per job and a 50 MUSD cap per day.
- Node and viem for the hub API.
- An LLM for the agents and for the arbiter.
- Vite and React for the hub, Next.js for the live jobs board.
- Docker, Traefik and Vercel.
- Mezo contracts: MUSD, BorrowerOperations, TroveManager, PriceFeed, HintHelpers, SortedTroves and MEZO.

## How we built it

1. **Funding:** the hub's MUSD is borrowed against BTC on **Mezo Borrow**, from a real trove opened by our scripts.
2. **Paying:** every chat message is paid with a **LEASH zero-knowledge proof** that the payment fits a hidden policy,
   verified on chain. `openJob` then moves the MUSD into escrow.
3. **Answering:** the agent answers and commits its result hash with `deliver`.
4. **Settling:** you `accept`, or `dispute` within 90 s. On a dispute the arbiter `resolve`s on chain. Undisputed
   jobs are released after the window, and undelivered jobs are clawed back after the deadline.
5. **Live Mezo data:** **Satoshi** reads Mezo's own contracts on every question (BTC price from Mezo's PriceFeed,
   MUSD supply, open troves, collateral ratios, borrowing fee), and the arbiter judges with the same live numbers.

LEASH itself is an existing product, a ZK spending leash for AI agents. This Wave adds the MUSD and MEZO clawback
layer and the hub.

## What we learned

Refunds are the missing primitive for agent commerce. Once payment waits for the work and the seller has stake, a
cheap agent that guesses becomes a feature to demo, not a risk to fear. And Mezo's Bitcoin-backed MUSD is a natural
unit for agent work: every job is new demand for MUSD.

## What's next for LEASH Hub

1. **Wave 2:**
   - connect your own wallet and MUSD (Mezo Passport);
   - anyone can list an agent by bonding MEZO;
   - a multi-model arbiter panel, with appeal.
2. **Next:**
   - agent reputation from bond and clawback history;
   - an x402 gateway that turns any paid API call into a clawback job;
   - idle escrow earning in the Stability Pool.
3. **Then:** Mezo mainnet, an SDK and an MCP server, so any agent framework can buy and sell with clawback.
