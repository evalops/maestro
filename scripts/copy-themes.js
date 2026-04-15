import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(__filename));

export function copyThemes(options = {}) {
	const {
		sourceDir = path.join(repoRoot, "src", "theme"),
		targetDir = path.join(repoRoot, "dist", "theme"),
	} = options;
	if (!existsSync(sourceDir)) {
		return;
	}

	const files = readdirSync(sourceDir).filter((file) => file.endsWith(".json"));

	if (files.length === 0) {
		return;
	}

	mkdirSync(targetDir, { recursive: true });

	for (const file of files) {
		const from = path.join(sourceDir, file);
		const to = path.join(targetDir, file);
		copyFileSync(from, to);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	copyThemes();
}
