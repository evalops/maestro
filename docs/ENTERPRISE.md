# Composer Enterprise Features

This document describes the enterprise features added to Composer for multi-tenant deployments, RBAC, audit logging, and security controls.

## Features Overview

### 1. **Multi-Tenancy & Organizations**
- Organizations with isolated resources
- User management with invitations
- Org-scoped sessions, models, and configurations

### 2. **Role-Based Access Control (RBAC)**
- Built-in roles: `org_owner`, `org_admin`, `org_member`, `org_viewer`
- Custom roles per organization
- Granular permissions: `resource:action` (e.g., `sessions:write`, `models:execute`)
- Resource ownership checks

### 3. **Audit Logging**
- Comprehensive logging of all user actions
- Tool execution tracking with command redaction
- Session activity monitoring
- Security event logging (failed auth, permission denials)
- CSV export for compliance
- Configurable retention policies

### 4. **PII Detection & Redaction**
- Automatic detection of sensitive data (emails, SSNs, credit cards, API keys, etc.)
- Regex-based pattern matching with custom patterns
- Command-line argument redaction
- Environment variable filtering
- Content redaction before storage

### 5. **Directory Access Controls**
- Allowlist/denylist with glob patterns
- Role-based path restrictions
- Priority-based rule matching
- Default safe/restricted directories

### 6. **Token & Spend Tracking**
- Per-user token quotas
- Per-model spend limits
- Real-time usage monitoring
- Threshold alerts (80%, 100%)
- Organization-wide usage summaries

### 7. **Model Approval Workflow**
- Approve/deny models per organization
- Spend and token limits per model
- Auto-approval rules based on metadata
- Role-based model restrictions

### 8. **Alerting System**
- Threshold-based alerts (quota, spend, security events)
- Severity levels (critical, high, medium, low, info)
- Webhook notifications (configurable)
- Alert deduplication

## Architecture

### Database Schema

The system uses a PostgreSQL/SQLite database with the following core tables:

- `organizations` - Tenants with settings
- `users` - User accounts with optional password auth
- `org_memberships` - User-org relationships with roles and quotas
- `roles` & `permissions` - RBAC system
- `sessions` & `session_messages` - Chat sessions (migrated from JSONL)
- `audit_logs` - Comprehensive activity tracking
- `model_approvals` - Model usage policies
- `directory_access_rules` - File system access controls
- `alerts` - Notifications and warnings
- `api_keys` - Programmatic access tokens

### Technology Stack

- **ORM**: Drizzle ORM (type-safe, performant)
- **Auth**: JWT with bcrypt password hashing
- **PII Detection**: Regex-based with extensible patterns
- **Path Matching**: minimatch for glob patterns
- **Database**: PostgreSQL (production) or SQLite (dev/single-user)

## Getting Started

### 1. Environment Variables

```bash
# Multi-tenant mode
COMPOSER_MULTI_TENANT=true

# Database
COMPOSER_DATABASE_TYPE=postgres  # or 'sqlite'
COMPOSER_DATABASE_URL=postgresql://user:pass@localhost/composer

# JWT Authentication
COMPOSER_JWT_SECRET=your-secure-secret-key
COMPOSER_JWT_EXPIRY=24h

# Audit Logging
COMPOSER_AUDIT_ENABLED=true
COMPOSER_AUDIT_RETENTION_DAYS=90

# PII Redaction
COMPOSER_PII_ENABLED=true
```

### 2. Database Migration

```bash
# Generate migrations (after schema changes)
bun run db:generate

# Run migrations
bun run db:migrate

# Seed default permissions and roles
bun run db:seed
```

### 3. User Registration & Login

```bash
# Register a new user (creates org automatically)
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "name": "Admin User",
    "password": "SecurePass123!",
    "orgName": "Acme Corp"
  }'

# Login
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "SecurePass123!"
  }'
```

### 4. Using the API with JWT

