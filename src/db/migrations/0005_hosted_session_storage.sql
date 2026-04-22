CREATE TABLE IF NOT EXISTS "hosted_sessions" (
	"session_id" varchar(128) PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"subject" text,
	"title" varchar(255),
	"summary" text,
	"resume_summary" text,
	"memory_extraction_hash" varchar(64),
	"favorite" boolean DEFAULT false NOT NULL,
	"tags" jsonb,
	"cwd" text,
	"model" varchar(255),
	"thinking_level" varchar(50),
	"system_prompt" text,
	"prompt_metadata" jsonb,
	"model_metadata" jsonb,
	"tools" jsonb,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hosted_session_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"sequence" bigserial NOT NULL,
	"entry_type" varchar(64) NOT NULL,
	"entry_id" varchar(128),
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_session_entries_session_id_hosted_sessions_session_id_fk"
		FOREIGN KEY ("session_id")
		REFERENCES "public"."hosted_sessions"("session_id")
		ON DELETE cascade
		ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hosted_session_scope_updated_idx" ON "hosted_sessions" USING btree ("scope", "updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hosted_session_scope_id_idx" ON "hosted_sessions" USING btree ("scope", "session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hosted_session_subject_updated_idx" ON "hosted_sessions" USING btree ("subject", "updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hosted_session_entry_session_sequence_idx" ON "hosted_session_entries" USING btree ("session_id", "sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hosted_session_entry_type_idx" ON "hosted_session_entries" USING btree ("session_id", "entry_type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hosted_session_entry_session_entry_idx"
	ON "hosted_session_entries" USING btree ("session_id", "entry_id")
	WHERE "entry_id" IS NOT NULL;
