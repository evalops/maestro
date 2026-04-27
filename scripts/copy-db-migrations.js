import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(__filename));

export function copyDbMigrations(options = {}) {
	const {
		sourceDir = path.join(repoRoot, "src", "db", "migrations"),
		targetDir = path.join(repoRoot, "dist", "db", "migrations"),
	} = options;

	if (!existsSync(sourceDir)) {
		return;
	}

	cpSync(sourceDir, targetDir, { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	copyDbMigrations();
}
