# Composer Enterprise

Updated: 2025-12-02

Audience: operators/security teams evaluating multi-tenant deployments.  
Nav: [Docs index](README.md) · [Safety](SAFETY.md) · [Models](MODELS.md) · [Sessions](SESSIONS.md)

## Executive Summary

Composer Enterprise adds the controls required for regulated and security-conscious environments:

- **Isolation**: Multi-tenant organizations with full resource separation
- **Fine-grained RBAC**: Permission checks at API, tool-execution, and directory-resolution layers
- **Real-time guardrails**: PII detection, directory allowlists, model approvals, spend limits—all enforced before execution
- **Auditability**: Complete activity logs with PII-safe redaction
- **Clean migration path**: Move from single-user JSONL to enterprise DB with one command

No hidden state. No ambient authority. Every action is gated, logged, and attributable.

---

## Deployment Model

Composer is **stateless at the application layer**. All persistent state lives in the database:

| State Type | Storage | Notes |
|------------|---------|-------|
| Sessions & messages | PostgreSQL | Replaces JSONL files |
| Audit logs | PostgreSQL | Partitionable by month |
| User/org/role data | PostgreSQL | RBAC source of truth |
| Permissions cache | In-memory | 5-min TTL, auto-cleared on changes |
| Directory rules cache | In-memory | 5-min TTL, auto-cleared on changes |

**Scaling**: Add Composer instances behind a load balancer. No sticky sessions required. All instances read/write the same database.

**Request capacity**: A single Composer instance handles 100+ req/s for typical API operations. Audit log writes are async and batched. For orgs with >50 concurrent users, consider read replicas for audit queries.

---

## RBAC Permission System

### Enforcement Points

Permission checks occur at three layers:

1. **API layer**: Every authenticated request validates `resource:action` against the user's role
2. **Tool execution layer**: Before any tool runs, permissions are re-checked with the specific resource context
3. **Directory resolver**: File paths are validated against org/user access rules before any read/write/execute

A request must pass all three checks. Failure at any layer is logged and returns a 403.

### Built-in Roles

| Role | Permissions | Typical Use |
|------|-------------|-------------|
| `org_owner` | `*:*` on all resources | Billing owner, full control |
| `org_admin` | Manage sessions, models, configs; read users; view audit | Engineering lead |
| `org_member` | Own sessions, execute approved models, use tools | Developer |
| `org_viewer` | Read-only on sessions, models, configs | Stakeholder, auditor |

### Resources and Actions

**Resources**: `sessions`, `models`, `users`, `orgs`, `audit`, `config`, `tools`, `api_keys`, `roles`, `directories`

**Actions**: `read`, `write`, `delete`, `execute`, `admin`, `*` (wildcard)

### Custom Roles

Organizations can create custom roles with any permission combination:

```bash
curl -X POST /api/roles \
  -d '{"name": "ml_engineer", "permissions": ["models:*", "sessions:write", "tools:execute"]}'
```

---

## Directory Access Control

### Enforcement Scope

Directory rules apply to **any file path referenced by any tool**—not just the working directory. Before a tool executes:

1. All paths in the tool's parameters are resolved to absolute paths
2. Each path is checked against the org's directory rules (highest priority wins)
3. If any path is denied, the entire tool call is rejected

This covers: `bash` commands, `read`/`write` tools, `git` operations, file searches, and any MCP tool that references paths.

### Rule Structure

```typescript
{
  pattern: "/app/src/**",    // Glob pattern (minimatch syntax)
  isAllowed: true,           // Allow or deny
  priority: 100,             // Higher = evaluated first
  roleIds: ["role-id"],      // Optional: restrict to specific roles
  description: "App source"  // For audit/admin UI
}
```

### Default Rules (seeded for new orgs)

| Pattern | Allow/Deny | Priority | Purpose |
|---------|------------|----------|---------|
| `$HOME/**` | Allow | 100 | User workspace |
| `/tmp/**` | Allow | 90 | Temp files |
| `/etc/**` | Deny | 200 | System config |
| `/sys/**`, `/proc/**` | Deny | 200 | Kernel interfaces |
| `**/node_modules/**` | Deny | 50 | Dependencies |
| `**/.git/**` | Deny | 50 | Git internals |

