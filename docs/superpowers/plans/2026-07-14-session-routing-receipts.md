# Session Routing Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin routing profiles per session and preserve a visible, immutable routing receipt on every assistant turn.

**Architecture:** A pure resolver applies request, session, then compatibility-default precedence. Chat HTTP and WebSocket handlers emit the same contract, session metadata stores only the current pin, and each assistant message stores its own historical receipt.

**Tech Stack:** TypeScript, `@evalops/contracts`, session JSONL persistence, SSE/WebSocket, Lit, Vitest.

## Global Constraints

- Changing a pin never rewrites prior receipts.
- HTTP and WebSocket routing semantics are identical.
- Legacy mode/model fields remain available.

---

### Task 1: Define receipt and pin contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/schemas.ts`
- Modify: `src/session/types.ts`
- Create: `test/agent/routing-receipt.test.ts`
- Create: `src/agent/routing-receipt.ts`

**Interfaces:**
- Produces: `AgentProfilePin`, `RoutingReceipt`, `RoutingReceiptSource`, and `createRoutingReceipt(decision, context)`.

- [ ] **Step 1: Write failing tests** for source precedence and receipt projection including Oracle, fallback, and experiment fields.
- [ ] **Step 2: Run** `bunx vitest --run test/agent/routing-receipt.test.ts` and confirm missing exports fail.
- [ ] **Step 3: Implement the schemas and pure receipt builder.** Required receipt fields are `decisionId`, `requestedProfile`, `source`, `resolvedProfileId`, `resolvedProfileVersion`, `provider`, `model`, `reasoningEffort`, and `createdAt`; optional fields carry Oracle, fallback, and experiment detail.
- [ ] **Step 4: Re-run focused tests and build contracts; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(router): define per-turn routing receipts"`.

### Task 2: Persist pins and receipts through both chat transports

**Files:**
- Modify: `src/server/handlers/chat.ts`
- Modify: `src/server/handlers/chat-ws.ts`
- Modify: `src/server/handlers/sessions.ts`
- Modify: `src/server/hosted-session-manager.ts`
- Modify: `src/services/intelligent-router/types.ts`
- Test: `test/web/chat-handler-routing.test.ts`
- Test: `test/web/chat-ws.test.ts`
- Test: `test/session/session-manager.test.ts`

**Interfaces:**
- Consumes: request `profileHint` and optional `persistProfile`.
- Produces: session metadata `agentProfilePin` and stream event `{ type: "routing_receipt", receipt }`.

- [ ] **Step 1: Write failing precedence, immutability, and transport-parity tests.**
- [ ] **Step 2: Run the three focused suites** and confirm the new pin/receipt assertions fail.
- [ ] **Step 3: Resolve request → session → global fallback in one shared helper, validate before updating metadata, append the receipt to the assistant message, and stream it over SSE and WebSocket.**
- [ ] **Step 4: Re-run focused suites; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(router): pin profiles to sessions"`.

### Task 3: Show profile control and receipts in composer

**Files:**
- Modify: `packages/web/src/services/api-client.types.ts`
- Modify: `packages/web/src/services/api-client.ts`
- Create: `packages/web/src/components/composer-routing-receipt.ts`
- Create: `packages/web/src/components/composer-routing-receipt.test.ts`
- Modify: `packages/web/src/components/composer-chat-message-pane.ts`
- Modify: `packages/web/src/components/composer-chat.ts`

**Interfaces:**
- Consumes: `RoutingReceipt` on assistant messages and the session pin update API.
- Produces: a compact receipt summary and expandable detail view.

- [ ] **Step 1: Write failing tests** for summary copy, expanded details, fallback reason, and pin updates scoped to the active session.
- [ ] **Step 2: Run focused web tests** and confirm missing UI fails.
- [ ] **Step 3: Implement the receipt component and session-scoped profile selector.**
- [ ] **Step 4: Run focused tests and `npx nx run maestro-web:build --skip-nx-cache`; expect PASS.**
- [ ] **Step 5: Commit** with `git commit -m "feat(web): show session routing receipts"`.
