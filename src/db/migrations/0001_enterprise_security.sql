-- Migration: Enterprise Security Features
-- Description: Add tables for token revocation, TOTP, webhooks, audit integrity, and distributed locks

-- ============================================================================
-- Token Revocation
-- ============================================================================

CREATE TABLE IF NOT EXISTS revoked_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    token_type VARCHAR(20) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    reason VARCHAR(100),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    revoked_by UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS revoked_token_hash_idx ON revoked_tokens(token_hash);
CREATE INDEX IF NOT EXISTS revoked_token_user_idx ON revoked_tokens(user_id);
CREATE INDEX IF NOT EXISTS revoked_token_expires_idx ON revoked_tokens(expires_at);

-- ============================================================================
-- User Revocation Timestamps (for "revoke all tokens" feature)
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_revocation_timestamps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    revoked_before TIMESTAMP WITH TIME ZONE NOT NULL,
    reason VARCHAR(100) NOT NULL,
    revoked_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS user_revocation_user_idx ON user_revocation_timestamps(user_id);

-- ============================================================================
-- TOTP Rate Limits (distributed rate limiting)
-- ============================================================================

CREATE TABLE IF NOT EXISTS totp_rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    attempts INTEGER DEFAULT 0 NOT NULL,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    locked_until TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS totp_rate_limit_user_idx ON totp_rate_limits(user_id);
CREATE INDEX IF NOT EXISTS totp_rate_limit_locked_idx ON totp_rate_limits(locked_until);

-- ============================================================================
-- TOTP Used Codes (replay protection)
-- ============================================================================

CREATE TABLE IF NOT EXISTS totp_used_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash VARCHAR(64) NOT NULL,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS totp_used_code_user_idx ON totp_used_codes(user_id, code_hash, window_start);
CREATE INDEX IF NOT EXISTS totp_used_code_window_idx ON totp_used_codes(window_start);

-- ============================================================================
-- Webhook Deliveries
-- ============================================================================

DO $$ BEGIN
    CREATE TYPE webhook_delivery_status AS ENUM ('pending', 'delivered', 'failed', 'retrying');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    payload JSONB NOT NULL,
    signature VARCHAR(200),
    status webhook_delivery_status DEFAULT 'pending' NOT NULL,
    attempts INTEGER DEFAULT 0 NOT NULL,
    max_attempts INTEGER DEFAULT 5 NOT NULL,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    last_status_code INTEGER,
    last_response_time_ms INTEGER,
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_delivery_org_status_idx ON webhook_deliveries(org_id, status);
CREATE INDEX IF NOT EXISTS webhook_delivery_retry_idx ON webhook_deliveries(status, next_retry_at);

-- ============================================================================
-- Distributed Locks
-- ============================================================================

CREATE TABLE IF NOT EXISTS distributed_locks (
    id VARCHAR(100) PRIMARY KEY,
    holder_id VARCHAR(100) NOT NULL,
    acquired_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS distributed_lock_expires_idx ON distributed_locks(expires_at);

-- ============================================================================
-- Audit Hash Cache (multi-instance consistency)
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_hash_cache (
    org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    last_hash VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- ============================================================================
-- Add new columns to existing tables
-- ============================================================================

-- Add integrity hash columns to audit_logs if not exists
DO $$ BEGIN
    ALTER TABLE audit_logs ADD COLUMN integrity_hash VARCHAR(64);
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE audit_logs ADD COLUMN previous_hash VARCHAR(64);
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- Add index for audit log chain verification
CREATE INDEX IF NOT EXISTS audit_log_org_created_idx ON audit_logs(org_id, created_at);
