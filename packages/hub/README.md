# LEASH Hub API

**Chat with AI agents on Mezo. Bad answers get refunded.**

Live: https://leash-hub.vercel.app (UI in `apps/hub`) · API: https://hub-api.201-18-198-162.sslip.io/api/hub

Every chat message is a real job in `LeashClawback` on Mezo testnet:

1. **Prove:** a LEASH proof that the payment fits the hub's hidden policy (allowlisted agents, at most 1 MUSD per
   job, 50 MUSD per day).
2. **Open the job:** `openJob` moves the MUSD into escrow.
3. **Answer:** the agent answers with an LLM.
4. **Deliver:** `deliver` commits the answer's hash on chain.
5. **Settle:**
   - The user can `accept`, or `dispute` within the 90 s window.
   - On a dispute an AI arbiter rules, and `resolve` either releases the payment to the agent or claws it back,
     moving 5 MEZO from the agent's bond.
   - Undisputed jobs are released after the window, and jobs the agent never delivers are clawed back after their
     deadline.

**Agents:**

- **Satoshi:** a Mezo, Bitcoin and MUSD analyst.
- **Forge:** code.
- **Quickie:** the bargain agent. Its instructions are to estimate rather than compute and never double-check, so
  wrong answers are easy to see, and its card says so.

All three use the free `openai-fast` model behind `text.pollinations.ai`, and each has its own Mezo address and MEZO
bond. Bonds are topped up from the hub owner's MEZO when a slash takes them below `minBond`.

**Setup:** `node packages/hub/scripts/setup.mjs` funds the agents' gas, bonds 10 MEZO each, and registers the hub
policy (random private salts in `packages/hub/.state`, gitignored) with 60 MUSD of escrow. The owner's MUSD comes
from a real Mezo Borrow trove (see `packages/mezo`).

**Run:** `HUB_ENV=contracts/.env.mezo node packages/hub/src/server.mjs`. Keys stay in that gitignored file.

**Deploy:** `packages/hub/Dockerfile` plus `docker-compose.yml`, behind Traefik on the VPS.

**Limits, honestly:**

- The demo account is custodial: visitors chat as the hub owner, so judges need no wallet. Rate limits are 10
  messages per 10 minutes.
- The arbiter is one LLM with reference facts about Mezo, not a panel.
- Answers are stored by the API and only their hashes go on chain.
