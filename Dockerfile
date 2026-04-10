# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app

# Native build tools for better-sqlite3, bcrypt, tree-sitter
RUN apk add --no-cache python3 make g++

# Copy lockfiles and package manifests for all workspaces
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tui/package.json packages/tui/
COPY packages/web/package.json packages/web/

RUN npm ci --ignore-scripts && \
    npm rebuild better-sqlite3 bcrypt

# ---------- builder ----------
FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build workspace packages then the main app
RUN npm run build:all

# ---------- runner ----------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tini git && \
    addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 appuser

# Runtime artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/skills ./skills
# Workspace packages needed at runtime
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder /app/packages/contracts/package.json ./packages/contracts/
COPY --from=builder /app/packages/tui/dist ./packages/tui/dist
COPY --from=builder /app/packages/tui/package.json ./packages/tui/
COPY --from=builder /app/packages/web/dist ./packages/web/dist
COPY --from=builder /app/packages/web/package.json ./packages/web/

USER appuser

EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "--enable-source-maps", "dist/web-server.js"]
