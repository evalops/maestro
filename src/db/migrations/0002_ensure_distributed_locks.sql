CREATE TABLE IF NOT EXISTS "distributed_locks" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"holder_id" varchar(100) NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distributed_lock_expires_idx" ON "distributed_locks" USING btree ("expires_at");
