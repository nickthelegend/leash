# Hackathon submission form — LEASH

Target: **PayPal AI Hackathon** (https://paypalaihackathon.devpost.com/), deadline **2026-11-12
12:00 PT (20:00 UTC)**. Also a fit for the "Best Use of Agentic Commerce" honorable mention. Prize
amounts: see the event page; not restated here.

Event requirements and where this entry stands (rules: paypalaihackathon.devpost.com/rules):

| Requirement | Status |
|---|---|
| PayPal developer platform central to the project | Orders v2 + Vault v3 implemented; **no sandbox order yet** (needs keys) |
| Judges can run it (setup incl. sandbox credentials, or a hosted URL) | `pnpm install && pnpm setup:tools && pnpm test`, then `pnpm demo:anvil && pnpm demo:agent` (no keys, no LLM). For the PayPal step the rules want the entrant's sandbox credentials: a sandbox client ID + secret and a sandbox buyer login go in Devpost's private testing-instructions field. **BLOCKED** until Nick's sandbox app exists. No hosted URL |
| Public repo, OSS license in About | github.com/nickthelegend/leash, MIT (`LICENSE`, which GitHub shows in About) |
| Video < 3 min, public on YouTube, showing it working end to end | 136 s Anvil recording exists, not on YouTube; a PayPal-first re-recording waits for a sandbox order |

## Project name
LEASH — a ZK spending leash for AI agents

## One-liner
An AI agent can only pay inside a secret policy (allowlisted merchants bound to their payees, a
per-payment cap and a daily cap): every payment carries a Noir zero-knowledge proof that a
verify-only gateway checks before creating and capturing a PayPal order.

## Problem
Agents with payment tools pay whatever a prompt convinces them to pay. Guardrails written as prompts
can be talked around; a spending limit held by the agent can be lied about.

## What it does
- The owner commits to a policy; only a Pedersen commitment is public.
- For each payment the agent proves, in Noir, that the merchant and its payee are on the allowlist,
  the amount is under the per-payment cap, and today's running total stays under the daily cap.
- The gateway verifies the proof with Barretenberg, checks the payee is the PayPal merchant it is
  about to pay, the nonce is fresh and the spend chain is current, then creates a PayPal Orders v2
  order (`custom_id` = keccak(policyId, nonce)). Above the owner's approval threshold the buyer
  approves it; below it a vaulted wallet is charged. Paid only when the capture is COMPLETED for the
  proven cents.
- `leash-mcp` gives any MCP agent these tools, and can sit in front of PayPal's own agent toolkit MCP
  server as a proof-gated proxy. There, before forwarding `pay_order`, it re-reads the order with
  `get_order` and refuses unless the payee is the allowlisted merchant and the amount is exactly the
  proven cents in USD.

## How PayPal is used
Orders v2 create/capture with `payee.merchant_id`, `custom_id`, `invoice_id` and deterministic
`PayPal-Request-Id`; Vault v3 setup/payment tokens for agent mode; GET order to re-verify receipts;
the `@paypal/mcp` agent toolkit as an upstream behind the proof gate.
**Status: implemented, live run pending sandbox keys** (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_PAYEE_MERCHANT_ID`). No sandbox order has run yet; this form will get the order id and a
screenshot once one does.

## How AI is used
An LLM agent (opencode with an OpenRouter model) pays only through leash-mcp's tools; the recorded
run shows it complying, being injected, and being refused by the circuit and the contract.
`pnpm matrix:llm` repeats this per policy-violation case: each matrix prompt goes to the agent as an
inbox item, and leash-mcp's own tool log records what the agent asked for and which layer refused it
(results in TESTING.md).

## Testing instructions for judges
```sh
pnpm install
pnpm setup:tools   # pinned nargo 1.0.0-beta.16 + bb 3.0.1 into .tools; checks Foundry and jq
pnpm test          # every proof real; the live PayPal test skips without keys
pnpm demo:anvil    # local chain with the demo policy
pnpm demo:agent    # no LLM, no keys: 1 release + the 6 recorded refusals, verify:receipt, balances (~5 s)
pnpm paypal:e2e    # the PayPal path
```
`pnpm demo:agent` replays the recorded agent run live without an LLM or keys: 300 cents released from
escrow to openai's bound payee, then the six recorded refusals, `verify:receipt 3001` and the balances.
For the PayPal path, put sandbox credentials in `.env.local`: `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET`, `PAYPAL_PAYEE_MERCHANT_ID` (the app's sandbox business account), and approve
with a sandbox personal account. The values for judges go in Devpost's private testing-instructions
field (BLOCKED: not created yet). `pnpm paypal:e2e` runs the order through the verify-only gateway and
finishes with `verify:receipt`; without keys it prints the exact dashboard checklist.

## Built with
Noir 1.0.0-beta.16, Barretenberg 3.0.1 (UltraHonk), Solidity/Foundry, Anvil, TypeScript, Node,
Express, Next.js 15, Model Context Protocol SDK, PayPal Orders v2 + Vault v3.

## Evidence
- Tests: `pnpm test` 173 passing, 1 skipped (live PayPal): 16 nargo, 48 forge, 90 `@leash/core`,
  19 `@leash/mcp`. Browser E2E in Google Chrome against the real local stack: 67 passing (chain 10,
  desktop 32, mobile 22, paypal-merchant 2, demo 1). See [TESTING.md](TESTING.md). Web lint + build
  pass and are CI jobs; GitHub has not run CI on these commits yet.
- LLM-in-the-loop matrix: one 3-case run (cases 21, 1, 25 on commit 575c7bf, 2026-10-21, free
  tier), 3/3 passed: released $3.00; injected $500.00 refused by the per-payment cap; injected payee
  swap refused by the circuit. `docs/evidence/llm-matrix-2026-10-21.json` (`casesRequested: [21, 1,
  25]`, `pending: []`). The other 6 cases of the 9-case default subset (22, 23, 24, 6, 19, 26) have not
  been run.
- Verifier: `contracts/src/LeashVerifier.sol`, EVM vk_hash
  `0x0293ccf79f5bbab5e8f19404833acd3025767d0bf162587ade1936f55e0242c1`.
- Demo: 136-second live Anvil recording, 2026-10-21 (README "Demo video"), not hosted publicly yet.
  [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) is the 2:00 target script for the PayPal-first re-recording,
  which follows once sandbox keys exist.
- No public testnet deployment: the EVM leg is a local settlement stand-in (1 cent = 1 wei). A
  deployment needs a funded testnet key; no captcha-free, account-free faucet worked (2026-10-21).

## Links
- Repo: https://github.com/nickthelegend/leash
- Video: (to add once on YouTube; must be public and under 3 minutes)

## Team
Nivesh Gajengi (GitHub nickthelegend)

## License
MIT
