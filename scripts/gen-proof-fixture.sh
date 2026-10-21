#!/usr/bin/env bash
# Regenerates the Solidity verifier and the real UltraHonk proof fixtures from circuits/.
# Run after any circuit change: compiles both Noir programs, writes the EVM vk + verifier and the
# default-target vk, then scripts/gen-fixtures.cjs proves each forge test case (bb verify checks each)
# into contracts/test/fixtures/<case>/.
# Toolchain is pinned (see TOOLCHAIN.md); override the binaries with NARGO=... BB=...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIRCUITS="$ROOT/circuits"
FIXTURES="$ROOT/contracts/test/fixtures"
NAME=leash_circuit

NARGO="${NARGO:-$ROOT/.tools/nargo}"
BB="${BB:-$ROOT/.tools/bb}"
NARGO_VERSION=1.0.0-beta.16
BB_VERSION=3.0.1

for tool in "$NARGO" "$BB"; do
  [ -x "$tool" ] || { echo "error: $tool not found or not executable (see TOOLCHAIN.md)" >&2; exit 1; }
done

got_nargo="$("$NARGO" --version | sed -n 's/^nargo version = \([^ +]*\).*/\1/p')"
[ "$got_nargo" = "$NARGO_VERSION" ] || {
  echo "error: $NARGO is nargo '${got_nargo:-unknown}', expected $NARGO_VERSION (see TOOLCHAIN.md)" >&2; exit 1; }
got_bb="$("$BB" --version | tr -d '[:space:]v')"
[ "$got_bb" = "$BB_VERSION" ] || {
  echo "error: $BB is bb '${got_bb:-unknown}', expected $BB_VERSION (see TOOLCHAIN.md)" >&2; exit 1; }

cd "$ROOT/packages/core/policy_circuit"
"$NARGO" compile
cd "$CIRCUITS"
"$NARGO" compile

# -t evm selects the keccak oracle hash, which the Solidity verifier requires.
"$BB" write_vk -b "target/$NAME.json" -t evm -o target/vk_evm
"$BB" write_solidity_verifier -k target/vk_evm/vk -t evm -o "$ROOT/contracts/src/LeashVerifier.sol"
# Default-target (poseidon2) vk used by the off-chain verifier in packages/core.
"$BB" write_vk -b "target/$NAME.json" -o target/vk
echo "vk_hash (evm):     0x$(xxd -p -c 64 target/vk_evm/vk_hash)"
echo "vk_hash (default): 0x$(xxd -p -c 64 target/vk/vk_hash)"

cd "$ROOT"
pnpm --filter @leash/core build >/dev/null
rm -rf "$FIXTURES/proof" "$FIXTURES/public_inputs"
NARGO="$NARGO" BB="$BB" node scripts/gen-fixtures.cjs
