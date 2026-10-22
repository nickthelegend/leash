#!/usr/bin/env bash
# Real local LEASH stack for the Playwright E2E run, bound to 127.0.0.1:
#   - Anvil (pnpm demo:anvil: LeashVerifier + LeashPayment deployed, demo policy registered with a
#     2000-wei escrow by Anvil #0, relayer Anvil #9, openai's payee Anvil #1)
#   - the verify-only Express gateway (owner-signed registrations, receipts)
#   - the console (next start, owner-device mode on: LEASH_OWNER_DEVICE=1)
# No PayPal keys are set here, so the PayPal rail answers "Setup required" (that state is tested).
# State lives in e2e/.run/leash-home (LEASH_HOME), never in the developer's .leash.
# Usage: e2e/stack.sh start | stop      PIDs go to e2e/.run/pids and are killed by PID only.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
RUN="$ROOT/e2e/.run"
export ANVIL_PORT="${LEASH_E2E_ANVIL_PORT:-8557}"
WEB_PORT="${LEASH_E2E_WEB_PORT:-3107}"
GATEWAY_PORT="${LEASH_E2E_GATEWAY_PORT:-3108}"

stop() {
  if [ -f "$RUN/pids" ]; then
    while read -r name pid; do
      if kill -0 "$pid" 2>/dev/null; then kill "$pid" && echo "stopped $name ($pid)"; fi
    done < "$RUN/pids"
    rm -f "$RUN/pids"
  fi
}

case "${1:-start}" in
  stop) stop; exit 0 ;;
  start) ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac

stop
rm -rf "$RUN"; mkdir -p "$RUN/leash-home"
export PATH="$ROOT/.tools:$PATH"

# Chain + contracts + escrow-funded demo policy (writes .demo/anvil.env and .demo/anvil.pid)
./scripts/demo-anvil.sh | tee "$RUN/anvil-deploy.txt"
echo "anvil $(cat .demo/anvil.pid)" >> "$RUN/pids"
cp .demo/anvil.env "$RUN/anvil.env"

# Verify-only Express gateway (owner-signed registrations, receipts), same state dir as the console
pnpm --filter @leash/core build >/dev/null
LEASH_HOME="$RUN/leash-home" node -e "require('./packages/core/dist/gateway/server.js').createGatewayApp().listen($GATEWAY_PORT, '127.0.0.1', () => console.log('gateway on 127.0.0.1:$GATEWAY_PORT'))" \
  > "$RUN/gateway.log" 2>&1 &
echo "gateway $!" >> "$RUN/pids"

# Console: production build, owner device on, isolated state
# Rebuild when the console or @leash/core changed since the last build (a stale build would test old code).
if [ ! -f apps/web/.next/BUILD_ID ] || [ -n "$(find apps/web/app apps/web/components apps/web/lib apps/web/package.json packages/core/dist -newer apps/web/.next/BUILD_ID -print -quit)" ]; then
  pnpm --filter web build
fi
(
  cd apps/web
  LEASH_HOME="$RUN/leash-home" LEASH_OWNER_DEVICE=1 PORT="$WEB_PORT" \
    exec ./node_modules/.bin/next start -H 127.0.0.1 -p "$WEB_PORT"
) > "$RUN/web.log" 2>&1 &
echo "web $!" >> "$RUN/pids"
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$WEB_PORT/api/policies" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$WEB_PORT/api/policies" >/dev/null || { echo "console did not start (see $RUN/web.log)" >&2; exit 1; }
curl -sf "http://127.0.0.1:$GATEWAY_PORT/api/health" >/dev/null || { echo "gateway did not start (see $RUN/gateway.log)" >&2; exit 1; }
echo "console http://127.0.0.1:$WEB_PORT  gateway http://127.0.0.1:$GATEWAY_PORT  anvil http://127.0.0.1:$ANVIL_PORT"
cat "$RUN/pids"
