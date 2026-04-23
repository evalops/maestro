CREATE TABLE IF NOT EXISTS "usage_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"last_session_id" varchar(255),
	"provider" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_metric_dimension_idx" ON "usage_metrics" USING btree ("workspace_id","agent_id","provider","model","bucket_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_metric_workspace_bucket_idx" ON "usage_metrics" USING btree ("workspace_id","bucket_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_metric_agent_bucket_idx" ON "usage_metrics" USING btree ("agent_id","bucket_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_metric_model_bucket_idx" ON "usage_metrics" USING btree ("provider","model","bucket_start");
