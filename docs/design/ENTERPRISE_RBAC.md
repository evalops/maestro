# Enterprise RBAC & Audit Design

The enterprise system provides multi-tenancy, role-based access control (RBAC), audit logging, and compliance features for organizational deployments.

## Overview

Enterprise capabilities:

- **Multi-Tenancy**: Organization-level isolation
- **RBAC**: Fine-grained permission system
- **Audit Logging**: Tamper-evident activity tracking
- **PII Detection**: Automatic sensitive data identification
- **Directory Access Control**: Path-based restrictions
- **Token Quotas**: Per-user and per-org limits

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Enterprise Architecture                          │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │  Organizations  │  │     Users       │  │     Roles       │     │
│  │  - Settings     │◄─┤  - Memberships  │◄─┤  - Permissions  │     │
│  │  - Quotas       │  │  - Quotas       │  │  - System/Custom│     │
│  │  - Webhooks     │  │  - 2FA          │  │                 │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│           │                    │                    │               │
│           ▼                    ▼                    ▼               │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Permission Evaluator                       │  │
│  │  - API Layer: Can user perform action?                       │  │
│  │  - Tool Layer: Can user execute tool?                        │  │
│  │  - Directory Layer: Can user access path?                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│           │                    │                    │               │
│           ▼                    ▼                    ▼               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │  Audit Logs     │  │  Alerts         │  │  Model Approvals│     │
│  │  - Hash chain   │  │  - Quota limits │  │  - Per-org      │     │
│  │  - PII-safe     │  │  - PII detected │  │  - Spend limits │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

## Database Schema

### Organizations

```typescript
// src/db/schema.ts:58-78
const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  settings: jsonb("settings").$type<OrganizationSettings>().default({}),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at")
});
```

### Organization Settings

```typescript
// src/db/schema.ts:80-108
type OrganizationSettings = {
  maxTokensPerUser?: number;
  maxSessionsPerUser?: number;
  maxApiKeysPerUser?: number;
  allowedDirectories?: string[];    // Glob patterns
  deniedDirectories?: string[];     // Glob patterns
  piiRedactionEnabled?: boolean;
  piiPatterns?: string[];           // Custom regex patterns
  auditRetentionDays?: number;
  alertWebhooks?: string[];
  webhookSigningSecret?: string;    // HMAC signing
  ipAccessControl?: {
    defaultAction: "allow" | "deny";
    rules: Array<{
      pattern: string;              // CIDR or IP
      type: "allow" | "deny";
      description?: string;
    }>;
  };
  require2fa?: boolean;
  customModelRestrictions?: {
    providers?: string[];
    maxContextWindow?: number;
    requireApproval?: boolean;
  };
};
```

### Roles & Permissions

```typescript
// src/db/schema.ts:196-244
const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  isSystem: boolean("is_system").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});

const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  resource: varchar("resource", { length: 100 }).notNull(),
  action: varchar("action", { length: 50 }).notNull(),
  description: text("description")
});

const rolePermissions = pgTable("role_permissions", {
  roleId: uuid("role_id").references(() => roles.id),
  permissionId: uuid("permission_id").references(() => permissions.id)
});
```

### Built-in Roles

```typescript
// System roles (isSystem: true)
const SYSTEM_ROLES = [
  {
    name: "org_owner",
    permissions: ["*"]  // All permissions
  },
  {
    name: "org_admin",
    permissions: [
      "users:read", "users:write",
      "sessions:read", "sessions:write", "sessions:delete",
      "models:read", "models:write",
      "audit:read"
    ]
  },
  {
    name: "org_member",
    permissions: [
      "sessions:read", "sessions:write",
      "models:read",
      "tools:execute"
    ]
  },
  {
    name: "org_viewer",
    permissions: [
      "sessions:read",
      "models:read"
    ]
  }
];
```

## Permission System

### Permission Format

```
resource:action

Examples:
- sessions:read      - View sessions
- sessions:write     - Create/update sessions
- sessions:delete    - Delete sessions
- models:read        - View available models
- models:write       - Change model settings
- tools:execute      - Execute tools
- tools:bash         - Execute bash specifically
- audit:read         - View audit logs
- users:write        - Manage users
```

### Permission Evaluator

```typescript
// src/rbac/permission-evaluator.ts
class PermissionEvaluator {
  async canPerformAction(
    userId: string,
    orgId: string,
    resource: string,
    action: string
  ): Promise<boolean> {
    // 1. Get user's role in org
    const membership = await this.getMembership(userId, orgId);
    if (!membership) return false;

    // 2. Get role permissions
    const permissions = await this.getRolePermissions(membership.roleId);

    // 3. Check for matching permission
    const required = `${resource}:${action}`;
    return permissions.some(p =>
      p === "*" ||                    // Wildcard
      p === required ||               // Exact match
      p === `${resource}:*`           // Resource wildcard
    );
  }

  async canExecuteTool(
    userId: string,
    orgId: string,
    toolName: string
  ): Promise<boolean> {
    // Check general tool execution
    const canExecute = await this.canPerformAction(
      userId, orgId, "tools", "execute"
    );
    if (!canExecute) return false;

    // Check specific tool permission
    const specificPermission = await this.canPerformAction(
      userId, orgId, "tools", toolName
    );

    return specificPermission;
  }
}
```

