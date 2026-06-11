#!/usr/bin/env node
// @ts-check

import { readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_ISSUE = "evalops/maestro-internal#2582";
const FILES = [
	"test/tools/find.test.ts",
	"test/tools/image-processor.test.ts",
	"test/db/db-integration.test.ts",
	"test/slack-agent/sandbox.test.ts",
];
const FILE_LEVEL_TRACKED_SKIP_FILES = new Set([
	"test/tools/find.test.ts",
	"test/tools/image-processor.test.ts",
]);

const SKIP_PATTERNS = [
	/\bdescribe\.skip(?:If)?\b/,
	/\bit\.skip(?:If)?\b/,
	/\btest\.skip(?:If)?\b/,
];
const failures = [];

for (const file of FILES) {
	const lines = readFileSync(join(process.cwd(), file), "utf8").split("\n");
	const fileHasTrackedSkipComment = lines.some((line) =>
		line.includes(REQUIRED_ISSUE),
	);
	for (const [index, line] of lines.entries()) {
		if (!SKIP_PATTERNS.some((pattern) => pattern.test(line))) {
			continue;
		}
		const context = lines
			.slice(Math.max(0, index - 3), Math.min(lines.length, index + 2))
			.join("\n");
		if (!context.includes(REQUIRED_ISSUE)) {
			if (
				FILE_LEVEL_TRACKED_SKIP_FILES.has(file) &&
				fileHasTrackedSkipComment
			) {
				continue;
			}
			failures.push(`${file}:${index + 1} skip is missing ${REQUIRED_ISSUE}`);
		}
	}
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(failure);
	}
	process.exit(1);
}

console.log(`Test skip hygiene passed (${REQUIRED_ISSUE}).`);
