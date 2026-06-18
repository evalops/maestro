CREATE TABLE IF NOT EXISTS "operating_layer_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"session_id" varchar(255),
	"capability_id" varchar(64) NOT NULL,
	"evidence_kind" varchar(128) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'recorded' NOT NULL,
	"score" integer,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "operating_layer_evidence_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operating_layer_evidence_capability_recorded_idx"
	ON "operating_layer_evidence" ("capability_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operating_layer_evidence_org_recorded_idx"
	ON "operating_layer_evidence" ("org_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operating_layer_evidence_session_recorded_idx"
	ON "operating_layer_evidence" ("session_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operating_layer_evidence_expiry_idx"
	ON "operating_layer_evidence" ("expires_at");
