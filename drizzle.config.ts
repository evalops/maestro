/**
 * Drizzle Kit configuration for migrations
 */

import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

config();

const dbType = process.env.COMPOSER_DATABASE_TYPE?.toLowerCase() || "sqlite";
const dbUrl = process.env.COMPOSER_DATABASE_URL || process.env.DATABASE_URL;
const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
const dbFile =
	process.env.COMPOSER_DATABASE_FILE || `${homeDir}/.composer/db/composer.db`;

export default defineConfig({
	schema: "./src/db/schema.ts",
	out: "./src/db/migrations",
	dialect: dbType === "postgres" ? "postgresql" : "sqlite",
	dbCredentials:
		dbType === "postgres" ? { url: dbUrl || "" } : { url: dbFile },
});
