#!/usr/bin/env bash
# LEASH Clawback on Mezo testnet (chain 31611), end to end with real transactions.
#
# The user's agent hires a provider agent for a checkable task ("report MUSD's total supply on Mezo testnet at
# block N"); the user's agent and an independent arbiter both check answers against the chain itself.
#   0. deploy LeashClawback (reusing the deployed LEASH HonkVerifier); fund gas for agent, provider, arbiter
#   1. the owner borrows MUSD on Mezo Borrow (openTrove: BTC in, MUSD out)
#   2. the owner registers a hidden ZK policy (provider allowlisted) with 12 MUSD and an arbiter
#   3. the provider bonds 20 MEZO
#   job 1  good answer  -> the user's agent verifies it on chain and accepts   -> provider paid 3 MUSD
#   job 2  wrong answer -> the user's agent disputes, the arbiter re-checks     -> 4 MUSD clawed back + 5 MEZO slashed
#   job 3  no delivery  -> after the deadline anyone claws back                 -> 5 MUSD clawed back + 5 MEZO slashed
# Keys: contracts/.env.mezo (gitignored, never printed). Record: packages/mezo/deployments/mezo-clawback.json.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$PWD"
export PATH="$ROOT/.tools:$PATH"
set -a; . contracts/.env.mezo; set +a
R=${MEZO_RPC_URL:-https://rpc.test.mezo.org}
MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
MEZO=0x7b7c000000000000000000000000000000000001
BORROWER_OPS=0xCdF7028ceAB81fA0C6971208e83fa7872994beE5
TROVE_MANAGER=0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0
HINTS=0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6
SORTED=0x722E4D24FD6Ff8b0AC679450F3D91294607268fA
VERIFIER=${MEZO_VERIFIER:-0xc505B0E4d6b7B6E4162f5F82D7966FD73310e336}   # LEASH HonkVerifier, already on Mezo testnet
OWNER=$MEZO_DEPLOYER_ADDRESS AGENT=$MEZO_AGENT_ADDRESS PROVIDER=$MEZO_PAYEE_ADDRESS ARBITER=$MEZO_ARBITER_ADDRESS
DISPUTE_WINDOW=${DISPUTE_WINDOW:-90} GHOST_WINDOW=${GHOST_WINDOW:-60}
DEP=packages/mezo/deployments/mezo-clawback.json
mkdir -p "$(dirname "$DEP")"; [ -f "$DEP" ] || echo '{"chainId":31611,"txs":{},"jobs":[]}' > "$DEP"
set_dep() { local t; t=$(mktemp); jq "$@" "$DEP" > "$t" && mv "$t" "$DEP"; }
get_dep() { jq -r "$1 // empty" "$DEP"; }
send() { cast send --rpc-url "$R" --json "$@" | jq -r .transactionHash; }
rec() { set_dep --arg k "$1" --arg v "$2" '.txs[$k]=$v'; }
log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
uint() { awk '{print $1}'; }
note_job() { set_dep --argjson j "$1" '.jobs = ([.jobs[] | select(.jobId != $j.jobId)] + [$j])'; }

# 0. contract
if [ -z "$(get_dep .leashClawback)" ]; then
  nonce=$(cast nonce "$OWNER" --rpc-url "$R"); addr=$(cast compute-address "$OWNER" --nonce "$nonce" | awk '{print $NF}')
  (cd contracts && forge create src/LeashClawback.sol:LeashClawback --rpc-url "$R" --private-key "$MEZO_DEPLOYER_KEY" --broadcast \
    --constructor-args "$VERIFIER" "$MUSD" "$MEZO" "$DISPUTE_WINDOW" 10000000000000000000 5000000000000000000 >/dev/null 2>&1) || true
  for _ in $(seq 40); do [ "$(cast code "$addr" --rpc-url "$R")" != 0x ] && break; sleep 3; done   # Mezo serves new code late
  [ "$(cast code "$addr" --rpc-url "$R")" != 0x ] || { echo "LeashClawback deploy failed" >&2; exit 1; }
  set_dep --arg a "$addr" --arg v "$VERIFIER" --argjson b "$(( $(cast block-number --rpc-url "$R") - 40 ))" \
    --arg o "$OWNER" --arg ag "$AGENT" --arg p "$PROVIDER" --arg ar "$ARBITER" \
    '.leashClawback=$a | .verifier=$v | .deployBlock=$b | .owner=$o | .agent=$ag | .provider=$p | .arbiter=$ar | .disputeWindowSec='"$DISPUTE_WINDOW"
  log "deployed LeashClawback $addr"
fi
CB=$(get_dep .leashClawback)
for who in AGENT PROVIDER ARBITER; do
  a=${!who}; if [ "$(cast balance "$a" --rpc-url "$R")" = 0 ]; then rec "gas$who" "$(send --private-key "$MEZO_DEPLOYER_KEY" --value 0.0003ether "$a")"; fi
done

# 1. MUSD from Mezo Borrow
if [ "$(cast call "$TROVE_MANAGER" 'getTroveStatus(address)(uint8)' "$OWNER" --rpc-url "$R")" != 1 ]; then
  COLL_WEI=$(cast to-wei "${MEZO_TROVE_BTC:-0.047}"); DEBT=2000000000000000000000
  FEE=$(cast call "$BORROWER_OPS" 'getBorrowingFee(uint256)(uint256)' "$DEBT" --rpc-url "$R" | uint)
  NICR=$(cast call "$HINTS" 'computeNominalCR(uint256,uint256)(uint256)' "$COLL_WEI" "$(python3 -c "print($DEBT + 200 * 10**18 + $FEE)")" --rpc-url "$R" | uint)
  APPROX=$(cast call "$HINTS" 'getApproxHint(uint256,uint256,uint256)(address,uint256,uint256)' "$NICR" 30 42 --rpc-url "$R" | head -1)
  read -r UP LOW < <(cast call "$SORTED" 'findInsertPosition(uint256,address,address)(address,address)' "$NICR" "$APPROX" "$APPROX" --rpc-url "$R" | tr '\n' ' ') || true
  rec openTrove "$(send --private-key "$MEZO_DEPLOYER_KEY" --value "$COLL_WEI" "$BORROWER_OPS" 'openTrove(uint256,address,address)' "$DEBT" "$UP" "$LOW")"
  log "owner opened a Mezo trove and borrowed 2,000 MUSD against BTC"
fi

# 2. policy
COMMIT=$(node packages/mezo/scripts/prove.mjs init "$PROVIDER" | jq -r .commitment)
PID=$(cast call "$CB" 'policyIdOf(address,bytes32)(bytes32)' "$OWNER" "$COMMIT" --rpc-url "$R")
if [ "$(cast call "$CB" 'policyOwner(bytes32)(address)' "$PID" --rpc-url "$R")" = 0x0000000000000000000000000000000000000000 ]; then
  rec approveMUSD "$(send --private-key "$MEZO_DEPLOYER_KEY" "$MUSD" 'approve(address,uint256)' "$CB" 12000000000000000000)"
  rec registerPolicy "$(send --private-key "$MEZO_DEPLOYER_KEY" "$CB" 'registerPolicy(bytes32,address,uint256)' "$COMMIT" "$ARBITER" 12000000000000000000)"
  set_dep --arg c "$COMMIT" --arg p "$PID" '.policyCommitment=$c | .policyId=$p'
  log "policy $COMMIT registered with 12 MUSD, arbiter $ARBITER"
fi

# 3. provider bond (real MEZO)
if [ "$(cast call "$CB" 'bondOf(address)(uint256)' "$PROVIDER" --rpc-url "$R" | uint)" = 0 ]; then
  rec mezoToProvider "$(send --private-key "$MEZO_DEPLOYER_KEY" "$MEZO" 'transfer(address,uint256)' "$PROVIDER" 20000000000000000000)"
  rec approveMEZO "$(send --private-key "$MEZO_PAYEE_KEY" "$MEZO" 'approve(address,uint256)' "$CB" 20000000000000000000)"
  rec bond "$(send --private-key "$MEZO_PAYEE_KEY" "$CB" 'bond(uint256)' 20000000000000000000)"
  log "provider bonded 20 MEZO"
fi

REQ='openJob((address,bytes32,uint256,bytes32,bytes32,address,bytes32,uint64),(uint64,bytes32,bytes32),bytes)'
open_job() { # open_job <key> <cents> <task> <window>  -> prints jobId
  local J nonce; nonce="$(date +%s)$RANDOM"; J=$(node packages/mezo/scripts/prove.mjs pay "$2" "$nonce")
  local task_hash; task_hash=$(cast keccak "$3")
  local H; H=$(send --private-key "$MEZO_AGENT_KEY" "$CB" "$REQ" \
    "($OWNER,$(echo "$J" | jq -r .commitment),$(echo "$J" | jq -r .cents),$(echo "$J" | jq -r .merchantIdHash),$(echo "$J" | jq -r .nonce),$PROVIDER,$task_hash,$4)" \
    "($(echo "$J" | jq -r .epoch),$(echo "$J" | jq -r .prev),$(echo "$J" | jq -r .next))" "$(echo "$J" | jq -r .proof)")
  node packages/mezo/scripts/prove.mjs advance "$(echo "$J" | jq -r .next)" "$2" >/dev/null
  rec "$1Open" "$H"
  cast call "$CB" 'jobCount()(uint256)' --rpc-url "$R" | uint
}
supply_at() { cast call "$MUSD" 'totalSupply()(uint256)' --block "$1" --rpc-url "$R" | uint; }
status() { cast call "$CB" 'jobs(uint256)(bytes32,address,address,uint96,uint64,uint64,uint8,bytes32,bytes32)' "$1" --rpc-url "$R" | sed -n 7p; }

# job 1: a correct answer, verified by the user's agent, accepted
if [ -z "$(get_dep .txs.job1Accept)" ]; then
  B=$(( $(cast block-number --rpc-url "$R") - 5 )); TASK="Report MUSD totalSupply on Mezo testnet at block $B"
  ID=$(open_job job1 300 "$TASK" 3600); log "job $ID opened: $TASK (3.00 MUSD in escrow)"
  ANSWER=$(supply_at "$B")                                   # the provider does the work
  rec job1Deliver "$(send --private-key "$MEZO_PAYEE_KEY" "$CB" 'deliver(uint256,bytes32,string)' "$ID" "$(cast keccak "$ANSWER")" "data:,$ANSWER")"
  CHECK=$(supply_at "$B")                                    # the user's agent checks the chain itself
  [ "$CHECK" = "$ANSWER" ] || { echo "job 1: unexpected mismatch" >&2; exit 1; }
  rec job1Accept "$(send --private-key "$MEZO_DEPLOYER_KEY" "$CB" 'accept(uint256)' "$ID")"
  note_job "$(jq -n --argjson id "$ID" --arg t "$TASK" --arg a "$ANSWER" '{jobId:$id,task:$t,answer:$a,verdict:"correct: verified on chain by the user'"'"'s agent, accepted, provider paid"}')"
  log "job $ID: answer $ANSWER verified on chain, accepted -> provider paid 3 MUSD (status $(status "$ID"))"