## Directory Access Control

### Access Rules Table

```typescript
// src/db/schema.ts:454-473
const directoryAccessRules = pgTable("directory_access_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  pattern: varchar("pattern", { length: 500 }).notNull(),
  isAllowed: boolean("is_allowed").notNull(),
  roleIds: jsonb("role_ids").$type<string[]>(),
  description: text("description"),
  priority: integer("priority").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});
```

### Directory Access Evaluator

```typescript
class DirectoryAccessEvaluator {
  async canAccessPath(
    userId: string,
    orgId: string,
    path: string
  ): Promise<{ allowed: boolean; rule?: DirectoryAccessRule }> {
    // Get rules sorted by priority (descending)
    const rules = await this.getRulesByPriority(orgId);

    for (const rule of rules) {
      // Check if path matches pattern
      if (!minimatch(path, rule.pattern)) continue;

      // Check if rule applies to user's role
      if (rule.roleIds) {
        const userRoleId = await this.getUserRoleId(userId, orgId);
        if (!rule.roleIds.includes(userRoleId)) continue;
      }

      return {
        allowed: rule.isAllowed,
        rule
      };
    }

    // Default: allow if no rules match
    return { allowed: true };
  }
}
```

## Audit Logging

### Audit Log Schema

```typescript
// src/db/schema.ts:336-391
const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  userId: uuid("user_id").references(() => users.id),
  sessionId: uuid("session_id").references(() => sessions.id),
  action: varchar("action", { length: 100 }).notNull(),
  resourceType: varchar("resource_type", { length: 100 }),
  resourceId: uuid("resource_id"),
  status: auditStatusEnum("status").notNull(),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  requestId: varchar("request_id", { length: 100 }),
  traceId: varchar("trace_id", { length: 100 }),
  metadata: jsonb("metadata").$type<AuditMetadata>().default({}),
  durationMs: integer("duration_ms"),
  integrityHash: varchar("integrity_hash", { length: 64 }),
  previousHash: varchar("previous_hash", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull()
});
```

### Hash Chain for Tamper Detection

```typescript
class AuditLogger {
  private async computeIntegrityHash(
    entry: AuditLogEntry,
    previousHash: string | null
  ): Promise<string> {
    const payload = JSON.stringify({
      ...entry,
      previousHash
    });

    return crypto
      .createHash("sha256")
      .update(payload)
      .digest("hex");
  }

  async log(entry: Omit<AuditLogEntry, "integrityHash" | "previousHash">) {
    // Get last hash for this org
    const lastEntry = await this.getLastEntry(entry.orgId);
    const previousHash = lastEntry?.integrityHash ?? null;

    // Compute new hash
    const integrityHash = await this.computeIntegrityHash(entry, previousHash);

    // Insert with hash chain
    await db.insert(auditLogs).values({
      ...entry,
      integrityHash,
      previousHash
    });
  }

  async verifyChain(orgId: string): Promise<{
    valid: boolean;
    brokenAt?: string;
  }> {
    const entries = await this.getAllEntries(orgId);
    let previousHash: string | null = null;

    for (const entry of entries) {
      const expectedHash = await this.computeIntegrityHash(
        entry,
        previousHash
      );

      if (entry.integrityHash !== expectedHash) {
        return { valid: false, brokenAt: entry.id };
      }

      previousHash = entry.integrityHash;
    }

    return { valid: true };
  }
}
```

### Audit Events

| Action | Description | Metadata |
|--------|-------------|----------|
| `session.create` | New session started | `model`, `thinkingLevel` |
| `session.delete` | Session deleted | - |
| `tool.bash.execute` | Bash command run | `command` (redacted) |
| `tool.write.execute` | File written | `filePath` |
| `model.change` | Model switched | `oldModel`, `newModel` |
| `permission.denied` | Access denied | `deniedReason` |
| `pii.detected` | PII found | `patterns` |
| `auth.login` | User logged in | `method` |
| `auth.logout` | User logged out | - |

## Token Quotas

### Quota Tracking

```typescript
// src/db/schema.ts:163-190
const orgMemberships = pgTable("org_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  userId: uuid("user_id").references(() => users.id),
  roleId: uuid("role_id").references(() => roles.id),
  tokenQuota: integer("token_quota"),        // Override
  tokenUsed: integer("token_used").default(0).notNull(),
  quotaResetAt: timestamp("quota_reset_at"),
  joinedAt: timestamp("joined_at").defaultNow().notNull()
});
```

### Quota Enforcement

