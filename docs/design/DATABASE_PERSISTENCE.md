# Database & Persistence Design

The database layer provides enterprise-grade storage with PostgreSQL for multi-tenant deployments and SQLite for local development. It supports encryption, migrations, and distributed locking.

## Overview

Database capabilities:

- **Drizzle ORM**: Type-safe database access
- **PostgreSQL/SQLite**: Flexible deployment options
- **Encryption**: At-rest encryption for sensitive data
- **Migrations**: Schema versioning and evolution
- **Distributed Locks**: Multi-instance coordination
- **Key Rotation**: Secure credential management

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Database Architecture                            │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                      Drizzle ORM                             │    │
│  │  - Type-safe queries                                        │    │
│  │  - Schema inference                                         │    │
│  │  - Migration generation                                     │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│           ┌──────────────────┼──────────────────┐                   │
│           ▼                  ▼                  ▼                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │
│  │ PostgreSQL     │  │ SQLite         │  │ In-Memory      │        │
│  │ (Enterprise)   │  │ (Local)        │  │ (Testing)      │        │
│  └────────────────┘  └────────────────┘  └────────────────┘        │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   Encryption Layer                           │    │
│  │  - AES-256-GCM for field encryption                         │    │
│  │  - Key derivation from master key                           │    │
│  │  - Automatic key rotation                                   │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Schema Overview

### Core Tables

| Table | Purpose |
|-------|---------|
| `organizations` | Multi-tenant organization units |
| `users` | User accounts and settings |
| `org_memberships` | User-organization relationships |
| `roles` | Permission role definitions |
| `permissions` | Granular permission actions |
| `role_permissions` | Role-permission mappings |
| `sessions` | Chat session metadata |
| `session_messages` | Individual messages |
| `audit_logs` | Activity audit trail |
| `api_keys` | API key storage |

### Supporting Tables

| Table | Purpose |
|-------|---------|
| `model_approvals` | Model access controls |
| `directory_access_rules` | Path-based permissions |
| `alerts` | System alerts |
| `webhook_deliveries` | Webhook queue |
| `revoked_tokens` | Token blacklist |
| `distributed_locks` | Instance coordination |
| `shared_sessions` | Session sharing links |

## Database Client

### Connection Management

```typescript
// src/db/client.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

class DatabaseClient {
  private connection: ReturnType<typeof postgres> | null = null;
  private db: ReturnType<typeof drizzle> | null = null;

  async connect(config: DatabaseConfig): Promise<void> {
    const connectionString = config.connectionString
      ?? this.buildConnectionString(config);

    this.connection = postgres(connectionString, {
      max: config.maxConnections ?? 10,
      idle_timeout: config.idleTimeout ?? 30,
      connect_timeout: config.connectTimeout ?? 10
    });

    this.db = drizzle(this.connection, { schema });

    // Test connection
    await this.connection`SELECT 1`;
  }

  getDb(): ReturnType<typeof drizzle> {
    if (!this.db) {
      throw new Error("Database not connected");
    }
    return this.db;
  }

  async disconnect(): Promise<void> {
    await this.connection?.end();
    this.connection = null;
    this.db = null;
  }
}

export const dbClient = new DatabaseClient();
```

### Query Examples

```typescript
// Type-safe queries with Drizzle

// Find user by email
const user = await db
  .select()
  .from(users)
  .where(eq(users.email, email))
  .limit(1);

// Join with relations
const sessionsWithMessages = await db
  .select()
  .from(sessions)
  .leftJoin(sessionMessages, eq(sessions.id, sessionMessages.sessionId))
  .where(eq(sessions.userId, userId))
  .orderBy(desc(sessions.updatedAt));

// Insert with returning
const [newSession] = await db
  .insert(sessions)
  .values({
    orgId,
    userId,
    model,
    title
  })
  .returning();

// Update with conditions
await db
  .update(sessions)
  .set({ updatedAt: new Date() })
  .where(
    and(
      eq(sessions.id, sessionId),
      eq(sessions.userId, userId)
    )
  );

// Transaction
await db.transaction(async (tx) => {
  await tx.insert(sessions).values(sessionData);
  await tx.insert(auditLogs).values(auditData);
});
```

## Migrations

### Migration Structure

```
src/db/migrations/
├── 0001_initial_schema.sql
├── 0002_add_api_keys.sql
├── 0003_add_2fa.sql
├── 0004_add_webhooks.sql
└── meta/
    └── _journal.json
```