fi

# job 2: a wrong answer -> dispute -> the arbiter re-checks the chain -> clawback + slash
if [ -z "$(get_dep .txs.job2Resolve)" ]; then
  B=$(( $(cast block-number --rpc-url "$R") - 5 )); TASK="Report MUSD totalSupply on Mezo testnet at block $B"
  ID=$(open_job job2 400 "$TASK" 3600); log "job $ID opened: $TASK (4.00 MUSD in escrow)"
  TRUTH=$(supply_at "$B"); WRONG=$(python3 -c "print($TRUTH * 2)")   # a provider that answers badly
  rec job2Deliver "$(send --private-key "$MEZO_PAYEE_KEY" "$CB" 'deliver(uint256,bytes32,string)' "$ID" "$(cast keccak "$WRONG")" "data:,$WRONG")"
  [ "$(supply_at "$B")" != "$WRONG" ] || { echo "job 2: wrong answer matched" >&2; exit 1; }
  rec job2Dispute "$(send --private-key "$MEZO_DEPLOYER_KEY" "$CB" 'dispute(uint256,bytes32)' "$ID" "$(cast keccak "answer does not match MUSD totalSupply at block $B")")"
  ARB=$(supply_at "$B")                                      # the arbiter checks independently
  REFUND=$([ "$ARB" = "$WRONG" ] && echo false || echo true)
  rec job2Resolve "$(send --private-key "$MEZO_ARBITER_KEY" "$CB" 'resolve(uint256,bool)' "$ID" "$REFUND")"
  note_job "$(jq -n --argjson id "$ID" --arg t "$TASK" --arg a "$WRONG" --arg c "$ARB" '{jobId:$id,task:$t,answer:$a,correct:$c,verdict:"wrong: disputed, the arbiter re-checked the chain, clawed back to the user, provider bond slashed"}')"
  log "job $ID: answer $WRONG != chain $ARB -> disputed, arbiter refund=$REFUND (status $(status "$ID"))"
