#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const gitDir = join(process.cwd(), ".git");
const hookDir = join(gitDir, "hooks");
const hookPath = join(hookDir, "pre-commit");

function alreadyConfigured(contents) {
	return contents.includes("composer-guardian") || contents.includes("guardian.sh");
}

if (!existsSync(gitDir)) {
	console.error("No .git directory found; run this from the repository root.");
	process.exit(1);
}

mkdirSync(hookDir, { recursive: true });

if (existsSync(hookPath)) {
	const contents = readFileSync(hookPath, "utf-8");
	if (alreadyConfigured(contents)) {
		console.log("Composer Guardian pre-commit hook already present.");
		process.exit(0);
	}
	console.error(
		"pre-commit hook already exists. Please add the following line near the top of your hook:",
	);
	console.error('bash "$(pwd)/scripts/guardian.sh" --trigger pre-commit "$@"');
	process.exit(1);
}

const script = `#!/usr/bin/env bash
set -euo pipefail
# composer-guardian pre-commit hook
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bash "$ROOT/scripts/guardian.sh" --trigger pre-commit "$@"
`;

writeFileSync(hookPath, script, { encoding: "utf-8", mode: 0o755 });
console.log("Installed Composer Guardian pre-commit hook at .git/hooks/pre-commit.");
