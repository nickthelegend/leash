#!/usr/bin/env bash
# Regenerates the real UltraHonk proof fixture and Solidity verifier from circuits/.
# Run after any circuit change: compiles, executes with circuits/Prover.toml, writes the EVM
# vk + verifier and the default-target vk, proves, verifies natively, then copies proof/public_inputs into contracts/test/fixtures.
# Toolchain is pinned (see TOOLCHAIN.md); override the binaries with NARGO=... BB=...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIRCUITS="$ROOT/circuits"
FIXTURES="$ROOT/contracts/test/fixtures"
NAME=leash_circuit
WITNESS=fixture

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

cd "$CIRCUITS"
"$NARGO" compile
"$NARGO" execute "$WITNESS"

# -t evm selects the keccak oracle hash, which the Solidity verifier requires.
"$BB" write_vk -b "target/$NAME.json" -t evm -o target/vk_evm
"$BB" write_solidity_verifier -k target/vk_evm/vk -t evm -o "$ROOT/contracts/src/LeashVerifier.sol"
# Default-target (poseidon2) vk used by the off-chain verifier in packages/core.
"$BB" write_vk -b "target/$NAME.json" -o target/vk

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
"$BB" prove -b "target/$NAME.json" -w "target/$WITNESS.gz" -k target/vk_evm/vk -t evm -o "$OUT"
"$BB" verify -p "$OUT/proof" -i "$OUT/public_inputs" -k target/vk_evm/vk -t evm

mkdir -p "$FIXTURES"
cp "$OUT/proof" "$OUT/public_inputs" "$FIXTURES/"
echo "fixture written to $FIXTURES (proof $(wc -c <"$FIXTURES/proof") bytes, public_inputs $(wc -c <"$FIXTURES/public_inputs") bytes)"