### Example: Restrict to Project Directory

```bash
# Deny everything by default
curl -X POST /api/directory-rules \
  -d '{"pattern": "/**", "isAllowed": false, "priority": 1}'

# Allow only the project
curl -X POST /api/directory-rules \
  -d '{"pattern": "/home/dev/myproject/**", "isAllowed": true, "priority": 100}'
```

---

## PII Detection Pipeline

PII detection runs at multiple points in the request lifecycle:

| Stage | What's Checked | Action on Detection |
|-------|----------------|---------------------|
| **Message intake** | User prompts, assistant responses | Log detection, optionally block |
| **Tool parameters** | Bash commands, file contents, API payloads | Redact before execution logging |
| **Audit logging** | All logged content | Redact before write |
| **Session storage** | Messages persisted to DB | Configurable: redact or flag |

### Built-in Patterns

- Email addresses, phone numbers (US)
- SSN, credit card numbers (Luhn-validated)
- API keys (AWS, GitHub, generic)
- JWT tokens, private keys (PEM)
- Database connection strings
- Passwords in config files

### Custom Patterns

```typescript
detector.addPatternFromString(
  "employee_id",
  /EMP-\d{6}/g,
  "[EMPLOYEE_ID]",
  "Internal employee IDs"
);
```

### Configuration

```bash
COMPOSER_PII_ENABLED=true           # Enable detection
COMPOSER_PII_BLOCK_ON_DETECT=false  # Block requests with PII (vs. redact and continue)
COMPOSER_PII_LOG_DETECTIONS=true    # Audit log PII events
```

---

## Model Approval & Spend Controls

### Approval Workflow

Models must be explicitly approved before use:

```bash
curl -X POST /api/model-approvals \
  -d '{
    "modelId": "claude-opus-4-6",
    "status": "approved",
    "tokenLimit": 1000000,
    "spendLimitCents": 5000,
    "allowedRoles": ["org_admin", "org_member"]
  }'
```

### Real-time Gating

**Executions are blocked before dispatch** when:

- Model is not approved for the org
- User's role is not in `allowedRoles`
- User has exceeded their token quota
- User has exceeded per-model spend limit
- Org has exceeded aggregate spend limit

The check happens synchronously before the LLM request is sent. No partial execution.

### Quota Structure

| Level | Configurable Limits |
|-------|---------------------|
| Organization | Total tokens/month, total spend/month |
| User | Tokens/month, spend/month |
| Per-model | Tokens/request, spend/request |

---

## Audit Logging

### What Gets Logged

| Category | Events |
|----------|--------|
| Authentication | Login, logout, token refresh, failed attempts |
| Sessions | Create, read, update, delete, share |
| Tool execution | Command, parameters (redacted), result status, duration |
| Model calls | Model ID, token counts, latency, cost |
| Admin actions | Role changes, user invites, org settings |
| Security events | Permission denials, PII detections, quota blocks |

### Log Schema

```typescript
{
  id: "uuid",
  orgId: "uuid",
  userId: "uuid",
  sessionId: "uuid | null",
  action: "tool.bash.execute",
  resource: "sessions/abc123",
  details: { /* redacted metadata */ },
  ipAddress: "192.168.1.1",
  userAgent: "...",
  createdAt: "2025-01-15T10:30:00Z"
}
```

### Retention & Export

```bash
COMPOSER_AUDIT_RETENTION_DAYS=90  # Auto-delete after 90 days
```

```bash
# Export for compliance
curl -X GET "/api/audit/export?format=csv&startDate=2025-01-01"
```

---

## Alerting System

### Alert Types

| Type | Trigger | Default Severity |
|------|---------|------------------|
| `token_quota_warning` | 80% of quota used | medium |
| `token_quota_exceeded` | 100% of quota used | high |
| `spend_limit_exceeded` | Spend limit reached | high |
| `pii_detected` | PII in session content | medium |
| `permission_denial_spike` | >10 denials in 5 min | high |
| `auth_failure_spike` | >5 failed logins in 5 min | critical |

### Deduplication

Alerts are deduplicated using a **time-window + pattern** rule:

- Same alert type + same user + same resource = dedupe for 15 minutes
- Same alert type + same org (no specific user) = dedupe for 5 minutes

