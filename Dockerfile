# syntax=docker/dockerfile:1
# LEASH verify-only gateway image: Express gateway + Barretenberg `bb verify` against the server's own key.
# The pinned nargo/bb (TOOLCHAIN.md) come from their GitHub releases, as CI fetches them; the circuit is
# compiled and its verification keys written at build time. No secrets: PayPal stays Setup required
# until PAYPAL_* is set at runtime. The gateway never proves and holds no policy secrets.
ARG NARGO_VERSION=1.0.0-beta.16
ARG BB_VERSION=3.0.1

FROM debian:trixie-slim AS circuit
ARG NARGO_VERSION
ARG BB_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /tools \
 && curl -fsSL "https://github.com/noir-lang/noir/releases/download/v${NARGO_VERSION}/nargo-x86_64-unknown-linux-gnu.tar.gz" | tar xz -C /tools nargo \
 && curl -fsSL "https://github.com/AztecProtocol/aztec-packages/releases/download/v${BB_VERSION}/barretenberg-amd64-linux.tar.gz" | tar xz -C /tools bb \
 && /tools/nargo --version && /tools/bb --version
COPY circuits /circuits
WORKDIR /circuits
RUN /tools/nargo compile \
 && /tools/bb write_vk -b target/leash_circuit.json -o target/vk \
 && /tools/bb write_vk -b target/leash_circuit.json -t evm -o target/vk_evm

FROM node:22-trixie-slim AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile --filter "@leash/core..."
COPY packages/core packages/core
RUN pnpm --filter @leash/core build && pnpm install --frozen-lockfile --prod --filter "@leash/core..."

FROM node:22-trixie-slim AS run
ENV NODE_ENV=production LEASH_GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=3001 LEASH_HOME=/data \
    LEASH_CIRCUITS_DIR=/app/circuits BB=/app/.tools/bb
WORKDIR /app
COPY --from=build /app ./
COPY --from=circuit /tools/bb /app/.tools/bb
COPY --from=circuit /circuits /app/circuits
# bb verify writes its temporary proof files next to the key (circuits/target), so that one dir is writable.
RUN mkdir -p /data && chown node:node /data /app/circuits/target && chmod 700 /data
USER node
EXPOSE 3001
CMD ["node", "packages/core/dist/gateway/server.js"]