```bash
# All authenticated requests require Bearer token
curl -X GET http://localhost:8080/api/auth/me \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# Check usage quota
curl -X GET http://localhost:8080/api/usage/quota \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

# View audit logs (requires permission)
curl -X GET http://localhost:8080/api/audit/logs \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

## RBAC Permission Model

### Built-in Roles

| Role | Permissions | Use Case |
|------|-------------|----------|
| **org_owner** | Full access (`*:*`) | Organization owner |
| **org_admin** | Manage sessions, models, configs, view users | Team lead |
| **org_member** | Create/manage own sessions, execute models | Developer |
| **org_viewer** | Read-only access | Stakeholder, auditor |

### Resources

- `sessions` - Chat sessions
- `models` - Model selection/execution
- `users` - User management
- `orgs` - Organization settings
- `audit` - Audit log access
- `config` - Configuration management
- `tools` - Tool execution (bash, git, etc.)
- `api_keys` - API key management
- `roles` - Role management
- `directories` - File system access

### Actions

- `read` - View resources
- `write` - Create/update resources
- `delete` - Delete resources
- `execute` - Execute operations (models, tools)
- `admin` - Administrative actions
- `*` - All actions

### Example: Check Permission

```typescript
import { PermissionChecker, RESOURCES, ACTIONS } from "./src/rbac/permissions.js";