This prevents alert storms while ensuring distinct incidents are reported.

### Webhook Configuration

```typescript
settings: {
  alertWebhooks: ["https://hooks.slack.com/..."],
  alertEmailRecipients: ["security@company.com"],
  alertMinSeverity: "medium"  // Don't send "info" or "low"
}
```

---

## Authentication

### Current: JWT + Password

- Passwords hashed with bcrypt (cost factor 12)
- Access tokens: 24h expiry (configurable)
- Refresh tokens: 7d expiry
- API keys: Hashed, prefix-only display

### Planned: SSO/OIDC

SSO integration is on the roadmap. The auth layer is designed for pluggable providers:

```typescript
// Future API (not yet implemented)
COMPOSER_AUTH_PROVIDER=oidc
COMPOSER_OIDC_ISSUER=https://login.company.com
COMPOSER_OIDC_CLIENT_ID=...
COMPOSER_OIDC_CLIENT_SECRET=...
```

Current JWT auth will remain available for service accounts and CLI access.

---

## Migration from Single-User Mode

### File-based Defaults (Single-User)

In single-user mode, Composer stores sessions in `~/.composer/agent/sessions/` as JSONL files. This is the default for CLI installations.

### Enterprise Equivalents

| Single-User | Enterprise |
|-------------|------------|
| `~/.composer/agent/sessions/*.jsonl` | `sessions` + `session_messages` tables |
| `~/.composer/config.json` | `organizations.settings` + `org_memberships` |
| No auth | JWT + RBAC |
| No audit | `audit_logs` table |

### Migration Command

```bash
# Migrate all JSONL sessions to database
bun run migrate:sessions --user-email admin@company.com --org-name "My Company"
```

This preserves: message history, favorites, summaries, model selections, timestamps.

---

## Environment Variables

### Required for Enterprise

```bash
COMPOSER_MULTI_TENANT=true
COMPOSER_DATABASE_URL=postgresql://host/composer?user=user&password=pass
COMPOSER_JWT_SECRET=$(openssl rand -hex 32)
```

### Optional

```bash
COMPOSER_DATABASE_TYPE=postgres          # or 'sqlite' for dev
COMPOSER_JWT_EXPIRY=24h
COMPOSER_AUDIT_ENABLED=true
COMPOSER_AUDIT_RETENTION_DAYS=90
COMPOSER_PII_ENABLED=true
COMPOSER_PII_BLOCK_ON_DETECT=false
```

---

## Architecture Details

### Database Schema

Core tables:

- `organizations` - Tenant with settings JSON
- `users` - Accounts (email, password hash, metadata)
- `org_memberships` - User ↔ Org ↔ Role relationship, quotas
- `roles` - System and custom roles
- `permissions` - Resource:action definitions
- `role_permissions` - Role ↔ Permission mapping
- `sessions` - Chat sessions
- `session_messages` - Individual messages
- `audit_logs` - Activity records
- `model_approvals` - Per-org model policies
- `directory_access_rules` - Path ACLs
- `api_keys` - Hashed API keys
- `alerts` - Generated alerts

### Technology Stack

- **ORM**: Drizzle ORM (type-safe, zero runtime overhead)
- **Database**: PostgreSQL (production), SQLite (dev/testing)
- **Auth**: JWT (jsonwebtoken), bcrypt
- **Path matching**: minimatch
- **PII detection**: Regex with Luhn validation for credit cards

---

## Troubleshooting

### "Permission denied" errors

```bash
# Check user's effective permissions
curl -X GET /api/auth/me -H "Authorization: Bearer $TOKEN"

# Check recent denial events
curl -X GET "/api/audit/logs?action=permission.denied&limit=10"
```

### Quota/spend blocks

```bash
# Check current usage
curl -X GET /api/usage/quota

# Check org-wide summary (admin only)
curl -X GET /api/usage/summary
```

### Directory access denied

```bash
# List active rules for debugging
curl -X GET /api/directory-rules

# Check why a specific path was denied (returns matched rule)
curl -X POST /api/directory-rules/check -d '{"path": "/etc/passwd"}'
```

---

## Support

For enterprise support, contact the EvalOps team or open an issue on GitHub.
