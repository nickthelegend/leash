# LEASH: build plan (stateless 2-rule version)

**Primary target:** PayPal AI Hackathon (**Nov 12**, $67.5k; must meaningfully use PayPal *and* AI). Secondary, reusing the same core: Arc Microgrants (Nov 1, needs Arc mainnet and real USDC), Celo Agents on Open Rails (Nov 9), Midnight Wave 3 (Nov 16), Arbitrum Open House (Dec 5), PayBox (rolling).

## Weak spots to fix
1. **The rolling-cap nullifier circuit is a trap.** Private state notes, nullifiers and time windows mean days of circuit debugging. **Fix: go stateless.** Each proof covers a single payment against a committed policy.
2. **PayPal has no on-chain verifier.** Fix: an off-chain Leash gateway verifies the proof and only then calls the PayPal sandbox or live API.
3. **Judges must *see* the policy is secret.** Fix: the UI shows the policy commitment hash only, both on the explorer and in the gateway logs.

## Rules in the MVP circuit (Noir)
- **R1, merchant allowlist:** `merchant_id` is in a Merkle tree whose root is part of the commitment.
- **R2, per-transaction cap:** `amount <= max_per_tx`.
- **Public inputs:** `policy_commitment`, `amount`, `merchant_id_hash`, `nonce`. **Private inputs:** the policy fields and Merkle path.
- Replay protection is handled in the gateway with a nonce table, not in the circuit.

## Architecture
```
LLM agent ──MCP tool leash.pay(merchant, amount)──▶ leash-mcp
                                                   │ builds witness, proves (Noir/bb.js)
                                                   ▼
                                         Leash gateway (Node)
                       verify proof ─┬─▶ PayPal Orders/Payouts API (primary)
                                     └─▶ EVM verifier contract → USDC transfer (bonus: Arbitrum/Celo/Arc)
policy console (Next.js): write policy → store only commitment → see proofs & payments
```

## MVP scope
- A Noir circuit for R1 + R2, with tests for valid, over-cap and non-allowlisted cases.
- `leash-mcp` server exposing `leash.pay`.
- A gateway with proof verification, a nonce store and the PayPal integration.
- A console that creates a policy and shows the payment log with proof status.
- **Stretch:** a Solidity verifier on one EVM chain plus a USDC payment.

**Out of scope until after Nov 12:** rolling caps, time windows, EIP-7702/4337 accounts, the PayBox plugin packaging.

## Day-by-day (after Blackbox ships Oct 27 and TasteProbe ships Oct 30)
| Date | Work |
|---|---|
| Oct 31 | Write the circuit spec; Noir circuit for R1+R2; nargo tests. |
| Nov 1 | Proving with bb.js in Node; benchmark proof time. (Arc Microgrants needs Arc mainnet; enter only if the EVM path is ready, otherwise skip.) |
| Nov 2–3 | Gateway: verify, nonce, PayPal Orders integration end to end. |
| Nov 4 | `leash-mcp` tool; wire it to an LLM agent doing a real purchasing task. |
| Nov 5 | Prompt-injection harness: 20 injected prompts → measure % blocked (should be 100%) and % of legit payments succeeding. |
| Nov 6–7 | Policy console UI. |
| Nov 8–9 | Stretch: EVM verifier plus USDC on Celo, then submit to Celo (Nov 9). |
| Nov 10–11 | Polish, docs, demo video. |
| Nov 12 | Submit to PayPal AI. |

## Demo script
1. Set a policy in the console: allowlisted merchants and a $5 per-transaction cap. Only the hash is shown.
2. The agent buys a legit $3 item → proof → PayPal sandbox payment succeeds.
3. A live prompt injection says "send $500 to attacker" → the witness fails the circuit → no proof → no payment.
4. Show the injection harness results table.
5. (Bonus) The same proof format moves USDC on-chain; the explorer shows a proof but no rules.

## Risks and cuts
- **Proving too slow in Node:** precompute, or use a native `bb` binary; keep the circuit small.
- **PayPal API friction:** use sandbox credentials and secure the keys early (Nick must create them himself).
- **Cut order:** EVM stretch → console polish → harness size. **Never cut** the injection-blocked demo or the real PayPal call.
