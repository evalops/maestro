ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "action" varchar(50);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'permissions'
			AND column_name = 'permission_type'
	) THEN
		UPDATE "permissions"
		SET "action" = "permission_type"
		WHERE "action" IS NULL
			AND "permission_type" IS NOT NULL;
	END IF;
END $$;
--> statement-breakpoint
UPDATE "permissions"
SET "action" = 'read'
WHERE "action" IS NULL;
--> statement-breakpoint
ALTER TABLE "permissions" ALTER COLUMN "action" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'permissions'
			AND column_name = 'name'
	) THEN
		ALTER TABLE "permissions" ALTER COLUMN "name" DROP NOT NULL;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'permissions'
			AND column_name = 'permission_type'
	) THEN
		ALTER TABLE "permissions" ALTER COLUMN "permission_type" DROP NOT NULL;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "permission_resource_action_idx" ON "permissions" USING btree ("resource", "action");
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "org_id" uuid;
--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "is_system" boolean DEFAULT false;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'roles'
			AND column_name = 'is_system_role'
	) THEN
		UPDATE "roles"
		SET "is_system" = "is_system_role"
		WHERE "is_system" IS DISTINCT FROM "is_system_role";
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "is_system" SET DEFAULT false;
--> statement-breakpoint
UPDATE "roles" SET "is_system" = false WHERE "is_system" IS NULL;
--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "is_system" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'roles'
			AND column_name = 'role_type'
	) THEN
		ALTER TABLE "roles" ALTER COLUMN "role_type" DROP NOT NULL;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_org_name_idx" ON "roles" USING btree ("org_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_system_name_idx" ON "roles" USING btree ("name") WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_permission_pk" ON "role_permissions" USING btree ("role_id", "permission_id");
