import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

const ENV_FILES = [".env.local", ".env"];

export function loadEnv(): void {
	for (const file of ENV_FILES) {
		const resolved = join(process.cwd(), file);
		if (existsSync(resolved)) {
			config({ path: resolved, override: false });
		}
	}
}