### Migration Runner

```typescript
// src/db/migrate.ts
import { migrate } from "drizzle-orm/postgres-js/migrator";

async function runMigrations(): Promise<void> {
  const db = dbClient.getDb();

  await migrate(db, {
    migrationsFolder: "./src/db/migrations"
  });

  console.log("Migrations completed");
}
```

### Migration Example

```sql
-- 0002_add_api_keys.sql
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  scopes JSONB DEFAULT '[]',
  last_used_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX api_key_org_user_idx ON api_keys(org_id, user_id);
CREATE INDEX api_key_prefix_idx ON api_keys(key_prefix);
```

## Encryption

### Field Encryption

```typescript
// src/db/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

class FieldEncryption {
  private readonly algorithm = "aes-256-gcm";
  private readonly keyLength = 32;
  private readonly ivLength = 12;
  private readonly saltLength = 16;
  private readonly tagLength = 16;

  private deriveKey(masterKey: string, salt: Buffer): Buffer {
    return scryptSync(masterKey, salt, this.keyLength);
  }

  encrypt(plaintext: string, masterKey: string): string {
    const salt = randomBytes(this.saltLength);
    const key = this.deriveKey(masterKey, salt);
    const iv = randomBytes(this.ivLength);

    const cipher = createCipheriv(this.algorithm, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    // Format: salt:iv:tag:ciphertext (all base64)
    return [
      salt.toString("base64"),
      iv.toString("base64"),
      tag.toString("base64"),
      encrypted.toString("base64")
    ].join(":");
  }

  decrypt(encrypted: string, masterKey: string): string {
    const [saltB64, ivB64, tagB64, ciphertextB64] = encrypted.split(":");

    const salt = Buffer.from(saltB64, "base64");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(ciphertextB64, "base64");

    const key = this.deriveKey(masterKey, salt);
    const decipher = createDecipheriv(this.algorithm, key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString("utf8");
  }
}

export const fieldEncryption = new FieldEncryption();
```

### Settings Encryption

```typescript
// src/db/settings-encryption.ts
interface EncryptedSettings {
  version: number;
  data: string;  // Encrypted JSON
}

class SettingsEncryption {
  private readonly VERSION = 1;

  async encryptSettings(
    settings: Record<string, unknown>,
    masterKey: string
  ): Promise<EncryptedSettings> {
    const json = JSON.stringify(settings);
    const encrypted = fieldEncryption.encrypt(json, masterKey);

    return {
      version: this.VERSION,
      data: encrypted
    };
  }

  async decryptSettings(
    encrypted: EncryptedSettings,
    masterKey: string
  ): Promise<Record<string, unknown>> {
    if (encrypted.version !== this.VERSION) {
      throw new Error(`Unsupported encryption version: ${encrypted.version}`);
    }

    const json = fieldEncryption.decrypt(encrypted.data, masterKey);
    return JSON.parse(json);
  }
}
```

## Key Rotation

```typescript
// src/db/key-rotation.ts
class KeyRotationService {
  async rotateKey(
    oldKey: string,
    newKey: string,
    table: string,
    column: string
  ): Promise<{ rotated: number; errors: string[] }> {
    const errors: string[] = [];
    let rotated = 0;

    // Get all encrypted records
    const records = await db
      .select({ id: sql`id`, [column]: sql`${column}` })
      .from(sql`${table}`)
      .where(sql`${column} IS NOT NULL`);

    for (const record of records) {
      try {
        // Decrypt with old key
        const decrypted = fieldEncryption.decrypt(record[column], oldKey);

        // Re-encrypt with new key
        const reencrypted = fieldEncryption.encrypt(decrypted, newKey);

        // Update record
        await db
          .execute(sql`
            UPDATE ${table}
            SET ${column} = ${reencrypted}
            WHERE id = ${record.id}
          `);

        rotated++;
      } catch (error) {
        errors.push(`Failed to rotate ${table}.${record.id}: ${error.message}`);
      }
    }

    return { rotated, errors };
  }

  async verifyRotation(
    newKey: string,
    table: string,
    column: string
  ): Promise<{ valid: number; invalid: number }> {
    let valid = 0;
    let invalid = 0;

    const records = await db
      .select({ id: sql`id`, [column]: sql`${column}` })
      .from(sql`${table}`)
      .where(sql`${column} IS NOT NULL`);

    for (const record of records) {
      try {
        fieldEncryption.decrypt(record[column], newKey);
        valid++;
      } catch {
        invalid++;
      }
    }

    return { valid, invalid };
  }
}
```

