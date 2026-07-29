#!/usr/bin/env node
import { readFileSync } from "node:fs";

const files = [
	"README.md",
	"AGENTS.md",
	"CONTRIBUTING.md",
	"docs/BUILD_TESTING.md",
	"docs/ARCHITECTURE.md",
	"docs/TUI_ARCHITECTURE.md",
	"docs/NATIVE_TUI_PARITY.md",
	"docs/WEB_UI.md",
	"docs/FEATURES.md",
	"docs/QUICKSTART.md",
	"docs/CONTRIBUTOR_RUNBOOK.md",
	"docs/TOOLS_REFERENCE.md",
	"docs/CI_VERSION_PINS.md",
	"packages/tui-rs/docs/user-guide/01-getting-started.md",
	"packages/tui-rs/docs/user-guide/12-sandbox-and-safety.md",
	"packages/tui-rs/docs/user-guide/13-headless-mode.md",
];
const banned = [
	/dist\/cli\.js/i,
	/vendor\/maestro-tui/i,
	/packages\/ai/i,
	/typescript (agent|runtime) (remains|handles|owns|supports|executes)/i,
	/(bun install(?:\s|$)|bun run(?:\s|$)|npx tsc(?:\s|$)|tsconfig\.build)/i,
	/typescript (path|cli|adapter|surface)/i,
];
const failures = [];
for (const file of files) {
	const text = readFileSync(file, "utf8");
	for (const pattern of banned) if (pattern.test(text)) failures.push(`${file}: ${pattern}`);
}
if (failures.length) {
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log(`Rust-only documentation contract passed (${files.length} canonical documents).`);
