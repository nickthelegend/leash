#!/usr/bin/env bash
# One-time setup for judges and new checkouts: puts the pinned Noir toolchain (nargo 1.0.0-beta.16,
# bb 3.0.1, see TOOLCHAIN.md) into ./.tools from the official GitHub releases, then checks the other
# tools the tests and the demo need. Idempotent: a .tools binary with the right version is kept.
#   pnpm setup:tools            install what is missing, then check
#   pnpm setup:tools -- --check only check, download nothing
set -euo pipefail
cd "$(dirname "$0")/.."
NARGO_VERSION=1.0.0-beta.16
BB_VERSION=3.0.1
TOOLS="${TOOLS_DIR:-$PWD/.tools}"
CHECK_ONLY=0; for a in "$@"; do [ "$a" = "--check" ] && CHECK_ONLY=1; done  # pnpm may pass a leading --

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  NARGO_ASSET=nargo-aarch64-apple-darwin;      BB_ASSET=barretenberg-arm64-darwin ;;
  Darwin-x86_64) NARGO_ASSET=nargo-x86_64-apple-darwin;       BB_ASSET=barretenberg-amd64-darwin ;;
  Linux-x86_64)  NARGO_ASSET=nargo-x86_64-unknown-linux-gnu;  BB_ASSET=barretenberg-amd64-linux ;;
  Linux-aarch64) NARGO_ASSET=nargo-aarch64-unknown-linux-gnu; BB_ASSET=barretenberg-arm64-linux ;;
  *) echo "Unsupported platform $(uname -s)-$(uname -m); install nargo $NARGO_VERSION and bb $BB_VERSION by hand (TOOLCHAIN.md)" >&2; exit 1 ;;
esac

have_version() { [ -x "$TOOLS/$1" ] && "$TOOLS/$1" --version 2>/dev/null | grep -q "$2"; }

fetch() { # fetch <binary> <url>
  [ "$CHECK_ONLY" = 1 ] && { echo "missing: $TOOLS/$1 (run pnpm setup:tools)"; return 1; }
  echo "downloading $2"
  mkdir -p "$TOOLS"
  curl -fsSL "$2" | tar xz -C "$TOOLS" "$1"
  chmod +x "$TOOLS/$1"
}

ok=1
have_version nargo "$NARGO_VERSION" || fetch nargo "https://github.com/noir-lang/noir/releases/download/v$NARGO_VERSION/$NARGO_ASSET.tar.gz" || ok=0
have_version bb "$BB_VERSION" || fetch bb "https://github.com/AztecProtocol/aztec-packages/releases/download/v$BB_VERSION/$BB_ASSET.tar.gz" || ok=0
have_version nargo "$NARGO_VERSION" && echo "ok      nargo $NARGO_VERSION ($TOOLS/nargo)" || { echo "wrong   nargo: need $NARGO_VERSION" >&2; ok=0; }
have_version bb "$BB_VERSION" && echo "ok      bb $BB_VERSION ($TOOLS/bb)" || { echo "wrong   bb: need $BB_VERSION" >&2; ok=0; }

# Not installed by this script: report what is missing and how to get it.
for t in node pnpm forge cast anvil jq; do
  if command -v "$t" >/dev/null 2>&1; then echo "ok      $t"; else
    case "$t" in
      forge|cast|anvil) hint="Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup" ;;
      jq) hint="brew install jq / apt-get install jq" ;;
      pnpm) hint="corepack enable pnpm" ;;
      *) hint="Node 20+ from nodejs.org" ;;
    esac
    echo "missing $t ($hint)" >&2; ok=0
  fi
done
[ "$ok" = 1 ] || { echo "Setup incomplete (see above)." >&2; exit 1; }
echo "Toolchain ready. Next: pnpm install && pnpm test"
