#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPublishedReplayReleaseGate } from "./smoke-published-replay-e2e.js";

const EVIDENCE_SCHEMA = "evalops.maestro.published-replay-evidence.v1";
const REQUIRED_INSTALLERS = ["npm", "bun"];
const REQUIRED_REPLAY_MODES = ["json", "rpc", "text"];
const TOOL_CALL_ID = "call-read-package-json";

function parseArgs(argv) {
	const options = {
		evidenceDir: "published-replay-evidence",
		evidenceFiles: [],
		installers: [],
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--evidence-dir":
				options.evidenceDir = argv[++index] ?? "";
				break;
			case "--evidence":
				options.evidenceFiles.push(argv[++index] ?? "");
				break;
			case "--installer":
				options.installers.push(...String(argv[++index] ?? "").split(","));
				break;
			default:
				throw new Error(
					`Unknown argument: ${arg}\nUsage: node scripts/verify-published-replay-evidence.js [--evidence-dir <dir>] [--installer npm,bun] [--evidence <file>]`,
				);
		}
	}

	options.installers = options.installers
		.map((installer) => installer.trim())
		.filter(Boolean);
	options.evidenceFiles = options.evidenceFiles
		.map((file) => file.trim())
		.filter(Boolean);
	return options;
}

function isObject(value) {
	return value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value) {
	return Array.isArray(value)
		? value.filter((entry) => typeof entry === "string")
		: [];
}

function sortedStrings(value) {
	return stringArray(value).sort((left, right) => left.localeCompare(right));
}

function countModesWith(value, modeNames) {
	const set = new Set(stringArray(value));
	return modeNames.filter((mode) => set.has(mode)).length;
}

function pushUnless(errors, condition, message) {
	if (!condition) {
		errors.push(message);
	}
}

export function expectedPublishedReplayEvidenceFiles({
	evidenceDir = "published-replay-evidence",
	installers = REQUIRED_INSTALLERS,
} = {}) {
	const dir = resolve(evidenceDir);
	return installers.map((installer) => ({
		installer,
		path: join(dir, `${installer}-published-replay-evidence.json`),
	}));
}

