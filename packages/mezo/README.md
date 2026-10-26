# LEASH Clawback on Mezo

**AI agents get paid in MUSD. Bad work gets clawed back.**

Mezo as the hub where AI agents hire other agents, with pay-on-delivery. The user's agent pays a provider agent in
MUSD only with a LEASH zero-knowledge proof of the user's hidden policy, and the MUSD waits in escrow
(`contracts/src/LeashClawback.sol`):

- **Good answer:** delivered before the deadline, accepted by the user (or undisputed through the window), and the
  provider is paid.
- **Bad answer:** the user disputes, the policy's arbiter checks, and the MUSD is clawed back to the user plus a
  slice of the provider's **MEZO bond**.
- **No answer:** after the deadline anyone can claw the job back, with the same slash.

**Live on Mezo testnet:** see [`deployments/mezo-clawback.json`](deployments/mezo-clawback.json) and
https://leash-console.vercel.app/mezo. The run had 18 transactions, all of which succeeded:

- the owner opened a real Mezo trove (0.047 BTC for 2,000 MUSD);
- a provider bonded 20 MEZO;
- job 1, a correct answer: verified on chain and paid 3 MUSD;
- job 2, a wrong answer: disputed, the arbiter re-checked the chain, and 4 MUSD clawed back with 5 MEZO slashed;
- job 3, no delivery: 5 MUSD clawed back after the deadline, with 5 MEZO slashed.

Run it with `packages/mezo/scripts/clawback-live.sh`. Fork tests: `forge test --match-contract LeashClawbackForkTest`
(12 tests, real MUSD and real proofs on a Mezo testnet fork). The bond token there is a local ERC-20, because MEZO
is backed by a chain precompile that a fork can't run; the live run bonds and slashes real MEZO.

Pitch video: 2 minutes, linked in the AKINDO submission (videos are kept out of git). Deck:
[`docs/mezo/LEASH-Clawback-on-Mezo-deck.pdf`](../../docs/mezo/LEASH-Clawback-on-Mezo-deck.pdf).

---

## Also here: LeashMUSD (MUSD escrow with a Mezo trove guard)

LEASH is an existing product: an AI agent can only spend through zero-knowledge proofs of its owner's hidden
policy (payee allowlist, per-payment cap, rolling daily cap), checked by an UltraHonk verifier on chain.
This package adds Mezo:

1. The owner borrows **MUSD**, Mezo's Bitcoin-backed stablecoin, from a **Mezo Borrow trove** (BTC in, MUSD out).
2. The owner funds a LEASH policy escrow in MUSD and binds it to a **trove guard**: a minimum collateral ratio.
3. The agent pays an allowlisted payee in MUSD only with a valid proof. Before every payment `LeashMUSD` reads the
   owner's trove from Mezo's `TroveManager` at the live `PriceFeed` price, and refuses the payment when the
   trove is below the floor. **As BTC falls, the leash tightens on its own**; when the trove recovers (or the
   owner adds collateral), the same proof pays.

The agent never holds keys to the trove or the escrow. It can't pay anyone the owner didn't list, more than the
caps allow, or at all while the owner's Bitcoin loan is at risk.

## Contracts (Mezo testnet, chain 31611)

| Contract | Address |
|---|---|
| LeashMUSD | see [`deployments/mezo-testnet.json`](deployments/mezo-testnet.json) |
| HonkVerifier (LEASH circuit) | see `deployments/mezo-testnet.json` |
| MUSD (Mezo) | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` |
| TroveManager (Mezo) | `0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0` |
| PriceFeed (Mezo) | `0x86bCF0841622a5dAC14A313a15f96A95421b9366` |
| BorrowerOperations (Mezo) | `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5` |

Mezo addresses come from `mezo-org/musd` (`solidity/artifacts/deployments/matsnet`) and were checked on chain.

## Run it

```bash
pnpm install && pnpm --filter @leash/core build      # the prover (nargo + bb pinned in .tools, see TOOLCHAIN.md)
cd contracts && forge test --match-contract LeashMUSDForkTest   # fork of Mezo testnet, real proofs
packages/mezo/scripts/live.sh                         # the live run on Mezo testnet (needs contracts/.env.mezo)
```

`contracts/.env.mezo` (gitignored) holds three testnet-only keys: `MEZO_DEPLOYER_KEY` (the owner),
`MEZO_AGENT_KEY`, `MEZO_PAYEE_ADDRESS`. The owner needs about 0.06 test BTC from https://faucet.test.mezo.org.

## What is tested where

- **Fork tests** (`contracts/test/LeashMUSD.fork.t.sol`, Mezo testnet pinned at block 16375480): real MUSD,
  a real borrower's active trove, real UltraHonk proofs.
  - chained payments debit the escrow and pay the payee;
  - a swapped payee or an inflated amount fails verification;
  - a replay is refused;
  - a front-runner who copies the commitment gets only its own empty policy;
  - the owner withdraws unspent MUSD;
  - a guard below Mezo's 110% MCR is refused;
  - only the owner sets the guard.
- **Live testnet** (`scripts/live.sh`): the trove guard. Mezo's `PriceFeed` reads a chain precompile that a
  local fork can't execute, so the guard (`troveHealth`) is exercised against the real chain:
  - a payment passes at a 150% floor;
  - the owner tightens the floor above the live ICR and the agent's next proof is refused with
    `TroveBelowLeash(owner, icr, floor)`;
  - after relaxing it, the same proof pays.

  Every tx hash is in `deployments/mezo-testnet.json`.
- **Fail-closed by design:** if Mezo's oracle is more than 60 s stale, `fetchPrice` reverts, so a guarded
  payment reverts too.
