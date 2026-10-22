# LEASH — a ZK spending leash for AI agents

Zero-knowledge spending mandates for AI agents. An agent can only pay inside a secret policy (a
merchant allowlist where each merchant is bound to one payee, a per-payment cap and a rolling daily
cap), even when it is prompt-injected. Every payment carries a Noir proof that it satisfies the
policy; a verify-only gateway (PayPal rail) or the `LeashPayment` contract (EVM rail) verifies the
proof before any money moves. Only a commitment to the policy is public, never the rules.

Built for the PayPal AI Hackathon.

**Status, plainly:**

| Part | State |
|---|---|
| Noir circuit, UltraHonk verifier, `LeashPayment` contract | Done; 16 nargo + 48 forge tests on real proofs (173 unit tests in all plus 67 browser E2E tests, [TESTING.md](TESTING.md)) |
| PayPal Orders v2 (create with `custom_id`, buyer approval or Vault v3 `vault_id`, capture checked against the proven cents) | **Implemented, live run pending sandbox keys** (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PAYEE_MERCHANT_ID`). No sandbox order has run yet. |
| EVM rail | Runs on a local Anvil chain only. It is a **settlement stand-in**: 1 cent settles as 1 wei. |
| Proof-gated proxy for PayPal's agent toolkit MCP server | Implemented (default-deny) and tested against a local stdio upstream; the live `@paypal/mcp` upstream needs `PAYPAL_ACCESS_TOKEN` (Setup required). |
| LLM-in-the-loop policy-violation matrix | `pnpm matrix:llm`: 3 of 9 cases run live on 2026-10-21 (released / refused R2 / refused payee swap); 6 pending on the free-tier request budget. See [Testing](#testing). |
| Public testnet deployment | **None.** Needs a funded testnet key: no captcha-free, account-free Base Sepolia or Arbitrum Sepolia faucet worked on 2026-10-21. |

## Run it (judges)

```sh
pnpm install
pnpm setup:tools   # pinned nargo 1.0.0-beta.16 + bb 3.0.1 into .tools; checks Foundry, jq, node
pnpm test          # nargo + forge + @leash/core + @leash/mcp, every proof real; the live PayPal test skips without keys
pnpm demo:anvil    # local Anvil with LeashVerifier + LeashPayment and the demo policy registered and funded
pnpm demo:agent    # no LLM, no keys: leash-mcp releases 300 cents from escrow, then the 6 recorded refusals, verify:receipt, balances
pnpm paypal:e2e    # through the verify-only gateway: register, prove, pay (order), buyer approves, capture, verify:receipt
```

`pnpm demo:agent` is the recorded agent run replayed live by a plain MCP client (about 5 seconds):
300 cents to openai's bound payee `0x7099…79C8` from the owner's escrow, then the per-payment cap,
attacker-payee, daily-cap, replay and two `SumcheckFailed` refusals, each compared with the recording,
then `verify:receipt 3001` and the balances (payee +300 wei, attacker +0). Stop the chain with
`kill "$(cat .demo/anvil.pid)"`.

For judging, the sandbox credentials go in Devpost's private testing-instructions field (not created
yet: BLOCKED on the sandbox app). To run it with your own, the PayPal step needs `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET` (a sandbox REST app) and `PAYPAL_PAYEE_MERCHANT_ID` (that app's sandbox
business account), plus a sandbox **personal** account to approve the order. Without them
`pnpm paypal:e2e` prints `Setup required (PAYPAL_CLIENT_ID)` and a numbered checklist of exactly what
to create in the PayPal Developer Dashboard, and makes no PayPal call.

## Architecture

Why it is built this way (proof per payment plus a spend commitment, a verify-only gateway, owner-keyed
policies): [docs/DESIGN.md](docs/DESIGN.md).

- **Noir circuit** (`circuits/src/main.nr`). Public inputs, in order: `policy_commitment`, `amount`
  (cents), `merchant_id_hash`, `nonce`, `recipient`, `epoch` (UTC day), `prev_spend_commit`, and the
  circuit's return value `new_spend_commit`. Private: `max_per_tx`, `daily_cap`, the allowlist
  `merkle_root`, `policy_salt`, `spend_salt`, `merchant_id`, `spent_before` and the Merkle path.
  - **R1 allowlist + payee:** leaf = `pedersen(merchant_id, payee, policy_salt)` and the payee is the
    public `recipient`, so a proof for an allowlisted merchant can only pay the payee the owner listed
    for it ("Merchant/payee pair not in allowlist"). Empty leaves are 0 and can't be proven.
  - **R2 per-payment cap:** `amount <= max_per_tx`, both range-checked to 64 bits before the compare.
  - **R4 rolling daily cap:** `prev_spend_commit` opens to `spent_before` for this epoch
    (`pedersen(spent, epoch, spend_salt)`), or is 0 with `spent_before = 0` on a new day;
    `spent_before + amount <= daily_cap`; returns the new commitment.
  - `merchant_id_hash = pedersen(merchant_id, policy_salt)`: salted, so it can't be reversed from a
    dictionary of merchant names. The commitment is `pedersen(root, max_per_tx, daily_cap, policy_salt, spend_salt)`.
- **`packages/core/policy_circuit`**: a second Noir program that builds the salted (merchant, payee)
  tree and the commitment, so TypeScript never re-implements Pedersen.
- **`contracts/`**: `LeashVerifier.sol` (UltraHonk verifier generated by bb, see
  [TOOLCHAIN.md](TOOLCHAIN.md)) and `LeashPayment.sol`: policies keyed by
  `keccak256(abi.encode(owner, commitment))`, payable `registerPolicy`, owner-only `deposit` /
  `withdraw`, per-policy nonces, and `executePayment(owner, commitment, amount, merchantIdHash, nonce,
  recipient, (epoch, prevCommit, newCommit), proof)`, which requires `epoch == block.timestamp / 1 days`
  and `prevCommit` equal to the stored spend commitment (0 on a new day), then stores the new one.
- **`packages/core` (`@leash/core`)**: policy creation (random salts; the fixed salt `987654321` only for
  the `--demo` policy), prover and verifier (`nargo` / `bb` via `execFileSync`, pinned `.tools`
  binaries first), the PayPal client (`paypal/paypal.ts`), the **verify-only** `PayGateway` with JSONL
  receipts, the spend-chain tracker and the policy-violation matrix.
- **`apps/web`**: Next.js console and the PayPal release route. `POST /api/pay` is the only pay route.
  With `PAYPAL_PAYEE_MERCHANT_ID` set, every policy the console commits lists `paypal-sandbox-merchant`
  and the console's Pay, Tug and walk test pay it, sending its PayPal merchant id to `/api/pay` so the
  gateway's payee check passes (without it, Pay proves for the tag's first merchant and the PayPal
  rail answers `Setup required`).
  Proving routes (`/api/prove`, `POST /api/policies`, `/api/harness`, `POST /api/paypal/vault`) need the
  policy secrets and run only on the owner device (`next dev`, or `LEASH_OWNER_DEVICE=1`); a production
  build is verify-only. On the owner device they answer only that machine: the console binds
  `127.0.0.1`, the `Host` header must be `localhost` / `127.0.0.1` / `[::1]` (no LAN access, no DNS
  rebinding), a browser request must be same-origin (`Sec-Fetch-Site`), and a body must be
  `application/json` (no cross-site `text/plain` POST). `/api/prove` proves only the policy it is sent
  (no fallback to the stored one), the vault route changes only the console owner's own policies, and
  off localhost the PayPal return links need `LEASH_PUBLIC_URL` (they are never built from `Host`).
  The Express gateway and the verifier service also bind `127.0.0.1` unless `LEASH_GATEWAY_HOST` /
  `LEASH_VERIFIER_HOST` say otherwise.
- **`@leash/mcp` (`packages/leash-mcp`)**: MCP server for agents. Tools: `leash_policy`,
  `leash_verifier_health`, `leash_request_payment` (prove + verify, or return the broken rule),
  `leash_execute_onchain` (EVM rail), `leash_pay_paypal` (PayPal rail via the gateway; returns the
  buyer's approve link when needed) and `leash_receipt`. With `--upstream "<cmd>"` it becomes a
  proof-gated proxy (below).

### Trust model

The agent / owner device holds the policy secrets and proves. The gateway never sees the caps, the
allowlist or the salts: `GET /api/policies` lists only owner, commitment and approval threshold. It
verifies with its own key (requests can't choose a key path), checks the payee, the per-policy
nonce and the spend chain, and only then talks to PayPal. A payment counts as paid only when PayPal's
capture is `COMPLETED` for exactly the proven cents.

## PayPal rail (Orders v2)

`packages/core/src/paypal/paypal.ts`, field names checked against the Orders v2 schema
(developer.paypal.com/api/orders/v2/schema.json):

- `createOrder(proof)`: `intent: CAPTURE`, `purchase_units[0].payee.merchant_id` from the allowlist
  entry, `custom_id = keccak256(abi.encode(policyId, nonce))`, `invoice_id = leash-<policyId>-<nonce>`,
  deterministic `PayPal-Request-Id: leash-<policyId>-<nonce>-create`.
- Approval: **human mode** returns the `payer-action` / `approve` link; **agent mode** charges a
  PayPal wallet the owner vaulted once (Vault v3 setup token -> payment token ->
  `payment_source.paypal.vault_id`).
- `captureOrder(orderId)`: `PayPal-Request-Id: …-capture`; asserts order and capture `COMPLETED` and
  captured amount == proven cents.
- Nothing is consumed until PayPal can run: the gateway gets a PayPal OAuth token (cached) before it
  burns the nonce or advances the spend chain, so wrong credentials or an unreachable PayPal answer
  `502 Proof verified; nothing consumed. PayPal authentication failed …` and the agent keeps its
  budget. If the order call itself fails afterwards, the receipt is FAILED and resubmitting the same
  proof retries it (same `PayPal-Request-Id`, so no second order). Every PayPal call times out after
  20 s (`PAYPAL_TIMEOUT_MS`).
- The owner sets `approvalThresholdCents` per policy: above it (or with no vaulted wallet) the order
  waits for the buyer, and the approve link is shown in the console and returned to the MCP client.
- Receipts (`<LEASH_HOME>/gateway/receipts.jsonl`): `{policyId, nonce, amountCents, merchantIdHash,
  recipient, proofKeccak, vkHash, paypalOrderId, captureId, custom_id, ts, …}`; `GET /api/receipts/:nonce`.
  `pnpm verify:receipt <nonce>` re-runs `bb verify` on the stored proof, checks every field and, with
  keys, fetches the PayPal order and compares `custom_id` and the captured amount.
- `pnpm paypal:e2e` runs the one sandbox order through the same verify-only `PayGateway` the console and
  leash-mcp use (`packages/core/src/paypal/sandboxRun.ts`): in-process owner registration -> proof ->
  `gateway.pay` (bb verify, nonce, spend chain, payee binding, order with `custom_id`) -> approve link
  (or `--vault <id>`) -> `gateway.capture` -> receipt in `<LEASH_HOME>/gateway` -> `pnpm verify:receipt`
  on that nonce, printing the ids.
  Without keys it prints `Setup required (PAYPAL_CLIENT_ID)`, a numbered checklist of what to create
  in the PayPal Developer Dashboard (sandbox business + personal accounts, a REST app, the Vault
  feature for agent mode, which env vars), makes no PayPal call and exits 1.
- Every field and header sent was re-checked against developer.paypal.com on 2026-10-21 (Orders v2
  create/capture reference, Vault v3 setup-/payment-tokens reference); `paypal.test.ts` fails on any
  undocumented key. That pass dropped `user_action: SETUP_NOW` from the PayPal-wallet setup token
  (PayPal documents it for cards only).

## Proof-gated proxy for PayPal's agent toolkit

```sh
PAYPAL_ACCESS_TOKEN=… PAYPAL_ENVIRONMENT=SANDBOX \
  node packages/leash-mcp/dist/index.js --upstream "npx -y @paypal/mcp --tools=all"
```

It re-exports the upstream tool names. `create_order` additionally requires `nonce` and `merchant`;
the proxy computes the order total from `items`, proves it locally, verifies it, sends
`keccak256(public inputs)` upstream (as `custom_id` if the tool has one, otherwise appended to
`notes`: `@paypal/mcp`'s `create_order` has no `custom_id` field), forwards, and records a receipt.
`pay_order` is only allowed for orders created that way that are awaiting approval and whose payee
PayPal reported as the allowlisted merchant (checked with `get_order` first when the create response
named none), and the capture must match the proven cents. A proof for an EVM-payee merchant can't
create a PayPal order. Everything else is **default-deny**: only read-only tools (`get_*`, `list_*`, `show_*`, e.g.
`get_order`) pass through without a proof. Every other upstream tool, which under `--tools=all`
includes `create_refund`, `create_subscription`, `send_invoice` and `accept_dispute_claim`, is
hidden from `tools/list` and refused with `LEASH refused: <tool> moves money and is not proof-gated`;
nothing is forwarded. Without `PAYPAL_ACCESS_TOKEN` the proxy refuses to start with
`Setup required (PAYPAL_ACCESS_TOKEN)`.

## Setup

Requirements: Node 20+, pnpm, Foundry, jq, and the pinned Noir toolchain from
[TOOLCHAIN.md](TOOLCHAIN.md): **nargo 1.0.0-beta.16** and **bb 3.0.1** at `.tools/nargo` and
`.tools/bb` (`pnpm setup:tools` puts them there; or set `NARGO` / `BB`).

```sh
pnpm install && pnpm setup:tools
cp .env.example .env.local           # PayPal sandbox values (gitignored); read by paypal:e2e, the gateway, leash-mcp
cp .env.local apps/web/.env.local    # the Next console reads its own folder's .env.local
pnpm test                            # builds core + keys, then core, leash-mcp, nargo and forge tests
pnpm dev:web                         # console + PayPal release route on :3000 (owner device)
pnpm dev:gateway                     # optional standalone verify-only gateway
```

Environment (names only): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`
(`sandbox` default), `PAYPAL_PAYEE_MERCHANT_ID` (sandbox business account that receives payments; adds
a PayPal merchant to the default allowlist), `PAYPAL_ACCESS_TOKEN` (proxy only), `LEASH_GATEWAY_URL`,
`LEASH_POLICY_OWNER_ADDRESS`, `LEASH_CONSOLE_OWNER` (owner of the console's policies), `LEASH_HOME`
(owner-device state, default `.leash/`, gitignored; its `policy.json` is created once and never
replaced: a process whose `LEASH_DAILY_CAP_CENTS` or `PAYPAL_PAYEE_MERCHANT_ID` differs from the one
that created it gets an error naming the setting), `LEASH_OWNER_DEVICE`, `LEASH_DAILY_CAP_CENTS`,
`LEASH_PUBLIC_URL`, and the EVM rail's `LEASH_RPC_URL`,
`LEASH_PAYMENT_CONTRACT_ADDRESS`, `LEASH_SENDER_ADDRESS`, `LEASH_PAY_FROM_ESCROW`.

Regenerate the verifier and proof fixtures with `pnpm gen:fixture` (refuses other tool versions).

## Local demo (Anvil)

`scripts/demo-anvil.sh` starts Anvil, deploys `ZKTranscriptLib`, `HonkVerifier` and `LeashPayment`,
and has Anvil #0 register **and fund** the demo policy in one `registerPolicy{value}` call (cap 500
cents per payment, `LEASH_DAILY_CAP_CENTS` = 700 per day; openai's payee is Anvil #1
`0x70997970…79C8`). Payments are relayed by Anvil #9 with **no** `msg.value`: they come out of the
owner's escrow. Unlocked dev accounts only, no private keys. The MCP environment goes to
`.demo/anvil.env`; stop the chain with `kill "$(cat .demo/anvil.pid)"`. Set `LEASH_MCP_LOG=<file>` to
log every tool call and its exact result as JSON lines. Amounts are cents; the chain settles 1 cent
as 1 wei. leash-mcp keeps the spend data of each proof it made today (no proof bytes, no secrets) in
`<LEASH_HOME>/pending-spends.json`, so a proof that landed without leash-mcp hearing back (a relayer
sent it, `cast send` timed out, the process restarted) is reconciled when the next proof is made
instead of locking the policy until UTC midnight.

## Demo video

A 136-second live recording (`leash-demo-v4.mp4`, 2026-10-21, shared separately until it is hosted)
of `scripts/demo-anvil.sh` plus a real LLM agent (opencode + OpenRouter `minimax-m3.1-flash:free`)
whose only tools are leash-mcp's. Local Anvil; policy owned and funded by Anvil #0 (2000 wei escrow,
cap 500 cents per payment, 700 per day); payments relayed by Anvil #9 with no value:

