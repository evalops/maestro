#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPublishedReplayReleaseGate } from "./published-replay-evidence-gate.js";

const EVIDENCE_SCHEMA = "evalops.maestro.published-replay-evidence.v1";
const REQUIRED_INSTALLERS = ["npm", "bun"];
const REQUIRED_REPLAY_MODES = ["json", "rpc", "text"];
const REQUIRED_RELEASE_GATE_CHECKS = [
	"installablePackageMetadata",
	"noForbiddenWorkspaceReferences",
	"noWorkspaceProtocolReferences",
	"requiredReplayModes",
	"sessionEvidence",
	"toolEvidence",
	"approvalTraceEvidence",
	"artifactTraceEvidence",
	"agentRuntimeLedger",
	"finalStatus",
];
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

function parsePackageSpec(spec) {
	if (typeof spec !== "string") {
		return null;
	}
	const versionSeparator = spec.startsWith("@")
		? spec.indexOf("@", 1)
		: spec.indexOf("@");
	if (versionSeparator <= 0 || versionSeparator === spec.length - 1) {
		return null;
	}
	return {
		name: spec.slice(0, versionSeparator),
		version: spec.slice(versionSeparator + 1),
	};
}

function expectedInstallLabelFragment(installer) {
	switch (installer) {
		case "bun":
			return "via Bun";
		case "npm":
			return "via npm";
		default:
			return "";
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

export function validatePublishedReplayEvidence(
	evidence,
	{ label = "evidence", expectedInstaller = "" } = {},
) {
	const errors = [];
	pushUnless(
		errors,
		evidence?.schemaVersion === EVIDENCE_SCHEMA,
		`schemaVersion must be ${EVIDENCE_SCHEMA}`,
	);
	const installer = typeof evidence?.installer === "string" ? evidence.installer : "";
	pushUnless(errors, installer.length > 0, "installer must be a string");
	if (expectedInstaller) {
		pushUnless(
			errors,
			installer === expectedInstaller,
			`installer must be ${expectedInstaller}`,
		);
	}

	const packageInfo = isObject(evidence?.package) ? evidence.package : {};
	const installMetadata = isObject(packageInfo.installMetadata)
		? packageInfo.installMetadata
		: {};
	pushUnless(errors, typeof packageInfo.spec === "string", "package.spec must be a string");
	const expectedPackage = parsePackageSpec(packageInfo.spec);
	pushUnless(
		errors,
		expectedPackage !== null,
		"package.spec must include a package name and version",
	);
	pushUnless(
		errors,
		typeof packageInfo.cliCommand === "string",
		"package.cliCommand must be a string",
	);
	pushUnless(
		errors,
		typeof installMetadata.name === "string" &&
			expectedPackage !== null &&
			installMetadata.name === expectedPackage.name,
		"package.installMetadata.name must match package.spec name",
	);
	pushUnless(
		errors,
		typeof installMetadata.version === "string" &&
			expectedPackage !== null &&
			installMetadata.version === expectedPackage.version,
		"package.installMetadata.version must match package.spec version",
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
	const installLabel =
		typeof installMetadata.label === "string" ? installMetadata.label : "";
	const expectedLabel = expectedInstallLabelFragment(expectedInstaller || installer);
	if (expectedLabel) {
		pushUnless(
			errors,
			installLabel.includes(expectedLabel),
			`package.installMetadata.label must include ${expectedLabel}`,
		);
	}

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
	for (const name of REQUIRED_RELEASE_GATE_CHECKS) {
		pushUnless(errors, gateChecks[name] === true, `releaseGate.checks.${name} must be true`);
	}
	for (const [name, satisfied] of Object.entries(gateChecks)) {
		if (!REQUIRED_RELEASE_GATE_CHECKS.includes(name)) {
			pushUnless(errors, satisfied === true, `releaseGate.checks.${name} must be true`);
		}
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
		Number.isFinite(observability?.approvals?.count) &&
			observability.approvals.count >= REQUIRED_REPLAY_MODES.length &&
			stringArray(observability?.approvals?.evidenceRefs).every((ref) =>
				ref.startsWith("approval-request:"),
			),
		"observability.approvals must include approval-request evidence for every replay mode",
	);
	pushUnless(
		errors,
		Number.isFinite(observability?.artifacts?.count) &&
			observability.artifacts.count >= REQUIRED_REPLAY_MODES.length &&
			stringArray(observability?.artifacts?.evidenceRefs).every((ref) =>
				ref.startsWith("artifact:"),
			),
		"observability.artifacts must include artifact evidence for every replay mode",
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

export function validatePublishedReplayEvidenceFile(
	filePath,
	{ label = filePath, expectedInstaller = "" } = {},
) {
	if (!existsSync(filePath)) {
		throw new Error(`Missing published replay evidence: ${filePath}`);
	}
	return validatePublishedReplayEvidence(readPublishedReplayEvidence(filePath), {
		label,
		expectedInstaller,
	});
}

export function validatePublishedReplayEvidenceSet({
	evidenceDir = "published-replay-evidence",
	evidenceFiles = [],
	installers = REQUIRED_INSTALLERS,
} = {}) {
	const files =
		evidenceFiles.length > 0
			? evidenceFiles.map((filePath, index) => ({
					installer: installers[index] ?? "",
					path: resolve(filePath),
				}))
			: expectedPublishedReplayEvidenceFiles({ evidenceDir, installers });
	return files.map(({ installer, path }) =>
		validatePublishedReplayEvidenceFile(path, {
			expectedInstaller: REQUIRED_INSTALLERS.includes(installer) ? installer : "",
			label: installer ? `${installer} published replay evidence` : path,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
