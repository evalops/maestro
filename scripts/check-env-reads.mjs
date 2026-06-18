#!/usr/bin/env node
/**
 * Ratchet against new ambient `process.env` reads in `src/`.
 *
 * # Why
 *
 * Ambient env reads in library code (`process.env.MAESTRO_X`) are the
 * substrate-level root cause of an entire class of flakes — config frozen
 * at module-load time, CI runner env leaking into test assertions, OAuth
 * mode captured by the first call in a vitest worker. The `RuntimeEnv`
 * substrate in `src/runtime/env.ts` fixes that by making env an explicit,
 * typed parameter.
 *
 * Migrating ~200 existing reads in one shot would be a multi-week
 * refactor. Instead this scanner ratchets: it baselines today's reads in
 * `scripts/env-reads-baseline.json` and fails CI when a new read appears
 * that isn't in the baseline. To migrate an existing read, route it
 * through `RuntimeEnv` and drop the corresponding baseline entry.
 *
 * # Usage
 *
 *   node scripts/check-env-reads.mjs              # check vs baseline
 *   node scripts/check-env-reads.mjs --update     # regenerate baseline
 *   node scripts/check-env-reads.mjs --report     # show all reads grouped
 *
 * The scanner is intentionally crude (regex, not AST): the goal is to
 * detect new direct reads, not to be a complete env-flow analysis.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const srcRoot = resolve(repoRoot, "src");
const baselinePath = resolve(here, "env-reads-baseline.json");

const READ_PATTERN = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const BRACKET_READ_PATTERN = /process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g;

/** Files explicitly *allowed* to read `process.env` directly. */
const ALLOWED_FILES = new Set([
	// The substrate primitive itself — this is THE one allowed reader.
	"src/runtime/env.ts",
]);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const full = resolve(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (
			st.isFile() &&
			(name.endsWith(".ts") || name.endsWith(".tsx")) &&
			!name.endsWith(".d.ts")
		) {
			yield full;
		}
	}
}

function scanFile(absPath) {
	const text = readFileSync(absPath, "utf-8");
	const hits = new Set();
	for (const m of text.matchAll(READ_PATTERN)) {
		hits.add(m[1]);
	}
	for (const m of text.matchAll(BRACKET_READ_PATTERN)) {
		hits.add(m[1]);
	}
	return [...hits].sort();
}

function buildReport() {
	const report = {};
	for (const abs of walk(srcRoot)) {
		const rel = relative(repoRoot, abs);
		if (ALLOWED_FILES.has(rel)) continue;
		const reads = scanFile(abs);
		if (reads.length > 0) {
			report[rel] = reads;
		}
	}
	return report;
}

function readBaseline() {
	try {
		return JSON.parse(readFileSync(baselinePath, "utf-8"));
	} catch {
		return {};
	}
}

function diffReports(baseline, current) {
	const newReads = {};
	for (const [file, reads] of Object.entries(current)) {
		const baselineReads = new Set(baseline[file] ?? []);
		const newOnes = reads.filter((r) => !baselineReads.has(r));
		if (newOnes.length > 0) {
			newReads[file] = newOnes;
		}
	}
	return newReads;
}

function main() {
	const args = new Set(process.argv.slice(2));
	const report = buildReport();

	if (args.has("--update")) {
		writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
		const totalReads = Object.values(report).reduce(
			(sum, reads) => sum + reads.length,
			0,
		);
		console.log(
			`✓ Wrote ${Object.keys(report).length} files / ${totalReads} unique reads to ${relative(repoRoot, baselinePath)}`,
		);
		process.exit(0);
	}

	if (args.has("--report")) {
		console.log(JSON.stringify(report, null, 2));
		process.exit(0);
	}

	const baseline = readBaseline();
	const newReads = diffReports(baseline, report);

	if (Object.keys(newReads).length === 0) {
		console.log("✓ No new process.env reads in src/");
		process.exit(0);
	}

	console.error(
		"\n✗ New direct `process.env` reads detected in src/. Route them through `RuntimeEnv` in src/runtime/env.ts:\n",
	);
	for (const [file, reads] of Object.entries(newReads)) {
		console.error(`  ${file}`);
		for (const r of reads) {
			console.error(`    + process.env.${r}`);
		}
	}
	console.error(
		"\nIf the read is genuinely required (rare — usually you want a typed field on RuntimeEnv),",
	);
	console.error(
		"regenerate the baseline with: node scripts/check-env-reads.mjs --update",
	);
	console.error("\nSee src/runtime/env.ts for the substrate primitive.\n");
	process.exit(1);
}

main();