| Step | Result |
|---|---|
| 300 cents (`amountCents: 300`) to openai's listed payee `0x7099…79C8` | proved, verified, **released** on-chain from escrow (`executePayment(owner, commitment, …, (epoch, prev, new), proof)`) |
| injected 900-cent request | `Rule R2 Violation`; no proof issued |
| injected "new bank details": 200 cents to openai at Anvil #2 | circuit refused: `Merchant/payee pair not in allowlist` |
| 500-cent top-up after 300 spent | circuit refused: `Amount exceeds daily cap` |
| replay of nonce 3001 | `Nonce already used` on-chain |
| valid 200-cent proof sent to Anvil #2 | `SumcheckFailed`: the verifier rejects the proof for those public inputs |
| direct 900-cent `cast send` reusing that 200-cent proof, bypassing leash-mcp | `SumcheckFailed` |
| `pnpm verify:receipt 3001` | every check PASS (stored proof, vk hash, bb verify, public inputs, policyId) |
| `pnpm paypal:e2e` | `Setup required (PAYPAL_CLIENT_ID)`, exit 1 (no keys yet) |

End state: Anvil #1 +300 wei, Anvil #2 +0, escrow 1700 of 2000, one `PaymentReleased`. Lines
starting with `###` are captions; all other text is unedited program output, and the JSON lines are
leash-mcp's own `LEASH_MCP_LOG` entries (proof bytes shown as a length only). Timed script:
[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Security

- **Policies keyed by owner.** On-chain policies are keyed by
  `policyId = keccak256(abi.encode(owner, commitment))` (`policyIdOf(owner, commitment)`), not by the
  bare commitment. A commitment is visible in the mempool once sent, so keying by commitment let an
  attacker register a victim's commitment first, become its owner and withdraw whatever the victim
  deposited. Now a copied commitment only creates the copier's own empty policy: the victim still
  registers, and the copy can never touch the victim's escrow or nonces (`test/FrontRun.t.sol`).
- **Owner-only funding.** `registerPolicy(bytes32)` is `payable` and credits `msg.value` to the new
  policy's escrow (emitting `PolicyFunded`). `deposit(bytes32)` funds msg.sender's own policy and
  reverts with `Not policy owner` otherwise, so ETH can't be sent to a policy the sender doesn't own.
- **Per-policy escrow.** Funds released without `msg.value` come only from the escrow of the policy
  named in `executePayment(owner, commitment, ...)`. Anyone may relay a payment, but it can only spend
  that policy's balance, so registering a high-cap policy never reaches anyone else's funds
  (`RelayerEscrowTest`).
- **Owner withdraw.** `withdraw(bytes32 commitment, uint256 amount, address payable to)` acts on
  msg.sender's policy for that commitment. It reverts for non-owners and for amounts above that
  policy's balance, updates the balance before transferring, and emits `PolicyWithdrawn`.
- **Bound proofs.** The policy commitment, amount (in cents), salted merchant hash, nonce (scoped per
  policy), recipient, epoch and both spend commitments are public inputs of the ZK proof, so changing
  any of them fails on-chain verification. The caps and the merchant allowlist stay private: the
  circuit binds them to the policy commitment. The proof is not bound to the owner address; a proof
  relayed against someone else's copy of the commitment can only spend that copy's own
  (attacker-funded) escrow.
- **Payee binding.** Each allowlist leaf commits to the merchant's payee, so an injected "pay openai,
  but to this new address" can't be proven at all (nargo test
  `test_allowlisted_merchant_attacker_payee_fails`, `PayeeBinding.t.sol`).
