CREATE TABLE IF NOT EXISTS "revenue_attribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"action_id" varchar(255),
	"trace_id" varchar(255),
	"outcome_id" varchar(255) NOT NULL,
	"outcome_type" varchar(100) NOT NULL,
	"attribution_model" varchar(50) DEFAULT 'direct' NOT NULL,
	"attribution_weight_bps" integer DEFAULT 10000 NOT NULL,
	"revenue_usd_micros" bigint DEFAULT 0 NOT NULL,
	"pipeline_value_usd_micros" bigint DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "revenue_attribution_workspace_agent_occurred_idx"
	ON "revenue_attribution" ("workspace_id", "agent_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "revenue_attribution_agent_occurred_idx"
	ON "revenue_attribution" ("agent_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "revenue_attribution_outcome_idx"
	ON "revenue_attribution" ("outcome_id", "outcome_type");

CREATE INDEX IF NOT EXISTS "revenue_attribution_trace_idx"
	ON "revenue_attribution" ("trace_id");
