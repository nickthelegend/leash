#!/usr/bin/env bash
# Local LEASH chain for demos: starts Anvil, deploys LeashVerifier + LeashPayment, registers the
# demo policy commitment (fixed public salt: `--demo`), and writes the leash-mcp environment to
# .demo/anvil.env. Policy: cap 500 cents per payment, LEASH_DAILY_CAP_CENTS (default 700) per day;
# openai's payee is Anvil #1.
# Sends from Anvil's unlocked dev accounts (#0 owner, #9 relayer), so no private key is used or stored.
# Then `pnpm demo:agent` replays the recorded agent run against it with no LLM.
# Stop the chain afterwards with: kill "$(cat .demo/anvil.pid)"
# LEASH_DEMO_DIR (default .demo) and ANVIL_PORT (default 8545) let a second chain run beside the first.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
DEMO_DIR="${LEASH_DEMO_DIR:-.demo}"
case "$DEMO_DIR" in /*) ;; *) DEMO_DIR="$ROOT/$DEMO_DIR" ;; esac
mkdir -p "$DEMO_DIR"
rm -rf "$DEMO_DIR/leash-home"   # leash-mcp state belongs to one chain: a fresh chain starts with none
export PATH="$ROOT/.tools:$PATH"
RPC="http://127.0.0.1:${ANVIL_PORT:-8545}"
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266                              # Anvil account #0: policy owner
RELAYER=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720                            # Anvil account #9: submits payments, sends no value
ESCROW_WEI="${LEASH_ESCROW_WEI:-2000}"
PAYEE=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                              # Anvil account #1 (openai's listed payee)
export LEASH_DEMO=1 LEASH_DAILY_CAP_CENTS="${LEASH_DAILY_CAP_CENTS:-700}"

# leash-mcp proves for the EVM verifier, which needs the compiled circuit and its EVM vk (rebuilt
# every run so a stale key from an older circuit can't linger).
(cd circuits && nargo compile && bb write_vk -b target/leash_circuit.json -t evm -o target/vk_evm) >/dev/null 2>&1
(cd packages/core/policy_circuit && nargo compile) >/dev/null 2>&1

anvil --host 127.0.0.1 --port "${ANVIL_PORT:-8545}" --code-size-limit 200000 --silent > "$DEMO_DIR/anvil.log" 2>&1 &
echo $! > "$DEMO_DIR/anvil.pid"
for _ in $(seq 30); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
cast block-number --rpc-url "$RPC" >/dev/null || { echo "anvil did not start" >&2; exit 1; }

FROM=(--unlocked --from "$OWNER")
cd contracts
# Policies are keyed by (owner, commitment): OWNER registers and owns the demo policy.
# HonkVerifier links the external library ZKTranscriptLib, so deploy that first.
LIB=$(forge create src/LeashVerifier.sol:ZKTranscriptLib --rpc-url "$RPC" "${FROM[@]}" --broadcast --json | jq -er .deployedTo)
VERIFIER=$(forge create src/LeashVerifier.sol:HonkVerifier --libraries "src/LeashVerifier.sol:ZKTranscriptLib:$LIB" \
  --rpc-url "$RPC" "${FROM[@]}" --broadcast --json | jq -er .deployedTo)
PAYMENT=$(forge create src/LeashPayment.sol:LeashPayment --rpc-url "$RPC" "${FROM[@]}" --broadcast --json --constructor-args "$VERIFIER" | jq -er .deployedTo)
cd "$ROOT/packages/core"
COMMITMENT=$(node -e "process.stdout.write(require('./dist').getDefaultPolicy({ demo: true }).policyCommitment)")
# Escrow-funded: the owner registers and funds the policy in one call (registerPolicy{value}); the
# relayer then pays merchants from that escrow without sending any value itself.
cast send "$PAYMENT" 'registerPolicy(bytes32)' "$COMMITMENT" --value "$ESCROW_WEI" --rpc-url "$RPC" "${FROM[@]}" >/dev/null
cd "$ROOT"
cat > "$DEMO_DIR/anvil.env" <<ENV
LEASH_RPC_URL=$RPC
LEASH_PAYMENT_CONTRACT_ADDRESS=$PAYMENT
LEASH_SENDER_ADDRESS=$RELAYER
LEASH_POLICY_OWNER_ADDRESS=$OWNER
LEASH_PAY_FROM_ESCROW=1
LEASH_RECIPIENT_ADDRESS=$PAYEE
LEASH_DEMO=1
LEASH_DAILY_CAP_CENTS=$LEASH_DAILY_CAP_CENTS
ENV
echo "anvil $RPC  verifier $VERIFIER  LeashPayment $PAYMENT"
echo "demo policy commitment $COMMITMENT registered by $OWNER with $ESCROW_WEI wei escrow (cap 500/payment, $LEASH_DAILY_CAP_CENTS/day)"
echo "relayer $RELAYER submits payments with no value; env in ${DEMO_DIR#$ROOT/}/anvil.env"
echo "next: pnpm demo:agent   (stop the chain: kill \"\$(cat ${DEMO_DIR#$ROOT/}/anvil.pid)\")"
