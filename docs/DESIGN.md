# LEASH design notes

Why the shipped design looks the way it does. The code is the reference; this explains the choices.

## A proof per payment, plus a spend commitment

Each payment carries its own UltraHonk proof (Noir, `circuits/src/main.nr`) against a committed policy:

- **R1** the merchant is on the allowlist **and** the payee is the one the owner bound to it (the leaf is
  `pedersen(merchant_id, payee, policy_salt)`, and the payee is the public `recipient`), so "pay openai,
  but to these new bank details" has no witness at all;
- **R2** the amount is at most the per-payment cap (both range-checked to 64 bits);
- **R4** today's running total stays under the daily cap.

The daily cap needs state without revealing the total. The circuit opens the previous spend commitment
`pedersen(spent_before, epoch, spend_salt)` (or 0 on a new UTC day), checks
`spent_before + amount <= daily_cap`, and returns the new commitment as a public output. The verifier
side (LeashPayment on chain, or the gateway) stores only the latest commitment per policy and accepts a
proof only if its `prev_spend_commit` is that one, so two proofs built on the same total can't both land,
and nobody but the owner learns the total. The caps, the allowlist and the salts stay private; only
`pedersen(root, max_per_tx, daily_cap, policy_salt, spend_salt)` is public.

## A verify-only gateway for PayPal

PayPal has no on-chain verifier, so something must check the proof before an order exists. That gateway
never sees the rules or salts: it holds the public registration (owner, commitment, approval threshold,
optional Vault id), the latest spend commitment per policy, and receipts. It verifies with its own key,
checks the nonce, the spend chain and that the proven payee is the PayPal merchant it is about to pay,
gets a PayPal token, and only then consumes the nonce and creates the order with
`custom_id = keccak256(abi.encode(policyId, nonce))`. A payment counts as paid only when PayPal's capture
is `COMPLETED` for exactly the proven cents. Proving happens on the owner's device (leash-mcp, the local
console), which is the only place the secrets live.

## Policies keyed by owner

On chain and at the gateway a policy is `policyId = keccak256(abi.encode(owner, commitment))`, not the
bare commitment. A commitment is public once sent, so keying by it alone let anyone register a victim's
commitment first and become its owner. Keyed by owner, a copied commitment only creates the copier's own
empty policy; escrow, nonces and the spend chain are per policyId, and only the owner can fund or
withdraw. Gateway registrations and threshold changes need the owner's EIP-191 signature with an
increasing version.

## Two rails, one proof system

- **PayPal (Orders v2 + Vault v3):** above the owner's approval threshold the buyer approves the order;
  below it, a wallet the owner vaulted once is charged. `pnpm paypal:e2e` runs one sandbox order through
  the same gateway.
- **EVM (`LeashPayment` on local Anvil):** re-verifies the proof on chain, burns the nonce, checks the
  spend chain and pays exactly the proven amount (1 cent settles as 1 wei: a settlement stand-in) to the
  proven recipient from the owner's escrow; anyone may relay.

## The agent surface

`leash-mcp` gives an MCP agent `leash_request_payment` (prove + verify, or the rule that was broken),
`leash_execute_onchain`, `leash_pay_paypal` and `leash_receipt`. In `--upstream` mode it sits in front of
PayPal's own agent-toolkit MCP server as a default-deny, proof-gated proxy: `create_order` needs a proof
for the order total, `pay_order` only captures a proven order awaiting approval whose payee PayPal
confirmed, read-only tools pass, and every other upstream tool is hidden and refused.
