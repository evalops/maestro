#!/usr/bin/env node
/**
 * Ratchet against new ad-hoc `.maestro/*.json` and `.maestro/*.toml`
 * reads in `src/`.
 *
 * # Why
 *
 * The Settings substrate (Week 2 in progress) consolidates file-based
 * configuration into one typed primitive — the same shape as the
 * `RuntimeEnv` substrate, applied to files instead of env vars. Every
 * direct `readFileSync("~/.maestro/foo.json")` or `parseTOML(".maestro/config.toml")`
 * in library code is a future flake surface: untyped, untested, and
 * undocumented in any schema.
 *
 * The same problem droid's `SettingsManager` solves at scale, with the
 * better-reinforcements property we're applying everywhere: a CI gate
 * that prevents the *next* developer from adding a new ad-hoc reader
 * around the substrate.
 *
 * # Strategy
 *
 * Migrating ~25 distinct settings file patterns in one PR is impossible.
 * Instead this scanner baselines today's readers in
 * `scripts/settings-reads-baseline.json` and fails CI when a new
 * (file, pattern) pair appears. To migrate an existing reader: type it
 * on the Settings substrate (when shipped), route the consumer through
 * the resolver, drop the baseline entry.
 *
 * # Usage
 *
 *   node scripts/check-settings-reads.mjs           # check vs baseline
 *   node scripts/check-settings-reads.mjs --update  # regenerate baseline
 *   node scripts/check-settings-reads.mjs --report  # show all reads
 *
 * # Approved readers
 *
 * Modules in `ALLOWED_FILES` are the sanctioned config-loading layer
 * and are exempt from the gate.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const srcRoot = resolve(repoRoot, "src");
const baselinePath = resolve(here, "settings-reads-baseline.json");

const SETTINGS_FILE_PATTERN =
	/(?:[~.][/\\])?\.maestro[/\\][A-Za-z0-9_./\\-]+\.(?:jsonc|json|toml)\b/g;

/**
 * Files explicitly *allowed* to read settings files directly.
 *
 * These are the sanctioned config-loading layer. Library code should
 * route through them; new direct readers anywhere else fail this gate.
 */
const ALLOWED_FILES = new Set([
	// Existing typed-config substrate. The future Settings primitive in
	// src/runtime/ will join this list.
	"src/config/toml-config.ts",
	"src/config/runtime-config.ts",
	"src/config/firewall-config.ts",
	"src/config/framework.ts",
	"src/config/lsp-config.ts",
	"src/config/index.ts",
	// Settings primitive — the typed composed substrate (PR #2781).
	// References settings-file paths in JSDoc as documentation of the
	// future resolution chain. Does not actually read from disk; reads
	// are exclusively from `RuntimeEnv` (the env substrate) at present.
	"src/runtime/settings.ts",
	// OAuth storage substrate — `oauth.json` lives at the auth boundary,
	// not the settings boundary. Counts as its own typed primitive.
	"src/oauth/storage.ts",
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
	for (const m of text.matchAll(SETTINGS_FILE_PATTERN)) {
		// Normalize: drop leading ~/ or ./ and Windows backslashes
		const normalized = m[0]
			.replace(/^[~.][/\\]/, "")
			.replace(/\\/g, "/")
			.replace(/^[/]+/, "");
		hits.add(normalized);
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
		console.log("✓ No new .maestro/* settings-file reads in src/");
		process.exit(0);
	}

	console.error(
		"\n✗ New direct `.maestro/*` settings-file reads detected in src/. Route them through the Settings substrate (or the existing src/config/* loaders):\n",
	);
	for (const [file, reads] of Object.entries(newReads)) {
		console.error(`  ${file}`);
		for (const r of reads) {
			console.error(`    + ${r}`);
		}
	}
	console.error(
		"\nIf the read is genuinely required (rare — usually you want it typed on the Settings primitive),",
	);
	console.error(
		"regenerate the baseline with: node scripts/check-settings-reads.mjs --update",
	);
	console.error(
		"\nApproved config-loading modules are listed in scripts/check-settings-reads.mjs ALLOWED_FILES.\n",
	);
	process.exit(1);
}

main();