```typescript
class QuotaEnforcer {
  async checkAndDeduct(
    userId: string,
    orgId: string,
    tokensToUse: number
  ): Promise<{ allowed: boolean; remaining?: number }> {
    const membership = await this.getMembership(userId, orgId);
    const orgSettings = await this.getOrgSettings(orgId);

    // Get effective quota (user override or org default)
    const quota = membership.tokenQuota ?? orgSettings.maxTokensPerUser;

    if (!quota) {
      return { allowed: true };  // No limit
    }

    const newUsage = membership.tokenUsed + tokensToUse;

    if (newUsage > quota) {
      // Create alert
      await this.createQuotaAlert(userId, orgId, membership.tokenUsed, quota);
      return { allowed: false, remaining: quota - membership.tokenUsed };
    }

    // Deduct tokens
    await this.updateUsage(userId, orgId, newUsage);

    return { allowed: true, remaining: quota - newUsage };
  }

  async resetQuotas(orgId: string): Promise<void> {
    await db
      .update(orgMemberships)
      .set({
        tokenUsed: 0,
        quotaResetAt: new Date()
      })
      .where(eq(orgMemberships.orgId, orgId));
  }
}
```

## Model Approvals

### Model Approval Schema

```typescript
// src/db/schema.ts:410-448
const modelApprovals = pgTable("model_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  modelId: varchar("model_id", { length: 100 }).notNull(),
  provider: varchar("provider", { length: 100 }).notNull(),
  status: modelApprovalStatusEnum("status").notNull(),
  spendLimit: integer("spend_limit"),     // In cents
  spendUsed: integer("spend_used").default(0).notNull(),
  tokenLimit: integer("token_limit"),
  tokenUsed: integer("token_used").default(0).notNull(),
  restrictedToRoles: jsonb("restricted_to_roles").$type<string[]>(),
  metadata: jsonb("metadata").$type<ModelApprovalMetadata>(),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull()
});
```

### Model Access Check

```typescript
class ModelAccessController {
  async canUseModel(
    userId: string,
    orgId: string,
    modelId: string,
    provider: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    const approval = await this.getApproval(orgId, modelId);

    if (!approval) {
      const orgSettings = await this.getOrgSettings(orgId);
      if (orgSettings.customModelRestrictions?.requireApproval) {
        return { allowed: false, reason: "Model not approved" };
      }
      return { allowed: true };
    }

    if (approval.status !== "approved" && approval.status !== "auto_approved") {
      return { allowed: false, reason: `Model status: ${approval.status}` };
    }

    // Check role restriction
    if (approval.restrictedToRoles) {
      const userRoleId = await this.getUserRoleId(userId, orgId);
      if (!approval.restrictedToRoles.includes(userRoleId)) {
        return { allowed: false, reason: "Role not permitted for this model" };
      }
    }

    // Check spend limit
    if (approval.spendLimit && approval.spendUsed >= approval.spendLimit) {
      return { allowed: false, reason: "Model spend limit reached" };
    }

    return { allowed: true };
  }
}
```

## Alerts

### Alert Schema

```typescript
// src/db/schema.ts:479-508
const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  userId: uuid("user_id").references(() => users.id),
  severity: alertSeverityEnum("severity").notNull(),
  type: varchar("type", { length: 100 }).notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata").$type<AlertMetadata>().default({}),
  isRead: boolean("is_read").default(false).notNull(),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull()
});
```

### Alert Types

| Type | Severity | Trigger |
|------|----------|---------|
| `token_limit` | warning | 80% of quota used |
| `token_limit` | critical | 100% of quota used |
| `spend_limit` | warning | 80% of model spend |
| `pii_detected` | high | PII in tool output |
| `permission_denied` | medium | Access attempt denied |
| `auth_failure` | high | Failed login attempts |

## Webhooks

### Webhook Delivery

```typescript
// src/db/schema.ts:597-640
const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").references(() => organizations.id),
  url: text("url").notNull(),
  payload: jsonb("payload").notNull(),
  signature: varchar("signature", { length: 200 }),
  status: webhookDeliveryStatusEnum("status").default("pending"),
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(5).notNull(),
  nextRetryAt: timestamp("next_retry_at"),
  lastError: text("last_error"),
  lastStatusCode: integer("last_status_code"),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull()
});
```

### Webhook Signing

```typescript
class WebhookSigner {
  sign(payload: unknown, secret: string): string {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signaturePayload = `${timestamp}.${body}`;

    const signature = crypto
      .createHmac("sha256", secret)
      .update(signaturePayload)
      .digest("hex");

    return `t=${timestamp},v1=${signature}`;
  }

  verify(
    payload: string,
    signature: string,
    secret: string,
    tolerance = 300  // 5 minutes
  ): boolean {
    const parts = Object.fromEntries(
      signature.split(",").map(p => p.split("="))
    );

    const timestamp = parseInt(parts.t, 10);
    const now = Math.floor(Date.now() / 1000);

    if (Math.abs(now - timestamp) > tolerance) {
      return false;  // Replay attack protection
    }

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(parts.v1),
      Buffer.from(expectedSignature)
    );
  }
}
```

## Related Documentation

- [Database & Persistence](DATABASE_PERSISTENCE.md) - Schema details
- [Safety & Firewall](SAFETY_FIREWALL.md) - Policy enforcement
- [OAuth & Authentication](OAUTH_AUTHENTICATION.md) - User authentication
