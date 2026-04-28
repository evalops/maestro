# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++ git

COPY package.json bun.lockb ./
COPY packages/ai/package.json packages/ai/
COPY packages/consumer-sdk/package.json packages/consumer-sdk/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/github-agent/package.json packages/github-agent/
COPY packages/governance/package.json packages/governance/
COPY packages/governance-mcp-server/package.json packages/governance-mcp-server/
COPY packages/memory/package.json packages/memory/
COPY packages/slack-agent/package.json packages/slack-agent/
COPY packages/slack-agent-ui/package.json packages/slack-agent-ui/
COPY packages/tui/package.json packages/tui/
COPY packages/web/package.json packages/web/

# ambient-agent-rs, control-plane-rs, and tui-rs are pure Rust (no package.json)
# desktop, jetbrains-plugin, vscode-extension excluded via .dockerignore
RUN bun install --no-frozen-lockfile

# ---------- builder base ----------
FROM oven/bun:1.3-alpine AS builder-base
WORKDIR /app

# contracts build generates Rust protocol files and formats with rustfmt
RUN apk add --no-cache python3 make g++ git nodejs pkgconfig && \
    wget -qO- https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal -c rustfmt && \
    ln -s /root/.cargo/bin/rustfmt /usr/local/bin/rustfmt
ENV PATH="/root/.cargo/bin:${PATH}"

# ---------- web builder ----------
FROM builder-base AS web-builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lockb ./
COPY biome.json buf.gen.yaml buf.yaml drizzle.config.ts nx.json openapi.json project.json ./
COPY tsconfig.base.json tsconfig.build.json tsconfig.json vitest.config.ts ./
COPY proto ./proto
COPY scripts ./scripts
COPY skills ./skills
COPY src ./src
COPY types ./types
COPY packages/ai ./packages/ai
COPY packages/consumer-sdk ./packages/consumer-sdk
COPY packages/contracts ./packages/contracts
COPY packages/core ./packages/core
COPY packages/github-agent ./packages/github-agent
COPY packages/governance ./packages/governance
COPY packages/governance-mcp-server ./packages/governance-mcp-server
COPY packages/memory ./packages/memory
COPY packages/slack-agent ./packages/slack-agent
COPY packages/slack-agent-ui ./packages/slack-agent-ui
COPY packages/tui ./packages/tui
COPY packages/tui-rs ./packages/tui-rs
COPY packages/web ./packages/web

# Write lockfile hash stamp so ensure-deps.js skips re-install
RUN node -e "const c=require('crypto'),f=require('fs');const h=c.createHash('sha256').update(f.readFileSync('bun.lockb')).digest('hex');f.mkdirSync('node_modules',{recursive:true});f.writeFileSync('node_modules/.bun-lockb.sha256',h);"

RUN bun run build:all

# ---------- rust builder ----------
FROM builder-base AS rust-builder
WORKDIR /app

COPY proto ./proto
COPY --from=web-builder /app/packages/tui-rs ./packages/tui-rs
COPY packages/control-plane-rs ./packages/control-plane-rs
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    cd packages/control-plane-rs && \
    CARGO_TARGET_DIR=/app/rust-target cargo build --release --bin maestro-control-plane && \
    mkdir -p /app/target-bin && \
    cp /app/rust-target/release/maestro-control-plane /app/target-bin/maestro-control-plane

# ---------- runner ----------
FROM alpine:3.23 AS runner
WORKDIR /app

RUN apk add --no-cache tini git ca-certificates libstdc++ nodejs npm && \
    addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser

COPY --from=web-builder /app/packages/web/dist ./packages/web/dist
COPY --from=rust-builder /app/target-bin/maestro-control-plane ./bin/maestro-control-plane

USER appuser

EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["./bin/maestro-control-plane"]