const allowed = await PermissionChecker.check(
  { userId: "user-id", orgId: "org-id", roleId: "role-id" },
  RESOURCES.SESSIONS,
  ACTIONS.WRITE
);
```

## Directory Access Control

### Default Rules

The system seeds these default rules for new organizations:

```typescript
// Allowed
/home/user/**        - User home directory
/tmp/**              - Temporary directory

// Denied
/etc/**              - System configuration
/sys/**              - System files
/proc/**             - Process information
**/node_modules/**   - Dependencies
**/.git/**           - Git internals
```

### Custom Rules

Add organization-specific rules via API:

```bash
curl -X POST http://localhost:8080/api/directory-rules \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pattern": "/app/src/**",
    "isAllowed": true,
    "priority": 100,
    "description": "Allow access to application source"
  }'
```

## PII Detection

### Built-in Patterns

- Email addresses
- Phone numbers (US format)
- Social Security Numbers
- Credit card numbers
- API keys (generic, AWS, GitHub)
- JWT tokens
- IPv4 addresses
- Private keys (PEM format)
- Database connection strings
- Passwords in config

### Custom Patterns

Add custom PII patterns per organization:

```typescript
import { getGlobalPiiDetector } from "./src/security/pii-detector.js";

const detector = getGlobalPiiDetector();
detector.addPatternFromString(
  "employee_id",
  /EMP-\d{6}/g,
  "[EMPLOYEE_ID_REDACTED]",
  "Employee ID numbers"
);
```

### Usage

```typescript
import { redactPii, hasPii } from "./src/security/pii-detector.js";

const content = "Contact me at john@example.com or call 555-123-4567";
const redacted = redactPii(content);
// "Contact me at [EMAIL_REDACTED] or call [PHONE_REDACTED]"

if (hasPii(content)) {
  console.log("PII detected!");
}
```

## Audit Logging

### What Gets Logged

1. **Authentication**: Login, logout, failed attempts, token refresh
2. **Resource Access**: Session CRUD, model selection, config changes
3. **Tool Execution**: Bash commands, file operations, git commands (with redaction)
4. **Administrative Actions**: User/role changes, org settings
5. **Security Events**: Permission denials, PII detection, quota violations

### Example: Query Audit Logs

```typescript
import { AuditLogger } from "./src/audit/logger.js";

const logs = await AuditLogger.query({
  orgId: "org-id",
  userId: "user-id",
  action: "tool.bash.execute",
  startDate: new Date("2025-01-01"),
  limit: 100,
});
```

### Export to CSV

```typescript
const csv = await AuditLogger.exportToCsv({
  orgId: "org-id",
  startDate: new Date("2025-01-01"),
  endDate: new Date("2025-01-31"),
});
```

## Token & Spend Tracking

### Set User Quota

```typescript
import { getDb } from "./src/db/client.js";
import { orgMemberships } from "./src/db/schema.js";

await getDb().update(orgMemberships)
  .set({ tokenQuota: 1_000_000 }) // 1M tokens per month
  .where(eq(orgMemberships.userId, "user-id"));
```

### Track Usage

```typescript
import { TokenTracker } from "./src/billing/token-tracker.js";

await TokenTracker.recordUsage(
  {
    sessionId: "session-id",
    modelId: "claude-sonnet-4-5",
    provider: "anthropic",
    tokenCount: 1500,
    estimatedCost: 45, // cents
  },
  {
    orgId: "org-id",
    userId: "user-id",
  }
);
```

### Usage Summary

```typescript
const summary = await TokenTracker.getOrgUsageSummary("org-id");
// {
//   totalTokens: 5_000_000,
//   totalSessions: 150,
//   totalUsers: 10,
//   topUsers: [...],
//   modelBreakdown: [...]
// }
```

## Alerting

### Alert Types

- `token_quota_warning` - 80% quota reached
- `token_quota_exceeded` - Quota exceeded
- `spend_limit_exceeded` - Spend limit exceeded
- `permission_denial_spike` - Multiple permission denials
- `pii_detected` - PII found in session
- `auth_failure_spike` - Multiple failed logins

### Webhook Notifications

Configure in organization settings:

```typescript
await getDb().update(organizations)
  .set({
    settings: {
      alertWebhooks: [
        "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
      ]
    }
  })
  .where(eq(organizations.id, "org-id"));
```

## Migration from JSONL Sessions

### Automatic Migration

The system includes a migration tool to import existing JSONL sessions:

```bash
bun run migrate:sessions
```

This will:
1. Scan `~/.composer/agent/sessions/` for JSONL files
2. Create a default organization for the user
3. Import all sessions with their full message history
4. Preserve metadata (favorites, summaries, model selections)

### Manual Migration

```typescript
import { migrateJsonlSession } from "./src/db/migrate-sessions.js";

await migrateJsonlSession({
  filePath: "~/.composer/agent/sessions/abc123.jsonl",
  userId: "user-id",
  orgId: "org-id",
});
```

## Backward Compatibility

### Single-User Mode

Set `COMPOSER_MULTI_TENANT=false` to disable enterprise features and use the original file-based system:

```bash
export COMPOSER_MULTI_TENANT=false
composer
```

### Hybrid Mode

Use database for enterprise users while keeping JSONL for CLI-only users:

```bash
export COMPOSER_HYBRID_MODE=true
composer --no-auth  # Uses JSONL
composer web        # Uses database
```

## Security Best Practices

1. **JWT Secret**: Use a strong random secret (`openssl rand -hex 32`)
2. **Password Policy**: Enforce minimum 8 chars with uppercase, lowercase, number, special char
3. **API Keys**: Hash with bcrypt, show prefix only
4. **Rate Limiting**: Configure per-IP and per-user limits
5. **Audit Retention**: Set to 90+ days for compliance
6. **PII Redaction**: Enable by default in production
7. **Directory Rules**: Use allowlist approach (deny by default)
8. **HTTPS Only**: Run behind reverse proxy with TLS

## Performance Considerations

- **Permission Cache**: 5-minute TTL, clear on role changes
- **Directory Rules Cache**: 5-minute TTL, clear on rule updates
- **Audit Log Partitioning**: Consider partitioning by month for large datasets
- **Database Indexes**: All foreign keys and frequently queried columns indexed
- **SQLite vs PostgreSQL**: Use PostgreSQL for >10 concurrent users

## Troubleshooting

### Permission Denied Errors

```bash
# Check user's role and permissions
curl -X GET http://localhost:8080/api/auth/me \
  -H "Authorization: Bearer YOUR_TOKEN"

# View recent audit logs for denials
curl -X GET http://localhost:8080/api/audit/logs?action=permission.denied \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Quota Issues

```bash
# Check current quota
curl -X GET http://localhost:8080/api/usage/quota \
  -H "Authorization: Bearer YOUR_TOKEN"

# Reset quota (admin only)
curl -X POST http://localhost:8080/api/usage/reset \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Database Connection Errors

```bash
# Test database connection
bun run db:check

# Run migrations
bun run db:migrate

# Verify schema
bun run db:studio  # Opens Drizzle Studio
```

## API Reference

See [API.md](./API.md) for complete endpoint documentation.

## Support

For issues, questions, or feature requests, please open an issue on GitHub or contact the EvalOps team.
