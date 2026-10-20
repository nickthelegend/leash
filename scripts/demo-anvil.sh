#!/usr/bin/env bash
# Local LEASH chain for demos: starts Anvil, deploys LeashVerifier + LeashPayment, registers the
# default policy commitment, and writes the leash-mcp environment to .demo/anvil.env.
# Sends from Anvil's unlocked dev account #0, so no private key is used or stored anywhere.
# Stop the chain afterwards with: kill "$(cat .demo/anvil.pid)"
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; mkdir -p .demo
export PATH="$ROOT/.tools:$PATH"
RPC="http://127.0.0.1:${ANVIL_PORT:-8545}"
SENDER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266                             # Anvil account #0 (unlocked)
PAYEE=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                              # Anvil account #1

anvil --port "${ANVIL_PORT:-8545}" --code-size-limit 200000 --silent > .demo/anvil.log 2>&1 &
echo $! > .demo/anvil.pid
for _ in $(seq 30); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
cast block-number --rpc-url "$RPC" >/dev/null || { echo "anvil did not start" >&2; exit 1; }

FROM=(--unlocked --from "$SENDER")
cd contracts
# HonkVerifier links the external library ZKTranscriptLib, so deploy that first.
LIB=$(forge create src/LeashVerifier.sol:ZKTranscriptLib --rpc-url "$RPC" "${FROM[@]}" --broadcast --json | jq -er .deployedTo)
VERIFIER=$(forge create src/LeashVerifier.sol:HonkVerifier --libraries "src/LeashVerifier.sol:ZKTranscriptLib:$LIB" \
  --rpc-url "$RPC" "${FROM[@]}" --broadcast --json | jq -er .deployedTo)
PAYMENT=$(forge create src/LeashPayment.sol:LeashPayment --rpc-url "$RPC" "${FROM[@]}" --broadcast --json --constructor-args "$VERIFIER" | jq -er .deployedTo)
cd "$ROOT/packages/core"
COMMITMENT=$(node -e "process.stdout.write(require('./dist').getDefaultPolicy().policyCommitment)")
cast send "$PAYMENT" 'registerPolicy(bytes32)' "$COMMITMENT" --rpc-url "$RPC" "${FROM[@]}" >/dev/null
cd "$ROOT"
cat > .demo/anvil.env <<ENV
LEASH_RPC_URL=$RPC
LEASH_PAYMENT_CONTRACT_ADDRESS=$PAYMENT
LEASH_SENDER_ADDRESS=$SENDER
LEASH_RECIPIENT_ADDRESS=$PAYEE
ENV
echo "anvil $RPC  verifier $VERIFIER  LeashPayment $PAYMENT"
echo "policy commitment $COMMITMENT registered; env in .demo/anvil.env"
