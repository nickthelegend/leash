# LEASH demo script: target for the PayPal-first re-record (2:00)

This is the **target** timing for the next recording, not a description of an existing cut. The
recording that exists today (`leash-demo-v4.mp4`, 2026-10-21) is **136 s** long, Anvil only, and runs
the same on-chain beats (policy set, 300-cent release, R2, payee swap, daily cap, replay,
SumcheckFailed) at its own pace; it shows the PayPal rail only as `Setup required`. The re-record
waits for a real sandbox order (BLOCKED on `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_PAYEE_MERCHANT_ID` and a sandbox personal buyer login) and must stay under 3:00 with the
PayPal capture visible in the first minute.

Timed script for the submission video. Rules for the recording: every line on screen is real program
output except lines starting with `###`, which are captions printed by the recording script. Never
edit output text; redact with a visible box or add a caption instead. Amounts are cents everywhere
(300 = $3.00). The EVM leg runs on local Anvil and settles 1 cent as 1 wei (a settlement stand-in).

| Time | Beat | What is on screen | What the viewer must see |
|---|---|---|---|
| 0:00–0:12 | Problem | Caption: an injected agent with a wallet will pay whatever the prompt says. | LEASH proves every payment is inside a secret policy before money moves. |
| 0:12–0:45 | PayPal order + receipt | `pnpm paypal:e2e`: proof verified by bb, Orders v2 create (300 cents), the sandbox buyer approves, capture; then `pnpm verify:receipt <nonce>`. | Order id, approve link, capture id `COMPLETED` for exactly 300 cents, then `verify-receipt` fetching the order and matching `custom_id`. Until sandbox keys exist this beat shows `Setup required (PAYPAL_CLIENT_ID)` (shown, not hidden) and the video can't meet the first-minute rule. |
| 0:45–0:55 | Policy set | `scripts/demo-anvil.sh`: deploy verifier + LeashPayment; Anvil #0 registers and funds the policy (2000 wei escrow) in one call. | Only the commitment is printed; cap 500/payment and 700/day are caption text, not on chain. openai's payee is Anvil #1 `0x7099…79C8`. |
| 0:55–1:10 | Legit pay verifies on chain | Agent (opencode + OpenRouter) calls `leash_request_payment` openai **300** cents, nonce 3001, then `leash_execute_onchain`. | `approved: true`, `amountCents: 300`, recipient `0x70997970…79c8`; `released: true`, paid from escrow by the relayer (no value sent). |
| 1:10–1:20 | Injected over-cap refused | Agent asks for 900 cents. | `Rule R2 Violation` — no proof exists. |
| 1:20–1:32 | Attacker payee refused | Agent asks for 200 cents to openai but payee `0x3C44…93BC` (Anvil #2). | `Circuit refused the payment (constraint failed): 'Merchant/payee pair not in allowlist'` — the circuit itself can't build a witness. |
| 1:32–1:42 | Daily cap refused | Agent asks for 500 cents (300 already spent, 700/day cap). | `'Amount exceeds daily cap'` from the circuit. |
| 1:42–1:50 | Replay rejected | Agent re-submits nonce 3001. | `Nonce already used` from LeashPayment. |
| 1:50–1:57 | Redirected / tampered calls rejected | Agent proves 200 cents (nonce 3005) and submits it to Anvil #2; then a direct `cast send` reuses that unspent proof but claims 900 cents. | Both `SumcheckFailed`; caption: SumcheckFailed = the verifier rejecting the proof, not a crash. |
| 1:57–2:00 | Close | Balances: payee (Anvil #1) +300 wei, Anvil #2 +0; one `PaymentReleased` event. | Caption: replay vs live — this is a live run; the JSON lines are leash-mcp's own `LEASH_MCP_LOG`. |

Captions to include verbatim:
- "Live run: every line not starting with ### is unedited program output."
- "Amounts are in cents (300 = $3.00); the demo chain settles 1 cent as 1 wei."
- "SumcheckFailed = the on-chain verifier rejecting the proof for those public inputs."
- "The JSON lines are the exact tool results from LEASH_MCP_LOG, not the agent's summary."

The PayPal beat comes first (0:12–0:45) so the capture is on screen inside the first minute; the
on-chain refusals follow.
