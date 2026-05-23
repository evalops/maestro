#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MARKER_PREFIX = "maestro-public-mirror-source";
const DEFAULT_SOURCE_REPO = "evalops/maestro-internal";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function normalizeSource(source) {
	return {
		schemaVersion: 1,
		scope: String(source.scope ?? "").trim(),
		sourceRepo: String(source.sourceRepo ?? DEFAULT_SOURCE_REPO).trim(),
		sourceSha: String(source.sourceSha ?? "").trim().toLowerCase(),
	};
}

export function buildPublicMirrorSourceMarker(source) {
	const normalized = normalizeSource(source);
	if (!normalized.scope) {
		throw new Error("Public mirror source scope is required");
	}
	if (!SHA_PATTERN.test(normalized.sourceSha)) {
		throw new Error("Public mirror source SHA must be a 40-character hex SHA");
	}
	if (!normalized.sourceRepo) {
		throw new Error("Public mirror source repo is required");
	}
	return `<!-- ${MARKER_PREFIX}: ${JSON.stringify(normalized)} -->`;
}

export function parsePublicMirrorSourceMarker(body) {
	const text = String(body ?? "");
	const match = text.match(
		/<!--\s*maestro-public-mirror-source:\s*(\{[\s\S]*?\})\s*-->/u,
	);
	if (!match) {
		return null;
	}
	const parsed = JSON.parse(match[1]);
	return normalizeSource(parsed);
}

export function evaluatePublicMirrorSource({
	body,
	expectedScope,
	expectedSourceRepo = DEFAULT_SOURCE_REPO,
	expectedSourceSha,
}) {
	const marker = parsePublicMirrorSourceMarker(body);
	if (!marker) {
		return { ok: false, reason: "missing_marker" };
	}
	if (expectedScope && marker.scope !== expectedScope) {
		return { marker, ok: false, reason: "scope_mismatch" };
	}
	if (expectedSourceRepo && marker.sourceRepo !== expectedSourceRepo) {
		return { marker, ok: false, reason: "source_repo_mismatch" };
	}
	if (
		expectedSourceSha &&
		marker.sourceSha !== String(expectedSourceSha).trim().toLowerCase()
	) {
		return { marker, ok: false, reason: "source_sha_mismatch" };
	}
	return { marker, ok: true, reason: "matched" };
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const args = {
		body: "",
		bodyFile: "",
		command,
		scope: "",
		sourceRepo: DEFAULT_SOURCE_REPO,
		sourceSha: "",
	};
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		switch (arg) {
			case "--body":
				args.body = rest[++index] ?? "";
				break;
			case "--body-file":
				args.bodyFile = rest[++index] ?? "";
				break;
			case "--scope":
				args.scope = rest[++index] ?? "";
				break;
			case "--source-repo":
				args.sourceRepo = rest[++index] ?? DEFAULT_SOURCE_REPO;
				break;
			case "--source-sha":
				args.sourceSha = rest[++index] ?? "";
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function usage() {
	return [
		"Usage:",
		"  node scripts/public-mirror-source.mjs marker --scope <scope> --source-sha <sha> [--source-repo <repo>]",
		"  node scripts/public-mirror-source.mjs validate --body-file <path> --scope <scope> --source-sha <sha> [--source-repo <repo>]",
	].join("\n");
}

function resolveBody(args) {
	if (args.bodyFile) {
		return readFileSync(args.bodyFile, "utf8");
	}
	return args.body;
}

function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.command === "marker") {
		process.stdout.write(
			`${buildPublicMirrorSourceMarker({
				scope: args.scope,
				sourceRepo: args.sourceRepo,
				sourceSha: args.sourceSha,
			})}\n`,
		);
		return;
	}
	if (args.command === "validate") {
		const result = evaluatePublicMirrorSource({
			body: resolveBody(args),
			expectedScope: args.scope,
			expectedSourceRepo: args.sourceRepo,
			expectedSourceSha: args.sourceSha,
		});
		if (!result.ok) {
			throw new Error(`Public mirror source metadata mismatch: ${result.reason}`);
		}
		process.stdout.write("Public mirror source metadata matched.\n");
		return;
	}
	throw new Error(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
