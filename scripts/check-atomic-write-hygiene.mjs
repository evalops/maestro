#!/usr/bin/env node
// @ts-check

/**
 * Atomic-write hygiene gate for #2631.
 *
 * Persisted JSON state in this repo MUST go through
 * `writeTextFileAtomic` / `writeJsonFile` from `src/utils/fs.ts`
 * (or `writePrivateFileSync` in `src/oauth/private-file.ts`). Direct
 * `writeFileSync` / `fs.promises.writeFile` calls corrupt state on
 * crash mid-write because the rename is not atomic.
 *
 * This script enforces the rule going forward: every `.ts` file
 * under `src/` is scanned for direct `writeFileSync`, `fs.writeFile`,
 * or `writeFile` imported from `node:fs/promises` usage. The
 * pre-existing violations listed in
 * `ALLOWLISTED_DIRECT_WRITE_FILES` are grandfathered in (tech debt
 * to be migrated case-by-case in follow-up PRs). Anything NOT in
 * the allowlist fails the check.
 *
 * When a file is migrated to atomic writes, remove it from the
 * allowlist; the script then verifies the file no longer triggers
 * (catches drift the other way too — accidentally re-introducing a
 * direct write to a file you just cleaned up).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REQUIRED_ISSUE = "evalops/maestro-internal#2631";

/**
 * Direct-write call sites that pre-date #2631. New entries are
 * forbidden — migrate to `writeTextFileAtomic` / `writeJsonFile`
 * instead.
 */
const ALLOWLISTED_DIRECT_WRITE_FILES = new Set([
	"src/agent/swarm/executor.ts",
	"src/app-server/external-agent-import-api.ts",
	"src/app-server/host-control-api.ts",
	"src/cli-tui/utils/external-editor.ts",
	"src/memory/auto-consolidation.ts",
	// `src/oauth/private-file.ts` IS the helper that uses
	// `writeFileSync` to implement the temp-then-rename pattern;
	// it's an authorized implementation, not a violation.
	"src/oauth/private-file.ts",
	"src/platform/a2a-peer-registry.ts",
	"src/platform/a2a-task-ledger.ts",
	"src/sandbox/local-sandbox.ts",
	"src/server/handlers/hosted-runner-drain.ts",
	"src/shared-memory/client.ts",
	"src/telemetry/cli-command-aggregator.ts",
	"src/tools/apply-patch.ts",
	"src/tools/edit.ts",
	"src/tools/oracle.ts",
	"src/tools/write.ts",
	"src/utils/document-extractor.ts",
	// `src/utils/fs.ts` IS the helper that implements the atomic
	// temp-then-rename pattern; it's an authorized implementation,
	// not a violation.
	"src/utils/fs.ts",
]);

const DIRECT_WRITE_PATTERN = /\bwriteFileSync\b|\bfs\.writeFile\b/;
const FS_PROMISES_IMPORT_PATTERN =
	/import\s*\{([^}]*)\}\s*from\s*["']node:fs\/promises["']/g;
const ROOTS = ["src"];
const failures = [];
const seenAllowlistedFiles = new Set();

function normalizePath(path) {
	return path.split(sep).join("/");
}

function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const relativePath = normalizePath(relative(process.cwd(), path));
		if (
			relativePath.includes("/node_modules/") ||
			relativePath.includes("/dist/")
		) {
			continue;
		}
		const stats = statSync(path);
		if (stats.isDirectory()) {
			walk(path);
			continue;
		}
		if (!relativePath.endsWith(".ts")) continue;
		// Skip `.d.ts` type declaration files; they never contain
		// runtime code anyway.
		if (relativePath.endsWith(".d.ts")) continue;

		const source = readFileSync(path, "utf8");
		if (!usesDirectWrite(source)) continue;

		if (!ALLOWLISTED_DIRECT_WRITE_FILES.has(relativePath)) {
			failures.push(
				`${relativePath} uses fs.writeFile / fs.promises.writeFile / writeFileSync directly. Use writeTextFileAtomic or writeJsonFile from src/utils/fs.ts. See ${REQUIRED_ISSUE}.`,
			);
			continue;
		}
		seenAllowlistedFiles.add(relativePath);
	}
}

function usesDirectWrite(source) {
	if (DIRECT_WRITE_PATTERN.test(source)) {
		return true;
	}

	FS_PROMISES_IMPORT_PATTERN.lastIndex = 0;
	for (const match of source.matchAll(FS_PROMISES_IMPORT_PATTERN)) {
		const specifiers = match[1]
			.split(",")
			.map((specifier) => specifier.trim())
			.filter(Boolean);
		for (const specifier of specifiers) {
			const parts = specifier.split(/\s+as\s+/);
			if (parts[0]?.trim() !== "writeFile") {
				continue;
			}
			const localName = (parts[1] ?? parts[0]).trim();
			if (new RegExp(`\\b${escapeRegExp(localName)}\\s*\\(`).test(source)) {
				return true;
			}
		}
	}
	return false;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const root of ROOTS) {
	walk(join(process.cwd(), root));
}

for (const file of ALLOWLISTED_DIRECT_WRITE_FILES) {
	if (!seenAllowlistedFiles.has(file)) {
		failures.push(
			`${file} is allowlisted for ${REQUIRED_ISSUE} but no longer uses direct writeFile; please remove it from the allowlist in scripts/check-atomic-write-hygiene.mjs.`,
		);
	}
}

if (failures.length > 0) {
	console.error("Atomic-write hygiene check failed:");
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log(
	`Atomic-write hygiene passed (${ALLOWLISTED_DIRECT_WRITE_FILES.size} files allowlisted for ${REQUIRED_ISSUE}).`,
);
