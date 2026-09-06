#!/usr/bin/env node

/**
 * Advisory freshness check for the bundled model catalog snapshot at
 * `packages/tui-rs/src/model_catalog_data.json`.
 *
 * Modes:
 *   (default)            warn when the committed snapshot's `generated_at` is
 *                        older than --stale-days (default 7)
 *   --compare <path>     warn when a freshly regenerated snapshot's model list
 *                        differs from the committed one (drift report)
 *
 * Advisory automation fails open: this script always exits 0.
 */

import { readFileSync } from "node:fs";

const SNAPSHOT_PATH = "packages/tui-rs/src/model_catalog_data.json";
const DEFAULT_STALE_DAYS = 7;

function parseArgs(argv) {
	const args = { compare: null, staleDays: DEFAULT_STALE_DAYS };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--compare") {
			args.compare = argv[i + 1];
			i += 1;
		} else if (argv[i] === "--stale-days") {
			args.staleDays = Number.parseInt(argv[i + 1], 10);
			i += 1;
		} else {
			throw new Error(`unknown argument: ${argv[i]}`);
		}
	}
	return args;
}

function readSnapshot(path) {
	const snapshot = JSON.parse(readFileSync(path, "utf8"));
	if (!Number.isInteger(snapshot.generated_at) || !Array.isArray(snapshot.models)) {
		throw new Error(`${path} is not a model catalog snapshot`);
	}
	return snapshot;
}

function warn(message) {
	console.log(`::warning file=${SNAPSHOT_PATH}::${message}`);
}

function checkStaleness(staleDays) {
	const snapshot = readSnapshot(SNAPSHOT_PATH);
	const ageDays = (Date.now() / 1000 - snapshot.generated_at) / 86_400;
	const generated = new Date(snapshot.generated_at * 1000).toISOString();
	console.log(
		`snapshot generated_at=${generated} (${snapshot.models.length} models), age=${ageDays.toFixed(1)} day(s)`,
	);
	if (ageDays > staleDays) {
		warn(
			`model catalog snapshot is ${ageDays.toFixed(1)} days old (limit ${staleDays}); ` +
				"regenerate with `node scripts/fetch-model-catalog.mjs` and commit the result",
		);
	}
}

function compareDrift(freshPath) {
	const committed = readSnapshot(SNAPSHOT_PATH);
	const fresh = readSnapshot(freshPath);
	const serialize = (models) =>
		models.map((model) => JSON.stringify(model)).sort();
	const committedModels = serialize(committed.models);
	const freshModels = serialize(fresh.models);
	const added = freshModels.filter((entry) => !committedModels.includes(entry));
	const removed = committedModels.filter((entry) => !freshModels.includes(entry));
	if (added.length === 0 && removed.length === 0) {
		console.log(
			`no drift: committed snapshot matches models.dev + OpenRouter (${committed.models.length} models)`,
		);
		return;
	}
	const idOf = (entry) => JSON.parse(entry).id;
	warn(
		`model catalog drift vs models.dev: ${added.length} added/changed, ${removed.length} removed/changed; ` +
			"regenerate with `node scripts/fetch-model-catalog.mjs`",
	);
	console.log("added/changed ids:", added.map(idOf).join(", "));
	console.log("removed/changed ids:", removed.map(idOf).join(", "));
}

try {
	const args = parseArgs(process.argv.slice(2));
	if (args.compare) {
		compareDrift(args.compare);
	} else {
		checkStaleness(args.staleDays);
	}
} catch (error) {
	// Advisory: fail open.
	console.log(`::warning::model catalog freshness check could not run: ${error.message}`);
}