export function readPublishedReplayEvidence(filePath) {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isObject(parsed)) {
			throw new Error("evidence JSON did not contain an object");
		}
		return parsed;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read published replay evidence ${filePath}: ${reason}`);
	}
}

export function validatePublishedReplayEvidence(evidence, { label = "evidence" } = {}) {
	const errors = [];
	pushUnless(
		errors,
		evidence?.schemaVersion === EVIDENCE_SCHEMA,
		`schemaVersion must be ${EVIDENCE_SCHEMA}`,
	);

	const packageInfo = isObject(evidence?.package) ? evidence.package : {};
	const installMetadata = isObject(packageInfo.installMetadata)
		? packageInfo.installMetadata
		: {};
	pushUnless(errors, typeof packageInfo.spec === "string", "package.spec must be a string");
	pushUnless(
		errors,
		typeof packageInfo.cliCommand === "string",
		"package.cliCommand must be a string",
	);
	pushUnless(
		errors,
		installMetadata.installable === true,
		"package.installMetadata.installable must be true",
	);
	pushUnless(
		errors,
		Array.isArray(installMetadata.binCommands) &&
			installMetadata.binCommands.includes(packageInfo.cliCommand),
		"package.installMetadata.binCommands must include package.cliCommand",
	);
	pushUnless(
		errors,
		Array.isArray(installMetadata.forbiddenWorkspaceNames),
		"package.installMetadata.forbiddenWorkspaceNames must be an array",
	);
	pushUnless(
		errors,
		Array.isArray(installMetadata.forbiddenReferences) &&
			installMetadata.forbiddenReferences.length === 0,
		"package.installMetadata.forbiddenReferences must be empty",
	);
	pushUnless(
		errors,
		Array.isArray(installMetadata.workspaceProtocolReferences) &&
			installMetadata.workspaceProtocolReferences.length === 0,
		"package.installMetadata.workspaceProtocolReferences must be empty",
	);
	pushUnless(
		errors,
		isObject(installMetadata.dependencySections),
		"package.installMetadata.dependencySections must be an object",
	);

	pushUnless(
		errors,
		evidence?.replay?.provider === "scripted-replay",
		"replay.provider must be scripted-replay",
	);

	const modes = Array.isArray(evidence?.modes) ? evidence.modes : [];
	const modeNames = sortedStrings(modes.map((mode) => mode?.mode));
	pushUnless(
		errors,
		JSON.stringify(modeNames) === JSON.stringify(REQUIRED_REPLAY_MODES),
		`modes must exactly cover ${REQUIRED_REPLAY_MODES.join(", ")}`,
	);
	for (const mode of modes) {
		const modeName = typeof mode?.mode === "string" ? mode.mode : "unknown";
		pushUnless(errors, mode?.status === "ok", `${modeName}.status must be ok`);
		pushUnless(
			errors,
			mode?.provider === "scripted-replay",
			`${modeName}.provider must be scripted-replay`,
		);
		pushUnless(errors, mode?.tool?.name === "read", `${modeName}.tool.name must be read`);
		pushUnless(
			errors,
			mode?.tool?.callId === TOOL_CALL_ID,
			`${modeName}.tool.callId must be ${TOOL_CALL_ID}`,
		);
		pushUnless(
			errors,
			mode?.tool?.inputPath === "package.json",
			`${modeName}.tool.inputPath must be package.json`,
		);
		pushUnless(
			errors,
			mode?.tool?.resultStatus === "success",
			`${modeName}.tool.resultStatus must be success`,
		);
		pushUnless(errors, mode?.final?.status === "ok", `${modeName}.final.status must be ok`);
		pushUnless(
			errors,
			mode?.final?.containsExpectedText === true,
			`${modeName}.final.containsExpectedText must be true`,
		);
		pushUnless(
			errors,
			Number.isFinite(mode?.session?.jsonlFileCount) &&
				mode.session.jsonlFileCount > 0,
			`${modeName}.session.jsonlFileCount must be positive`,
		);
		pushUnless(
			errors,
			Number.isFinite(mode?.session?.bytes) && mode.session.bytes > 0,
			`${modeName}.session.bytes must be positive`,
		);
		pushUnless(
			errors,
			mode?.session?.containsFinalText === true,
			`${modeName}.session.containsFinalText must be true`,
		);
		pushUnless(
			errors,
			mode?.session?.containsToolCallId === true,
			`${modeName}.session.containsToolCallId must be true`,
		);
		pushUnless(
			errors,
			typeof mode?.session?.sha256 === "string" && mode.session.sha256.length === 64,
			`${modeName}.session.sha256 must be a 64 character string`,
		);
	}

	try {
		assertPublishedReplayReleaseGate(evidence);
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}

	const releaseGate = isObject(evidence?.releaseGate) ? evidence.releaseGate : {};
	pushUnless(
		errors,
		releaseGate.releaseBlocking === true,
		"releaseGate.releaseBlocking must be true",
	);
	pushUnless(errors, releaseGate.satisfied === true, "releaseGate.satisfied must be true");
	const gateChecks = isObject(releaseGate.checks) ? releaseGate.checks : {};
	for (const [name, satisfied] of Object.entries(gateChecks)) {
		pushUnless(errors, satisfied === true, `releaseGate.checks.${name} must be true`);
	}

	const observability = isObject(evidence?.observability)
		? evidence.observability
		: {};
	pushUnless(
		errors,
		observability?.install?.installable === true,
		"observability.install.installable must be true",
	);
	pushUnless(
		errors,
		observability?.errors?.count === 0,
		"observability.errors.count must be 0",
	);
	pushUnless(
		errors,
		observability?.finalStatus?.allOk === true,
		"observability.finalStatus.allOk must be true",
	);
	pushUnless(
		errors,
		countModesWith(observability?.replay?.modes, REQUIRED_REPLAY_MODES) ===
			REQUIRED_REPLAY_MODES.length,
		"observability.replay.modes must include text, json, and rpc",
	);
	pushUnless(
		errors,
		countModesWith(observability?.sessions?.modes, REQUIRED_REPLAY_MODES) ===
			REQUIRED_REPLAY_MODES.length,
		"observability.sessions.modes must include text, json, and rpc",
	);
	pushUnless(
		errors,
		observability?.tools?.names?.includes?.("read") === true,
		"observability.tools.names must include read",
	);
	pushUnless(
		errors,
		observability?.tools?.callIds?.includes?.(TOOL_CALL_ID) === true,
		`observability.tools.callIds must include ${TOOL_CALL_ID}`,
	);
	pushUnless(
		errors,
		countModesWith(
			observability?.agentRuntimeLedger?.replayDeterministicModes,
			REQUIRED_REPLAY_MODES,
		) === REQUIRED_REPLAY_MODES.length,
		"observability.agentRuntimeLedger.replayDeterministicModes must include text, json, and rpc",
	);
	pushUnless(
		errors,
		countModesWith(
			observability?.agentRuntimeLedger?.durabilityModes,
			REQUIRED_REPLAY_MODES,
		) === REQUIRED_REPLAY_MODES.length,
		"observability.agentRuntimeLedger.durabilityModes must include text, json, and rpc",
	);

	if (errors.length > 0) {
		throw new Error(
			`${label} failed published replay evidence validation:\n- ${errors.join("\n- ")}`,
		);
	}

	return {
		label,
		packageSpec: packageInfo.spec,
		cliCommand: packageInfo.cliCommand,
		modes: modeNames,
	};
}

export function validatePublishedReplayEvidenceFile(filePath, { label = filePath } = {}) {
	if (!existsSync(filePath)) {
		throw new Error(`Missing published replay evidence: ${filePath}`);
	}
	return validatePublishedReplayEvidence(readPublishedReplayEvidence(filePath), {
		label,
	});
}

export function validatePublishedReplayEvidenceSet({
	evidenceDir = "published-replay-evidence",
	evidenceFiles = [],
	installers = REQUIRED_INSTALLERS,
} = {}) {
	const files =
		evidenceFiles.length > 0
			? evidenceFiles.map((filePath) => ({
					installer: filePath,
					path: resolve(filePath),
				}))
			: expectedPublishedReplayEvidenceFiles({ evidenceDir, installers });
	return files.map(({ installer, path }) =>
		validatePublishedReplayEvidenceFile(path, {
			label: `${installer} published replay evidence`,
		}),
	);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const installers =
		options.installers.length > 0 ? options.installers : REQUIRED_INSTALLERS;
	const summaries = validatePublishedReplayEvidenceSet({
		evidenceDir: options.evidenceDir || "published-replay-evidence",
		evidenceFiles: options.evidenceFiles,
		installers,
	});
	for (const summary of summaries) {
		console.log(
			`Validated published replay evidence for ${summary.packageSpec} (${summary.modes.join(", ")}).`,
		);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
