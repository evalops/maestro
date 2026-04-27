CREATE TABLE IF NOT EXISTS "audit_hash_cache" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"last_hash" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('public.organizations') IS NOT NULL
		AND NOT EXISTS (
			SELECT 1
			FROM pg_constraint
			WHERE conname = 'audit_hash_cache_org_id_organizations_id_fk'
				AND conrelid = 'public.audit_hash_cache'::regclass
		)
	THEN
		ALTER TABLE "audit_hash_cache"
			ADD CONSTRAINT "audit_hash_cache_org_id_organizations_id_fk"
			FOREIGN KEY ("org_id")
			REFERENCES "public"."organizations"("id")
			ON DELETE cascade
			ON UPDATE no action;
	END IF;
END $$;
