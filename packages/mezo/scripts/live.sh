#!/usr/bin/env bash
# LEASH on Mezo testnet, end to end with real transactions (chain 31611):
#   1. deploy the HonkVerifier and LeashMUSD
#   2. the owner opens a Mezo Borrow trove: BTC collateral in, MUSD out
#   3. the owner registers a hidden ZK policy, funds it with 10 MUSD, and sets the trove guard to 150%
#   4. the agent pays 3.00 MUSD to the allowlisted payee with a proof          -> PaymentReleased
#   5. the owner tightens the guard above the trove's live ICR; the agent's next proof is refused on chain
#   6. the owner relaxes the guard; the same 4.00 MUSD proof pays            -> PaymentReleased
# Keys come from contracts/.env.mezo (gitignored) and are never printed. Steps already done are skipped.
# Every address and tx hash lands in packages/mezo/deployments/mezo-testnet.json.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
export PATH="$ROOT/.tools:$PATH"
set -a; . contracts/.env.mezo; set +a
R=${MEZO_RPC_URL:-https://rpc.test.mezo.org}
MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
BORROWER_OPS=0xCdF7028ceAB81fA0C6971208e83fa7872994beE5
TROVE_MANAGER=0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0
PRICE_FEED=0x86bCF0841622a5dAC14A313a15f96A95421b9366
HINTS=0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6
SORTED=0x722E4D24FD6Ff8b0AC679450F3D91294607268fA
OWNER=$MEZO_DEPLOYER_ADDRESS AGENT=$MEZO_AGENT_ADDRESS PAYEE=$MEZO_PAYEE_ADDRESS
COLL=${MEZO_TROVE_BTC:-0.055ether}   # ~0.055 BTC for 2,000 MUSD (+200 gas compensation +fee): ICR ~200%
DEBT=2000000000000000000000
DEP=packages/mezo/deployments/mezo-testnet.json
mkdir -p "$(dirname "$DEP")"
[ -f "$DEP" ] || echo '{"chainId":31611,"txs":{}}' > "$DEP"
set_dep() { local t; t=$(mktemp); jq "$1" "$DEP" > "$t" && mv "$t" "$DEP"; }
get_dep() { jq -r "$1 // empty" "$DEP"; }
tx() { jq -r '.transactionHash'; }
send() { cast send --rpc-url "$R" --json "$@"; }
log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
uint() { awk '{print $1}'; }

log "owner $OWNER  BTC $(cast balance "$OWNER" --rpc-url "$R" --ether)"

# 1. contracts
if [ -z "$(get_dep .leashMUSD)" ]; then
  cd contracts
  LIB=$(forge create src/LeashVerifier.sol:ZKTranscriptLib --rpc-url "$R" --private-key "$MEZO_DEPLOYER_KEY" --broadcast --json | jq -er .deployedTo)
  VERIFIER=$(forge create src/LeashVerifier.sol:HonkVerifier --libraries "src/LeashVerifier.sol:ZKTranscriptLib:$LIB" \
    --rpc-url "$R" --private-key "$MEZO_DEPLOYER_KEY" --broadcast --json | jq -er .deployedTo)
  OUT=$(forge create src/LeashMUSD.sol:LeashMUSD --rpc-url "$R" --private-key "$MEZO_DEPLOYER_KEY" --broadcast --json \
    --constructor-args "$VERIFIER" "$MUSD" "$TROVE_MANAGER" "$PRICE_FEED")
  LEASH=$(echo "$OUT" | jq -er .deployedTo)
  BLOCK=$(cast receipt "$(echo "$OUT" | jq -er .transactionHash)" blockNumber --rpc-url "$R")
  cd "$ROOT"
  set_dep ".zkTranscriptLib=\"$LIB\" | .verifier=\"$VERIFIER\" | .leashMUSD=\"$LEASH\" | .deployBlock=$BLOCK | .txs.deployLeashMUSD=\"$(echo "$OUT" | jq -r .transactionHash)\""
  log "deployed LeashMUSD $LEASH (verifier $VERIFIER) at block $BLOCK"
fi
LEASH=$(get_dep .leashMUSD)

# 2. the owner's Mezo trove
if [ "$(cast call "$TROVE_MANAGER" 'getTroveStatus(address)(uint8)' "$OWNER" --rpc-url "$R")" != 1 ]; then
  COLL_WEI=$(cast to-wei "${COLL%ether}")
  FEE=$(cast call "$BORROWER_OPS" 'getBorrowingFee(uint256)(uint256)' "$DEBT" --rpc-url "$R" | uint)
  TOTAL=$(python3 -c "print($DEBT + 200 * 10**18 + $FEE)")
  NICR=$(cast call "$HINTS" 'computeNominalCR(uint256,uint256)(uint256)' "$COLL_WEI" "$TOTAL" --rpc-url "$R" | uint)
  APPROX=$(cast call "$HINTS" 'getApproxHint(uint256,uint256,uint256)(address,uint256,uint256)' "$NICR" 30 42 --rpc-url "$R" | head -1)
  read -r UP LOW < <(cast call "$SORTED" 'findInsertPosition(uint256,address,address)(address,address)' "$NICR" "$APPROX" "$APPROX" --rpc-url "$R" | tr '\n' ' ')
  H=$(send --private-key "$MEZO_DEPLOYER_KEY" --value "$COLL_WEI" "$BORROWER_OPS" 'openTrove(uint256,address,address)' "$DEBT" "$UP" "$LOW" | tx)
  set_dep ".txs.openTrove=\"$H\""
  log "opened trove: ${COLL%ether} BTC for 2,000 MUSD  tx $H"
fi
log "owner MUSD $(cast call "$MUSD" 'balanceOf(address)(uint256)' "$OWNER" --rpc-url "$R" | uint)"

# 3. hidden policy, 10 MUSD escrow, guard at 150%
COMMIT=$(node packages/mezo/scripts/prove.mjs init "$PAYEE" | jq -r .commitment)
PID=$(cast call "$LEASH" 'policyIdOf(address,bytes32)(bytes32)' "$OWNER" "$COMMIT" --rpc-url "$R")
if [ "$(cast call "$LEASH" 'policyOwner(bytes32)(address)' "$PID" --rpc-url "$R")" = 0x0000000000000000000000000000000000000000 ]; then
  H=$(send --private-key "$MEZO_DEPLOYER_KEY" "$MUSD" 'approve(address,uint256)' "$LEASH" 10000000000000000000 | tx)
  set_dep ".txs.approveMUSD=\"$H\""
  H=$(send --private-key "$MEZO_DEPLOYER_KEY" "$LEASH" 'registerPolicy(bytes32,uint256,uint256)' "$COMMIT" 10000000000000000000 1500000000000000000 | tx)
  set_dep ".owner=\"$OWNER\" | .agent=\"$AGENT\" | .payee=\"$PAYEE\" | .policyCommitment=\"$COMMIT\" | .policyId=\"$PID\" | .txs.registerPolicy=\"$H\""
  log "registered policy $COMMIT with 10 MUSD, guard 150%  tx $H"
fi
# the agent pays its own gas in BTC
if [ "$(cast balance "$AGENT" --rpc-url "$R")" = 0 ]; then
  H=$(send --private-key "$MEZO_DEPLOYER_KEY" --value 0.0005ether "$AGENT" | tx); set_dep ".txs.fundAgentGas=\"$H\""
fi

pay() { # pay <cents> <nonce> <txkey>: the agent proves and submits; records the tx, advances the spend chain
  local J; J=$(node packages/mezo/scripts/prove.mjs pay "$1" "$2")
  local args=("$OWNER" "$(echo "$J" | jq -r .commitment)" "$(echo "$J" | jq -r .cents)" "$(echo "$J" | jq -r .merchantIdHash)" \
    "$(echo "$J" | jq -r .nonce)" "$(echo "$J" | jq -r .recipient)" "($(echo "$J" | jq -r .epoch),$(echo "$J" | jq -r .prev),$(echo "$J" | jq -r .next))" "$(echo "$J" | jq -r .proof)")
  local SIG='executePayment(address,bytes32,uint256,bytes32,bytes32,address,(uint64,bytes32,bytes32),bytes)'
  if [ "${4:-}" = expect-refusal ]; then
    local why; why=$(cast call "$LEASH" "$SIG" "${args[@]}" --from "$AGENT" --rpc-url "$R" 2>&1 | tail -1 || true)
    set_dep ".refusals.$3=$(jq -Rn --arg w "$why" '$w')"; log "refused as expected: $why"
    local H; H=$(send --private-key "$MEZO_AGENT_KEY" --gas-limit 3000000 "$LEASH" "$SIG" "${args[@]}" 2>/dev/null | tx || true)
    [ -n "$H" ] && [ "$H" != null ] && set_dep ".txs.$3=\"$H\"" && log "the refused payment on chain (status 0): $H"
    return 0
  fi
  local H; H=$(send --private-key "$MEZO_AGENT_KEY" "$LEASH" "$SIG" "${args[@]}" | tx)
  set_dep ".txs.$3=\"$H\""
  node packages/mezo/scripts/prove.mjs advance "$(echo "$J" | jq -r .next)" "$1" >/dev/null
  log "agent paid $1 cents to $PAYEE  tx $H"
}
health() { cast call "$LEASH" 'troveHealth(address)(uint8,uint256,uint256)' "$OWNER" --rpc-url "$R" | tr '\n' ' '; }

# 4-6
if [ -z "$(get_dep .txs.pay1)" ]; then log "trove health $(health)"; pay 300 "$(date +%s)1" pay1; fi
if [ -z "$(get_dep .txs.pay2)" ]; then
  ICR=$(cast call "$LEASH" 'troveHealth(address)(uint8,uint256,uint256)' "$OWNER" --rpc-url "$R" | sed -n 2p | uint)
  TIGHT=$(python3 -c "print($ICR + 10**17)")
  H=$(send --private-key "$MEZO_DEPLOYER_KEY" "$LEASH" 'setTroveGuard(bytes32,uint256)' "$COMMIT" "$TIGHT" | tx); set_dep ".txs.tightenGuard=\"$H\""
  log "guard tightened to ICR+10% ($TIGHT)  tx $H"
  N="$(date +%s)2"
  pay 400 "$N" refusedByGuard expect-refusal
  H=$(send --private-key "$MEZO_DEPLOYER_KEY" "$LEASH" 'setTroveGuard(bytes32,uint256)' "$COMMIT" 1500000000000000000 | tx); set_dep ".txs.relaxGuard=\"$H\""
  log "guard back to 150%  tx $H"
  pay 400 "$N" pay2
fi
set_dep ".updatedAt=\"$(date -u +%FT%TZ)\" | .escrowWei=\"$(cast call "$LEASH" 'policyBalance(bytes32)(uint256)' "$PID" --rpc-url "$R" | uint)\""
log "done: $(jq -c .txs "$DEP")"
