CREATE TABLE IF NOT EXISTS "workspace_config" (
	"workspace_id" varchar(255) PRIMARY KEY NOT NULL,
	"model_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safety_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rate_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "workspace_config_updated_idx"
	ON "workspace_config" ("updated_at");
