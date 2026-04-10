# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++ git

COPY package.json bun.lockb ./
COPY packages/ai/package.json packages/ai/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/github-agent/package.json packages/github-agent/
COPY packages/governance/package.json packages/governance/
COPY packages/governance-mcp-server/package.json packages/governance-mcp-server/
COPY packages/slack-agent/package.json packages/slack-agent/
COPY packages/slack-agent-ui/package.json packages/slack-agent-ui/
COPY packages/tui/package.json packages/tui/
COPY packages/web/package.json packages/web/

# ambient-agent-rs and tui-rs are pure Rust (no package.json)
# desktop, jetbrains-plugin, vscode-extension excluded via .dockerignore
RUN bun install --no-frozen-lockfile

# ---------- builder ----------
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

# contracts build generates Rust protocol files and formats with rustfmt
RUN apk add --no-cache python3 make g++ git nodejs && \
    wget -qO- https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal && \
    ln -s /root/.cargo/bin/rustfmt /usr/local/bin/rustfmt

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN bun run build:all

# ---------- runner ----------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tini git && \
    addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /app/packages/contracts/package.json ./packages/contracts/
COPY --from=builder /app/packages/tui/dist ./packages/tui/dist
COPY --from=builder /app/packages/tui/package.json ./packages/tui/
COPY --from=builder /app/packages/web/dist ./packages/web/dist
COPY --from=builder /app/packages/web/package.json ./packages/web/
COPY --from=builder /app/packages/ai/dist ./packages/ai/dist
COPY --from=builder /app/packages/ai/package.json ./packages/ai/

USER appuser

EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "--enable-source-maps", "dist/web-server.js"]
