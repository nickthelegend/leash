# Hackathon submission form — LEASH

Target: **PayPal AI Hackathon** (https://paypalaihackathon.devpost.com/), deadline 2026-11-12 (time
per the event page). Prize amounts: see the event page; not restated here.

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
  server as a proof-gated proxy.

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

## Built with
Noir 1.0.0-beta.16, Barretenberg 3.0.1 (UltraHonk), Solidity/Foundry, Anvil, TypeScript, Node,
Express, Next.js 15, Model Context Protocol SDK, PayPal Orders v2 + Vault v3.

## Evidence
- Tests: 115 passing, 1 skipped (live PayPal) — see [TESTING.md](TESTING.md).
- Verifier: `contracts/src/LeashVerifier.sol`, EVM vk_hash
  `0x0293ccf79f5bbab5e8f19404833acd3025767d0bf162587ade1936f55e0242c1`.
- Demo: local Anvil run (see README "Demo video" and [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)).
- No public testnet deployment: the EVM leg is a local settlement stand-in (1 cent = 1 wei).

## Links
- Repo: https://github.com/nickthelegend/leash
- Video: (to add once hosted)

## Team
Nivesh Gajengi (GitHub nickthelegend)

## License
MIT
