#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");
export const DEFAULT_GUARDRAIL_MANIFEST = resolve(
	repoRoot,
	"scripts/guardrail-regression-suite.json",
);
export const REQUIRED_GUARDRAIL_IDS = [
	"runtime-env-semantic-scanner",
	"composed-skill-trust-boundary",
	"release-dispatch-idempotency",
	"opaque-git-parser-state",
	"bounded-output-and-json-repair",
	"a2a-ledger-evidence-parity",
	"a2a-cancel-canonical-state-guard",
	"a2a-compound-secret-redaction",
	"a2a-history-rich-part-refresh",
	"learner-transient-quarantine-parity",
	"learner-promote-repair-consistency",
];

export function loadGuardrailManifest(path = DEFAULT_GUARDRAIL_MANIFEST) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function compileRegex(pattern) {
	try {
		return new RegExp(String(pattern), "m");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function evaluateGuardrailManifest(
	manifest,
	{ root = repoRoot } = {},
) {
	const failures = [];
	const guardrails = asArray(manifest?.guardrails);
	const seenIds = new Set();

	if (manifest?.schemaVersion !== 1) {
		failures.push("manifest schemaVersion must be 1");
	}
	if (guardrails.length === 0) {
		failures.push("manifest must define at least one guardrail");
	}

	for (const guardrail of guardrails) {
		const id = String(guardrail?.id ?? "");
		if (!id) {
			failures.push("guardrail is missing id");
			continue;
		}
		if (seenIds.has(id)) {
			failures.push(`${id}: duplicate guardrail id`);
		}
		seenIds.add(id);

		for (const field of ["title", "owner", "bugClass", "why"]) {
			if (!String(guardrail?.[field] ?? "").trim()) {
				failures.push(`${id}: missing ${field}`);
			}
		}

		const evidence = asArray(guardrail?.evidence);
		if (evidence.length === 0) {
			failures.push(`${id}: missing evidence`);
			continue;
		}
		for (const item of evidence) {
			const relPath = String(item?.path ?? "");
			if (!relPath || relPath.startsWith("/") || relPath.includes("..")) {
				failures.push(`${id}: invalid evidence path ${JSON.stringify(relPath)}`);
				continue;
			}
			const absPath = resolve(root, relPath);
			if (!existsSync(absPath)) {
				failures.push(`${id}: evidence file does not exist: ${relPath}`);
				continue;
			}
			const contents = readFileSync(absPath, "utf8");
			const requiredSubstrings = asArray(item?.contains).map(String);
			const forbiddenSubstrings = asArray(item?.notContains).map(String);
			const requiredPatterns = asArray(item?.matches).map(String);
			if (
				requiredSubstrings.length === 0 &&
				forbiddenSubstrings.length === 0 &&
				requiredPatterns.length === 0
			) {
				failures.push(
					`${id}: ${relPath} must list contains, notContains, or matches assertions`,
				);
				continue;
			}
			for (const needle of requiredSubstrings) {
				if (!contents.includes(needle)) {
					failures.push(`${id}: ${relPath} is missing ${JSON.stringify(needle)}`);
				}
			}
			for (const needle of forbiddenSubstrings) {
				if (contents.includes(needle)) {
					failures.push(
						`${id}: ${relPath} must not contain ${JSON.stringify(needle)}`,
					);
				}
			}
			for (const pattern of requiredPatterns) {
				const regex = compileRegex(pattern);
				if (typeof regex === "string") {
					failures.push(
						`${id}: ${relPath} has invalid regex ${JSON.stringify(pattern)}: ${regex}`,
					);
				} else if (!regex.test(contents)) {
					failures.push(
						`${id}: ${relPath} does not match ${JSON.stringify(pattern)}`,
					);
				}
			}
		}
	}
	for (const requiredId of REQUIRED_GUARDRAIL_IDS) {
		if (!seenIds.has(requiredId)) {
			failures.push(`manifest is missing required guardrail id ${requiredId}`);
		}
	}

	return {
		failures,
		guardrailCount: guardrails.length,
		ok: failures.length === 0,
	};
}

function main() {
	const manifestPath = process.argv[2]
		? resolve(process.cwd(), process.argv[2])
		: DEFAULT_GUARDRAIL_MANIFEST;
	const result = evaluateGuardrailManifest(loadGuardrailManifest(manifestPath));
	if (!result.ok) {
		for (const failure of result.failures) {
			console.error(`guardrail-regression-suite: ${failure}`);
		}
		process.exit(1);
	}
	console.log(`Guardrail regression suite covers ${result.guardrailCount} bug class(es).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
