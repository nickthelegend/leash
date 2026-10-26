# LEASH Hub API. Build from the repo root: docker build -f packages/hub/Dockerfile .
ARG NARGO_VERSION=1.0.0-beta.16
ARG BB_VERSION=3.0.1
FROM debian:trixie-slim AS tools
ARG NARGO_VERSION
ARG BB_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /tools \
 && curl -fsSL "https://github.com/noir-lang/noir/releases/download/v${NARGO_VERSION}/nargo-x86_64-unknown-linux-gnu.tar.gz" | tar xz -C /tools nargo \
 && curl -fsSL "https://github.com/AztecProtocol/aztec-packages/releases/download/v${BB_VERSION}/barretenberg-amd64-linux.tar.gz" | tar xz -C /tools bb \
 && /tools/nargo --version && /tools/bb --version
COPY circuits /src/circuits
COPY packages/core/policy_circuit /src/policy_circuit
RUN cd /src/circuits && /tools/nargo compile && /tools/bb write_vk -b target/leash_circuit.json -t evm -o target/vk_evm \
 && cd /src/policy_circuit && /tools/nargo compile

FROM node:22-trixie-slim AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/hub/package.json packages/hub/
RUN pnpm install --frozen-lockfile --filter "@leash/core..." --filter "@leash/hub..."
COPY packages/core packages/core
COPY packages/hub packages/hub
RUN pnpm --filter @leash/core build && pnpm install --frozen-lockfile --prod --filter "@leash/core..." --filter "@leash/hub..."

FROM node:22-trixie-slim AS run
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8787 LEASH_TOOLS_DIR=/app/.tools HUB_STATE_DIR=/data/state HUB_DATA_DIR=/data/requests HUB_ENV=/run/hub.env
WORKDIR /app
COPY --from=build /app ./
COPY --from=tools /tools/nargo /tools/bb /app/.tools/
COPY --from=tools /src/circuits /app/circuits
COPY --from=tools /src/policy_circuit /app/packages/core/policy_circuit
RUN mkdir -p /data && chown -R node:node /data /app/circuits /app/packages/core/policy_circuit
USER node
EXPOSE 8787
CMD ["node", "packages/hub/src/server.mjs"]
