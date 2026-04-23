CREATE TABLE IF NOT EXISTS "execution_traces" (
	"trace_id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "execution_trace_workspace_created_idx"
	ON "execution_traces" ("workspace_id", "created_at");

CREATE INDEX IF NOT EXISTS "execution_trace_agent_created_idx"
	ON "execution_traces" ("agent_id", "created_at");

CREATE INDEX IF NOT EXISTS "execution_trace_status_created_idx"
	ON "execution_traces" ("status", "created_at");
