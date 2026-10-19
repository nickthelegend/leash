#!/usr/bin/env bash
# Regenerates the real UltraHonk proof fixture and Solidity verifier from circuits/.
# Run after any circuit change: compiles, executes with circuits/Prover.toml, writes the EVM
# vk + verifier, proves, verifies natively, then copies proof/public_inputs into contracts/test/fixtures.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIRCUITS="$ROOT/circuits"
FIXTURES="$ROOT/contracts/test/fixtures"
NAME=leash_circuit
WITNESS=fixture

for tool in nargo bb; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found on PATH" >&2; exit 1; }
done

cd "$CIRCUITS"
nargo compile
nargo execute "$WITNESS"

bb write_vk -b "target/$NAME.json" -t evm -o target/vk_evm
bb write_solidity_verifier -k target/vk_evm/vk -t evm -o "$ROOT/contracts/src/LeashVerifier.sol"

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
bb prove -b "target/$NAME.json" -w "target/$WITNESS.gz" -k target/vk_evm/vk -t evm -o "$OUT"
bb verify -p "$OUT/proof" -i "$OUT/public_inputs" -k target/vk_evm/vk -t evm

mkdir -p "$FIXTURES"
cp "$OUT/proof" "$OUT/public_inputs" "$FIXTURES/"
echo "fixture written to $FIXTURES (proof $(wc -c <"$FIXTURES/proof") bytes, public_inputs $(wc -c <"$FIXTURES/public_inputs") bytes)"
