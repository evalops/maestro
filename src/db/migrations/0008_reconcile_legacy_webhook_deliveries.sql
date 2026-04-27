CREATE OR REPLACE FUNCTION maestro_reconcile_webhook_payload(value text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
BEGIN
	RETURN value::jsonb;
EXCEPTION WHEN others THEN
	RETURN jsonb_build_object('legacy_payload', value);
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_type t
		JOIN pg_namespace n ON n.oid = t.typnamespace
		WHERE n.nspname = 'public' AND t.typname = 'webhook_delivery_status'
	) THEN
		CREATE TYPE "webhook_delivery_status" AS ENUM (
			'pending',
			'delivered',
			'failed',
			'retrying'
		);
	END IF;
END $$;
--> statement-breakpoint
ALTER TYPE "webhook_delivery_status" ADD VALUE IF NOT EXISTS 'pending';
--> statement-breakpoint
ALTER TYPE "webhook_delivery_status" ADD VALUE IF NOT EXISTS 'delivered';
--> statement-breakpoint
ALTER TYPE "webhook_delivery_status" ADD VALUE IF NOT EXISTS 'failed';
--> statement-breakpoint
ALTER TYPE "webhook_delivery_status" ADD VALUE IF NOT EXISTS 'retrying';
--> statement-breakpoint
DO $$
DECLARE
	payload_type text;
	status_type text;
