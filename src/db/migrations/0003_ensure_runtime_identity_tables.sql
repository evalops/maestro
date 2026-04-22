CREATE TABLE IF NOT EXISTS "revoked_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_type" varchar(20) NOT NULL,
	"user_id" uuid,
	"org_id" uuid,
	"reason" varchar(100),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" uuid,
	CONSTRAINT "revoked_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_revocation_timestamps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"revoked_before" timestamp with time zone NOT NULL,
	"reason" varchar(100) NOT NULL,
	"revoked_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_revocation_timestamps_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "totp_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "totp_rate_limits_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "totp_used_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "distributed_locks" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"holder_id" varchar(100) NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "revoked_token_hash_idx" ON "revoked_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revoked_token_user_idx" ON "revoked_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revoked_token_expires_idx" ON "revoked_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_revocation_user_idx" ON "user_revocation_timestamps" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "totp_rate_limit_user_idx" ON "totp_rate_limits" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "totp_rate_limit_locked_idx" ON "totp_rate_limits" USING btree ("locked_until");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "totp_used_code_user_idx" ON "totp_used_codes" USING btree ("user_id","code_hash","window_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "totp_used_code_window_idx" ON "totp_used_codes" USING btree ("window_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distributed_lock_expires_idx" ON "distributed_locks" USING btree ("expires_at");
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revoked_tokens_user_id_users_id_fk') THEN
			ALTER TABLE "revoked_tokens" ADD CONSTRAINT "revoked_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revoked_tokens_revoked_by_users_id_fk') THEN
			ALTER TABLE "revoked_tokens" ADD CONSTRAINT "revoked_tokens_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_revocation_timestamps_user_id_users_id_fk') THEN
			ALTER TABLE "user_revocation_timestamps" ADD CONSTRAINT "user_revocation_timestamps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_revocation_timestamps_revoked_by_users_id_fk') THEN
			ALTER TABLE "user_revocation_timestamps" ADD CONSTRAINT "user_revocation_timestamps_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'totp_rate_limits_user_id_users_id_fk') THEN
			ALTER TABLE "totp_rate_limits" ADD CONSTRAINT "totp_rate_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'totp_used_codes_user_id_users_id_fk') THEN
			ALTER TABLE "totp_used_codes" ADD CONSTRAINT "totp_used_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
		END IF;
	END IF;

	IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN
		IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'revoked_tokens_org_id_organizations_id_fk') THEN
			ALTER TABLE "revoked_tokens" ADD CONSTRAINT "revoked_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
		END IF;
	END IF;
END $$;