## Distributed Locks

```typescript
// src/db/distributed-lock-manager.ts
class DistributedLockManager {
  private readonly instanceId: string;
  private readonly defaultTTL = 30000;  // 30 seconds

  constructor() {
    this.instanceId = `${os.hostname()}-${process.pid}-${Date.now()}`;
  }

  async acquireLock(
    lockId: string,
    ttlMs: number = this.defaultTTL
  ): Promise<boolean> {
    const expiresAt = new Date(Date.now() + ttlMs);

    try {
      // Try to insert new lock
      await db
        .insert(distributedLocks)
        .values({
          id: lockId,
          holderId: this.instanceId,
          acquiredAt: new Date(),
          expiresAt
        });

      return true;
    } catch (error) {
      // Lock exists, try to acquire if expired
      const [existing] = await db
        .select()
        .from(distributedLocks)
        .where(eq(distributedLocks.id, lockId));

      if (existing && existing.expiresAt < new Date()) {
        // Lock expired, try to take it
        const result = await db
          .update(distributedLocks)
          .set({
            holderId: this.instanceId,
            acquiredAt: new Date(),
            expiresAt
          })
          .where(
            and(
              eq(distributedLocks.id, lockId),
              lt(distributedLocks.expiresAt, new Date())
            )
          );

        return result.rowCount > 0;
      }

      return false;
    }
  }

  async releaseLock(lockId: string): Promise<boolean> {
    const result = await db
      .delete(distributedLocks)
      .where(
        and(
          eq(distributedLocks.id, lockId),
          eq(distributedLocks.holderId, this.instanceId)
        )
      );

    return result.rowCount > 0;
  }

  async extendLock(lockId: string, ttlMs: number = this.defaultTTL): Promise<boolean> {
    const expiresAt = new Date(Date.now() + ttlMs);

    const result = await db
      .update(distributedLocks)
      .set({ expiresAt })
      .where(
        and(
          eq(distributedLocks.id, lockId),
          eq(distributedLocks.holderId, this.instanceId)
        )
      );

    return result.rowCount > 0;
  }

  async withLock<T>(
    lockId: string,
    fn: () => Promise<T>,
    ttlMs: number = this.defaultTTL
  ): Promise<T> {
    const acquired = await this.acquireLock(lockId, ttlMs);

    if (!acquired) {
      throw new Error(`Failed to acquire lock: ${lockId}`);
    }

    try {
      // Set up auto-renewal
      const renewalInterval = setInterval(async () => {
        await this.extendLock(lockId, ttlMs);
      }, ttlMs / 2);

      try {
        return await fn();
      } finally {
        clearInterval(renewalInterval);
      }
    } finally {
      await this.releaseLock(lockId);
    }
  }
}

export const lockManager = new DistributedLockManager();
```

## Query Optimization

### Indexes

```sql
-- Session queries
CREATE INDEX session_org_user_idx ON sessions(org_id, user_id);
CREATE INDEX session_created_idx ON sessions(created_at);

-- Audit log queries
CREATE INDEX audit_log_org_user_idx ON audit_logs(org_id, user_id, created_at);
CREATE INDEX audit_log_action_idx ON audit_logs(action, created_at);
CREATE INDEX audit_log_trace_idx ON audit_logs(trace_id);

-- Message queries
CREATE INDEX session_message_session_idx ON session_messages(session_id, created_at);
CREATE INDEX session_message_pii_idx ON session_messages(has_pii);
```

### Connection Pooling

```typescript
const connection = postgres(connectionString, {
  max: 20,              // Max connections
  idle_timeout: 30,     // Close idle connections after 30s
  connect_timeout: 10,  // Connection timeout
  prepare: true,        // Use prepared statements
  types: {              // Custom type parsers
    date: {
      to: 1184,  // timestamp with timezone
      from: [1082, 1114, 1184],
      serialize: (x) => x.toISOString(),
      parse: (x) => new Date(x)
    }
  }
});
```

## Related Documentation

- [Enterprise RBAC](ENTERPRISE_RBAC.md) - Schema details
- [OAuth & Authentication](OAUTH_AUTHENTICATION.md) - Token storage
- [Session Persistence](SESSION_PERSISTENCE.md) - JSONL alternative