BEGIN
	IF to_regclass('public.webhook_deliveries') IS NULL THEN
		RETURN;
	END IF;

	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "org_id" uuid;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "url" text;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "payload" jsonb;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "signature" varchar(200);
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "status" "webhook_delivery_status";
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "max_attempts" integer DEFAULT 5;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "last_error" text;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "last_status_code" integer;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "last_response_time_ms" integer;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;
	ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();

	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'webhook_deliveries'
			AND column_name = 'organization_id'
	) THEN
		UPDATE "webhook_deliveries"
		SET "org_id" = "organization_id"
		WHERE "org_id" IS NULL;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'webhook_deliveries'
			AND column_name = 'next_attempt_at'
	) THEN
		UPDATE "webhook_deliveries"
		SET "next_retry_at" = "next_attempt_at"
		WHERE "next_retry_at" IS NULL;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'webhook_deliveries'
			AND column_name = 'error'
	) THEN
		UPDATE "webhook_deliveries"
		SET "last_error" = "error"
		WHERE "last_error" IS NULL;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'webhook_deliveries'
			AND column_name = 'response_status'
	) THEN
		UPDATE "webhook_deliveries"
		SET "last_status_code" = "response_status"
		WHERE "last_status_code" IS NULL;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'webhook_deliveries'
			AND column_name = 'completed_at'
	) THEN
		UPDATE "webhook_deliveries"
		SET "delivered_at" = "completed_at"
		WHERE "delivered_at" IS NULL;
	END IF;

	SELECT data_type
	INTO payload_type
	FROM information_schema.columns
	WHERE table_schema = 'public'
		AND table_name = 'webhook_deliveries'
		AND column_name = 'payload';

	IF payload_type IS NOT NULL AND payload_type <> 'jsonb' THEN
		ALTER TABLE "webhook_deliveries"
			ALTER COLUMN "payload" TYPE jsonb
			USING maestro_reconcile_webhook_payload("payload"::text);
	END IF;

	SELECT udt_name
	INTO status_type
	FROM information_schema.columns
	WHERE table_schema = 'public'
		AND table_name = 'webhook_deliveries'
		AND column_name = 'status';

	IF status_type IS NOT NULL AND status_type <> 'webhook_delivery_status' THEN
		ALTER TABLE "webhook_deliveries"
			ALTER COLUMN "status" TYPE "webhook_delivery_status"
			USING (
				CASE
					WHEN "status"::text IN ('pending', 'delivered', 'failed', 'retrying')
						THEN "status"::text::"webhook_delivery_status"
					WHEN "status"::text IN ('completed', 'sent', 'success')
						THEN 'delivered'::"webhook_delivery_status"
					ELSE 'failed'::"webhook_delivery_status"
				END
			);
	END IF;

	IF status_type = 'webhook_delivery_status' THEN
		UPDATE "webhook_deliveries"
		SET "status" = (
			CASE
				WHEN "status"::text IN ('completed', 'sent', 'success') THEN 'delivered'
				ELSE 'failed'
			END
		)::"webhook_delivery_status"
		WHERE "status" IS NOT NULL
			AND "status"::text NOT IN ('pending', 'delivered', 'failed', 'retrying');
	END IF;

	UPDATE "webhook_deliveries" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
	UPDATE "webhook_deliveries" SET "payload" = '{}'::jsonb WHERE "payload" IS NULL;
	UPDATE "webhook_deliveries" SET "status" = 'failed' WHERE "status" IS NULL;
	UPDATE "webhook_deliveries" SET "attempts" = 0 WHERE "attempts" IS NULL;
	UPDATE "webhook_deliveries" SET "max_attempts" = 5 WHERE "max_attempts" IS NULL;
	UPDATE "webhook_deliveries" SET "created_at" = now() WHERE "created_at" IS NULL;
	UPDATE "webhook_deliveries" SET "url" = '' WHERE "url" IS NULL;
	UPDATE "webhook_deliveries"
	SET
		"status" = 'failed',
		"last_error" = COALESCE(
			"last_error",
			'legacy webhook delivery row has no target url after schema reconciliation'
		)
	WHERE "url" = '' AND "status"::text IN ('pending', 'retrying');

	ALTER TABLE "webhook_deliveries" ALTER COLUMN "payload" SET NOT NULL;
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" SET DEFAULT 'pending';
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" SET NOT NULL;
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "attempts" SET DEFAULT 0;
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "attempts" SET NOT NULL;
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "max_attempts" SET DEFAULT 5;
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "max_attempts" SET NOT NULL;
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "url" DROP DEFAULT;
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "url" SET NOT NULL;
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "created_at" SET DEFAULT now();
	ALTER TABLE "webhook_deliveries" ALTER COLUMN "created_at" SET NOT NULL;

	ALTER TABLE "webhook_deliveries" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
	IF NOT EXISTS (SELECT 1 FROM "webhook_deliveries" WHERE "id" IS NULL) THEN
		ALTER TABLE "webhook_deliveries" ALTER COLUMN "id" SET NOT NULL;
	END IF;

	IF NOT EXISTS (
			SELECT 1
			FROM pg_constraint
			WHERE conrelid = 'public.webhook_deliveries'::regclass
				AND contype = 'p'
		)
		AND NOT EXISTS (SELECT 1 FROM "webhook_deliveries" WHERE "id" IS NULL)
		AND NOT EXISTS (
			SELECT 1
			FROM "webhook_deliveries"
			GROUP BY "id"
			HAVING count(*) > 1
		)
	THEN
		BEGIN
			ALTER TABLE "webhook_deliveries"
				ADD CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id");
		EXCEPTION
			WHEN duplicate_object OR invalid_table_definition THEN
				NULL;
		END;
	END IF;

	IF NOT EXISTS (SELECT 1 FROM "webhook_deliveries" WHERE "org_id" IS NULL) THEN
		ALTER TABLE "webhook_deliveries" ALTER COLUMN "org_id" SET NOT NULL;
	END IF;

	IF to_regclass('public.organizations') IS NOT NULL
		AND NOT EXISTS (
			SELECT 1
			FROM pg_constraint
			WHERE conname = 'webhook_deliveries_org_id_organizations_id_fk'
				AND conrelid = 'public.webhook_deliveries'::regclass
		)
	THEN
		BEGIN
			ALTER TABLE "webhook_deliveries"
				ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk"
				FOREIGN KEY ("org_id")
				REFERENCES "public"."organizations"("id")
				ON DELETE cascade
				ON UPDATE no action
				NOT VALID;
		EXCEPTION
			WHEN duplicate_object THEN
				NULL;
		END;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('public.webhook_deliveries') IS NOT NULL THEN
		BEGIN
			CREATE INDEX IF NOT EXISTS "webhook_delivery_org_status_idx"
				ON "webhook_deliveries" USING btree ("org_id", "status");
		EXCEPTION
			WHEN duplicate_table OR unique_violation THEN
				NULL;
		END;

		BEGIN
			CREATE INDEX IF NOT EXISTS "webhook_delivery_retry_idx"
				ON "webhook_deliveries" USING btree ("status", "next_retry_at");
		EXCEPTION
			WHEN duplicate_table OR unique_violation THEN
				NULL;
		END;
	END IF;
END $$;