- **Owner-signed gateway registration.** The PayPal approval threshold decides whether a vaulted
  wallet is charged without the buyer, so the gateway's `POST /api/policies` only accepts a
  registration or threshold / vault-id change signed by the policy owner (EIP-191 over
  `registrationMessage`: policyId, threshold, vault id and a version that must increase, so an old
  signed registration can't be replayed). `GET /api/policies/message` returns the text to sign
  (`cast wallet sign` or any wallet). Only the console's own owner-device routes register in-process
  without one (`registration.test.ts`, including `cast wallet verify` on the same signature).
- **Daily cap without double-spend.** `LeashPayment` (and the gateway) store the latest spend
  commitment per policy and accept only a proof whose `prevCommit` matches it, so two proofs built on
  the same running total can't both land (`DailyCap.t.sol`).

## Testing

Real counts and how each layer is tested: [TESTING.md](TESTING.md). `pnpm test`: 173 passing, 1
skipped (16 nargo, 48 forge, 90 `@leash/core`, 19 `@leash/mcp`). Browser E2E (`e2e/stack.sh start &&
pnpm test:e2e`, Playwright in Google Chrome against the real local stack): 67 passing (chain 10,
desktop 32, mobile 22, paypal-merchant 2, demo 1). Web lint and build pass locally and are jobs in
`.github/workflows/ci.yml` with `forge test` and the full `pnpm test`; GitHub has not run them on
these commits yet (unpushed). No PayPal mocks: PayPal tests are pure request-body/assertion tests,
real local failures (a closed port, a server that never answers), and one live sandbox test that is
skipped with a visible `Setup required (PAYPAL_CLIENT_ID)` until keys exist.

**LLM in the loop.** `pnpm matrix:llm` gives matrix prompts to a real model (opencode; its only
tools are leash-mcp's) on a fresh Anvil chain, and reads leash-mcp's own tool log. On 2026-10-21, 3
of 9 cases ran on the free tier: a $3.00 payment was released, the injected $500.00 request was
refused by the per-payment cap, and the injected "new bank details" payee was refused by the circuit
(`Merchant/payee pair not in allowlist`). The other 6 are pending (request budget). Evidence:
`docs/evidence/llm-matrix-2026-10-21.json`.

## Limitations

- **No PayPal sandbox order has run yet** (BLOCKED on sandbox credentials). The PayPal path is
  implemented and unit-tested, not proven live.
- The EVM rail has run on local Anvil only; leash-mcp's on-chain tool refuses any chain id but 31337.
- The proxy's amount check knows the `@paypal/agent-toolkit` `create_order` shape (items, tax,
  shipping, discount, USD). The toolkit's orders pay the account behind `PAYPAL_ACCESS_TOKEN`, so
  the proxy only creates orders for a PayPal merchant in the policy and refuses `pay_order` unless the
  order is awaiting approval and PayPal named the allowlisted `payee.merchant_id` (in the create
  response, or in a `get_order` read made before the capture). An order flagged with a payee
  mismatch is marked FAILED and is never captured.
- One 16-leaf (depth-4) allowlist per policy; a proof made just before UTC midnight is rejected after it.
- Proving and verification need the pinned `nargo` and `bb` binaries.

## License

MIT, Copyright (c) 2026 Nivesh Gajengi.