fi

# job 3: the provider never delivers -> clawback after the deadline
if [ -z "$(get_dep .txs.job3Clawback)" ]; then
  B=$(( $(cast block-number --rpc-url "$R") - 5 )); TASK="Report MUSD totalSupply on Mezo testnet at block $B"
  if [ -z "$(get_dep .job3Id)" ]; then
    ID=$(open_job job3 500 "$TASK" "$GHOST_WINDOW"); set_dep --argjson i "$ID" --arg t "$TASK" '.job3Id=$i | .job3Task=$t'
    log "job $ID opened: $TASK (5.00 MUSD in escrow, ${GHOST_WINDOW}s to deliver); the provider stays silent"
  fi
  ID=$(get_dep .job3Id); DL=$(cast call "$CB" 'jobs(uint256)(bytes32,address,address,uint96,uint64,uint64,uint8,bytes32,bytes32)' "$ID" --rpc-url "$R" | sed -n 5p | uint)
  while [ "$(cast block latest --field timestamp --rpc-url "$R")" -le "$DL" ]; do sleep 5; done
  rec job3Clawback "$(send --private-key "$MEZO_AGENT_KEY" "$CB" 'clawback(uint256)' "$ID")"
  note_job "$(jq -n --argjson id "$ID" --arg t "$(get_dep .job3Task)" '{jobId:$id,task:$t,answer:null,verdict:"no delivery before the deadline: clawed back to the user, provider bond slashed"}')"
  log "job $ID: no delivery -> clawed back (status $(status "$ID"))"
fi

set_dep --arg e "$(cast call "$CB" 'policyBalance(bytes32)(uint256)' "$PID" --rpc-url "$R" | uint)" \
  --arg b "$(cast call "$CB" 'bondOf(address)(uint256)' "$PROVIDER" --rpc-url "$R" | uint)" \
  --arg t "$(date -u +%FT%TZ)" '.escrowWei=$e | .providerBondWei=$b | .updatedAt=$t'
log "escrow $(get_dep .escrowWei) MUSD wei, provider bond $(get_dep .providerBondWei) MEZO wei"
log "txs: $(jq -c .txs "$DEP")"
