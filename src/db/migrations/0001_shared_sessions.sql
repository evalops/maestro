-- Add shared_sessions table for database-backed session sharing
CREATE TABLE IF NOT EXISTS "shared_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_token" varchar(64) NOT NULL UNIQUE,
	"session_id" varchar(255) NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"max_accesses" integer,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shared_session_token_idx" ON "shared_sessions" USING btree ("share_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_session_session_idx" ON "shared_sessions" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_session_expires_idx" ON "shared_sessions" USING btree ("expires_at");
