#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPublishedReplayReleaseGate } from "./published-replay-evidence-gate.js";
import {
	REQUIRED_OBSERVABILITY_QUERY_TRACES,
	releaseObservabilityQueryDescriptorIsValid,
} from "./release-observability-query-contract.js";

const EVIDENCE_SCHEMA = "evalops.maestro.published-replay-evidence.v1";
const TRANSCRIPT_SCHEMA = "evalops.maestro.published-replay-transcript.v1";
const SCRIPTED_SCENARIO_SCHEMA = "evalops.maestro.scripted-scenario.v1";
const SCRIPTED_SCENARIO_RESULT_SCHEMA =
	"evalops.maestro.scripted-scenario-result.v1";
const AGENT_RUNTIME_LEDGER_SCHEMA = "evalops.maestro.agent-runtime-ledger.v1";
const AGENT_RUNTIME_COMPLETION_GATE = "maestro_agent_runtime_ledger_recorded";
const SCENARIO_RUNNER = "maestro scenario run";
const SCENARIO_ID = "maestro-published-replay";
const AUDIT_EVENT_TYPE = "maestro.scenario.replay.ready";
const REQUIRED_INSTALLERS = ["npm"];
const REQUIRED_REPLAY_MODES = ["json", "junit", "text"];
const REQUIRED_RELEASE_GATE_CHECKS = [
	"installablePackageMetadata",
	"noForbiddenWorkspaceReferences",
	"noWorkspaceProtocolReferences",
	"scenarioConfig",
	"requiredReplayModes",
	"transcriptEvidence",
	"deterministicReplayEvidence",
	"scenarioAssertionEvidence",
	"toolEvidence",
	"auditEventEvidence",
	"errorTraceEvidence",
	"queryableObservabilityIndex",
	"agentRuntimeInspection",
	"finalStatus",
];
const REQUIRED_ASSERTION_IDS = [
	"read-tool-called",
	"search-tool-called",
	"write-artifact-tool-called",
	"manifest-exists",
	"manifest-contains-search-pattern",
	"bash-tool-not-called",
	"audit-event-tagged",
];
const TERMINAL_AGENT_RUNTIME_STATES = new Set([
	"succeeded",
	"failed",
	"cancelled",
	"canceled",
]);
const TOOL_CALL_ID = "call-read-package-json";
const SEARCH_TOOL_CALL_ID = "call-search-package-manifest";
const WRITE_TOOL_CALL_ID = "call-write-published-artifact";
const REQUIRED_TOOL_EXECUTION_SPECS = [
	{ id: TOOL_CALL_ID, name: "read", inputPath: "package.json" },
	{ id: SEARCH_TOOL_CALL_ID, name: "search", inputPath: "package.json" },
	{
		id: WRITE_TOOL_CALL_ID,
		name: "write",
		inputPath: "published-replay-artifact.json",
	},
];
const ARTIFACT_PATH = "published-replay-artifact.json";
const SCRIPTED_REPLAY_TOOL_ALLOWLIST = ["read", "search", "write"];
const SCRIPTED_REPLAY_APPROVAL_MODE = "auto";
const EXPECTED_FINAL_TEXT_SHA256 =
	"b1623066f0894eaf01ec8155297fa424a825ccfb65a82dfc406125d677662aff";
const EXPECTED_SCENARIO_SHA256 =
	"3e3a49877168e6c429ca47f0053f3c6232171df144fb10622c641ecb6cd87654";
const PUBLISHED_REPLAY_EVIDENCE_REF_PREFIXES = [
	"tool-call:",
	"scenario-assertion:",
	"audit-event:",
	"inspection-session:",
];

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
					`Unknown argument: ${arg}\nUsage: node scripts/verify-published-replay-evidence.js [--evidence-dir <dir>] [--installer npm] [--evidence <file>]`,
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

function isSha256(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function filterPublishedReplayEvidenceRefs(refs) {
	return stringArray(refs).filter((ref) =>
		PUBLISHED_REPLAY_EVIDENCE_REF_PREFIXES.some((prefix) =>
			ref.startsWith(prefix),
		),
	);
}

function queryIndexEntryForTrace(queryIndex, traceType) {
	return Array.isArray(queryIndex)
		? queryIndex.find((entry) => entry?.traceType === traceType)
		: undefined;
}

function queryIndexEntryHasRequiredModes(entry) {
	return countModesWith(entry?.modes, REQUIRED_REPLAY_MODES) ===
		REQUIRED_REPLAY_MODES.length;
}

function releaseQueryDescriptorIsValid(entry, traceType) {
	return releaseObservabilityQueryDescriptorIsValid(entry, traceType);
}

function scenarioConfigIsValid(scenarioConfig, scenarioSha256) {
	return (
		isObject(scenarioConfig) &&
		scenarioConfig.runner === SCENARIO_RUNNER &&
		scenarioConfig.scenarioSchemaVersion === SCRIPTED_SCENARIO_SCHEMA &&
		scenarioConfig.scenarioId === SCENARIO_ID &&
		scenarioConfig.scenarioSha256 === scenarioSha256 &&
		scenarioConfig.deterministic === true &&
		scenarioConfig.externalCredentialsRequired === false &&
		scenarioConfig.externalNetworkRequired === false &&
		scenarioConfig.approvalMode === SCRIPTED_REPLAY_APPROVAL_MODE &&
		typeof scenarioConfig.sandboxMode === "string" &&
		scenarioConfig.sandboxMode.length > 0 &&
		SCRIPTED_REPLAY_TOOL_ALLOWLIST.every((toolName) =>
			stringArray(scenarioConfig.toolAllowlist).includes(toolName),
		)
	);
}

function canonicalJson(value) {
	if (Array.isArray(value)) {
		return value.map(canonicalJson);
	}
	if (!isObject(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalJson(entry)]),
	);
}

function scenarioConfigsMatch(left, right) {
	return (
		isObject(left) &&
		isObject(right) &&
		JSON.stringify(canonicalJson(left)) ===
			JSON.stringify(canonicalJson(right))
	);
}

function determinismIsValid(determinism) {
	return (
		isObject(determinism) &&
		determinism.runs === 2 &&
		determinism.identical === true &&
		isSha256(determinism.resultSha256)
	);
}

function transcriptModeEntry(transcript, modeName) {
	const modes = Array.isArray(transcript?.modes) ? transcript.modes : [];
	return modes.find((mode) => mode?.mode === modeName);
}

function transcriptToolCall(mode, toolCallId) {
	const toolCalls = Array.isArray(mode?.toolCalls) ? mode.toolCalls : [];
	return toolCalls.find((toolCall) => toolCall?.id === toolCallId);
}

function transcriptCoversRequiredModes(transcript) {
	const transcriptModes = Array.isArray(transcript?.modes)
		? transcript.modes.map((mode) => mode?.mode)
		: [];
	return (
		JSON.stringify(sortedStrings(transcriptModes)) ===
		JSON.stringify(REQUIRED_REPLAY_MODES)
	);
}

function transcriptIsValid(transcript, scenarioSha256) {
	if (
		!isObject(transcript) ||
		transcript.schemaVersion !== TRANSCRIPT_SCHEMA ||
		transcript?.scenario?.id !== SCENARIO_ID ||
		transcript?.scenario?.schemaVersion !== SCRIPTED_SCENARIO_SCHEMA ||
		transcript?.scenario?.sha256 !== scenarioSha256 ||
		!transcriptCoversRequiredModes(transcript)
	) {
		return false;
	}
	const coverageModes = stringArray(transcript?.coverage?.modes);
	const coverageToolCallIds = stringArray(transcript?.coverage?.toolCallIds);
	if (
		countModesWith(coverageModes, REQUIRED_REPLAY_MODES) !==
			REQUIRED_REPLAY_MODES.length ||
		REQUIRED_TOOL_EXECUTION_SPECS.some(
			(spec) => !coverageToolCallIds.includes(spec.id),
		) ||
		transcript?.coverage?.finalStatus?.ok !== REQUIRED_REPLAY_MODES.length
	) {
		return false;
	}
	return REQUIRED_REPLAY_MODES.every((modeName) => {
		const mode = transcriptModeEntry(transcript, modeName);
		return (
			isObject(mode) &&
			mode.scenarioSha256 === scenarioSha256 &&
			REQUIRED_TOOL_EXECUTION_SPECS.every((spec) => {
				const toolCall = transcriptToolCall(mode, spec.id);
				return (
					toolCall?.name === spec.name &&
					toolCall?.inputPath === spec.inputPath &&
					toolCall?.resultStatus === "success"
				);
			}) &&
			mode?.final?.status === "ok" &&
			mode?.final?.containsExpectedText === true &&
			mode?.final?.textSha256 === EXPECTED_FINAL_TEXT_SHA256 &&
			isSha256(mode?.output?.sha256) &&
			Number.isFinite(mode?.output?.bytes) &&
			mode.output.bytes > 0
		);
	});
}

function transcriptObservabilityIsValid(observabilityTranscript, scenarioSha256) {
	return (
		isObject(observabilityTranscript) &&
		observabilityTranscript.schemaVersion === TRANSCRIPT_SCHEMA &&
		observabilityTranscript.scenarioSha256 === scenarioSha256 &&
		countModesWith(observabilityTranscript.modes, REQUIRED_REPLAY_MODES) ===
			REQUIRED_REPLAY_MODES.length &&
		REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
			stringArray(observabilityTranscript.toolCallIds).includes(spec.id),
		) &&
		observabilityTranscript?.finalStatus?.ok === REQUIRED_REPLAY_MODES.length
	);
}

function agentRuntimeInspectionIsValid(inspection) {
	if (!isObject(inspection)) {
		return false;
	}
	const terminalStates = isObject(inspection?.outcomes?.terminalStates)
		? Object.entries(inspection.outcomes.terminalStates)
		: [];
	const toolCallEvidence = Array.isArray(inspection?.toolCallEvidence)
		? inspection.toolCallEvidence.filter(isObject)
		: [];
	return (
		inspection.fixture === true &&
		inspection.ledgerSchemaVersion === AGENT_RUNTIME_LEDGER_SCHEMA &&
		typeof inspection.sessionId === "string" &&
		inspection.sessionId.length > 0 &&
		inspection.replayDeterministic === true &&
		inspection.hasHandleTrigger === true &&
		inspection.hasRecordRunStep === true &&
		inspection.hasRecordRunWorkItem === true &&
		inspection.hasTerminalOperation === true &&
		inspection.completionGate === AGENT_RUNTIME_COMPLETION_GATE &&
		Number.isFinite(inspection?.counts?.entries) &&
		inspection.counts.entries > 0 &&
		Number.isFinite(inspection?.counts?.promotionOperations) &&
		inspection.counts.promotionOperations > 0 &&
		Number.isFinite(inspection?.counts?.terminalOperations) &&
		inspection.counts.terminalOperations > 0 &&
		terminalStates.some(
			([state, count]) =>
				TERMINAL_AGENT_RUNTIME_STATES.has(state) &&
				typeof count === "number" &&
				Number.isFinite(count) &&
				count > 0,
		) &&
		toolCallEvidence.length > 0 &&
		toolCallEvidence.every(
			(entry) =>
				typeof entry?.toolName === "string" &&
				entry.toolName.length > 0 &&
				typeof entry?.toolCallId === "string" &&
				entry.toolCallId.length > 0 &&
				entry?.completionGate === AGENT_RUNTIME_COMPLETION_GATE &&
				stringArray(entry?.evidenceKinds).includes("tool_call"),
		) &&
		inspection?.durability?.reconstructable === true &&
		inspection?.durability?.replayDeterministic === true &&
		inspection?.durability?.sessionFilePresent === true &&
		typeof inspection?.durability?.promotionIdempotencyKey === "string" &&
		inspection.durability.promotionIdempotencyKey.length > 0 &&
		stringArray(inspection?.evidenceRefs).includes(
			`inspection-session:${inspection.sessionId}`,
		)
	);
}

function queryableObservabilityIndexIsValid({ observability }) {
	const queryIndex = Array.isArray(observability?.queryIndex)
		? observability.queryIndex
		: [];
	if (
		!REQUIRED_OBSERVABILITY_QUERY_TRACES.every((traceType) =>
			queryIndex.some(
				(entry) =>
					isObject(entry) &&
					entry.traceType === traceType &&
					entry.queryable === true &&
					entry.status === "ok" &&
					releaseQueryDescriptorIsValid(entry, traceType),
			),
		)
	) {
		return false;
	}

	const installEntry = queryIndexEntryForTrace(queryIndex, "install");
	const scenarioEntry = queryIndexEntryForTrace(queryIndex, "scenario");
	const toolEntry = queryIndexEntryForTrace(queryIndex, "tool");
	const errorEntry = queryIndexEntryForTrace(queryIndex, "error");
	const inspectionEntry = queryIndexEntryForTrace(queryIndex, "inspection");
	const finalStatusEntry = queryIndexEntryForTrace(queryIndex, "final-status");
	const toolRefs = stringArray(toolEntry?.evidenceRefs);
	const scenarioRefs = stringArray(scenarioEntry?.evidenceRefs);
	const inspectionRefs = stringArray(inspectionEntry?.evidenceRefs);

	return (
		isObject(installEntry?.counts) &&
		installEntry.counts.forbiddenReferences === 0 &&
		installEntry.counts.workspaceProtocolReferences === 0 &&
		queryIndexEntryHasRequiredModes(scenarioEntry) &&
		stringArray(scenarioEntry?.ids).includes(SCENARIO_ID) &&
		scenarioEntry?.counts?.failed === 0 &&
		Number.isFinite(scenarioEntry?.counts?.passed) &&
		scenarioEntry.counts.passed === REQUIRED_ASSERTION_IDS.length &&
		scenarioRefs.includes(`audit-event:${AUDIT_EVENT_TYPE}`) &&
		REQUIRED_ASSERTION_IDS.every((id) =>
			scenarioRefs.includes(`scenario-assertion:${id}`),
		) &&
		queryIndexEntryHasRequiredModes(toolEntry) &&
		REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
			stringArray(toolEntry?.ids).includes(spec.id),
		) &&
		REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
			toolRefs.includes(`tool-call:${spec.id}`),
		) &&
		errorEntry?.counts?.count === 0 &&
		errorEntry?.counts?.expectedCount === 0 &&
		inspectionEntry?.status === "ok" &&
		inspectionRefs.some((ref) => ref.startsWith("inspection-session:")) &&
		agentRuntimeInspectionIsValid(observability?.agentRuntimeInspection) &&
		queryIndexEntryHasRequiredModes(finalStatusEntry) &&
		finalStatusEntry?.counts?.ok === REQUIRED_REPLAY_MODES.length
	);
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

function validateModeEvidence(errors, mode) {
	const modeName = typeof mode?.mode === "string" ? mode.mode : "unknown";
	pushUnless(errors, mode?.status === "ok", `${modeName}.status must be ok`);
	pushUnless(
		errors,
		mode?.scenario?.id === SCENARIO_ID &&
			mode?.scenario?.schemaVersion === SCRIPTED_SCENARIO_SCHEMA &&
			mode?.scenario?.sha256 === EXPECTED_SCENARIO_SHA256,
		`${modeName}.scenario must reference the pinned published replay scenario`,
	);
	const toolFields = [
		["tool", REQUIRED_TOOL_EXECUTION_SPECS[0], "read-tool-called"],
		["searchTool", REQUIRED_TOOL_EXECUTION_SPECS[1], "search-tool-called"],
		["artifactTool", REQUIRED_TOOL_EXECUTION_SPECS[2], "write-artifact-tool-called"],
	];
	for (const [field, spec, assertionId] of toolFields) {
		pushUnless(
			errors,
			mode?.[field]?.name === spec.name,
			`${modeName}.${field}.name must be ${spec.name}`,
		);
		pushUnless(
			errors,
			mode?.[field]?.callId === spec.id,
			`${modeName}.${field}.callId must be ${spec.id}`,
		);
		pushUnless(
			errors,
			mode?.[field]?.inputPath === spec.inputPath,
			`${modeName}.${field}.inputPath must be ${spec.inputPath}`,
		);
		pushUnless(
			errors,
			mode?.[field]?.resultStatus === "success",
			`${modeName}.${field}.resultStatus must be success`,
		);
		pushUnless(
			errors,
			mode?.[field]?.assertionId === assertionId,
			`${modeName}.${field}.assertionId must be ${assertionId}`,
		);
	}
	pushUnless(errors, mode?.final?.status === "ok", `${modeName}.final.status must be ok`);
	pushUnless(
		errors,
		mode?.final?.containsExpectedText === true,
		`${modeName}.final.containsExpectedText must be true`,
	);
	pushUnless(
		errors,
		mode?.final?.textSha256 === EXPECTED_FINAL_TEXT_SHA256,
		`${modeName}.final.textSha256 must match the pinned final text`,
	);
	pushUnless(
		errors,
		isSha256(mode?.output?.sha256),
		`${modeName}.output.sha256 must be a 64 character hex string`,
	);
	pushUnless(
		errors,
		Number.isFinite(mode?.output?.bytes) && mode.output.bytes > 0,
		`${modeName}.output.bytes must be positive`,
	);

	if (modeName === "json") {
		pushUnless(
			errors,
			mode?.result?.schemaVersion === SCRIPTED_SCENARIO_RESULT_SCHEMA,
			"json.result.schemaVersion must be the scripted scenario result schema",
		);
		pushUnless(
			errors,
			mode?.result?.observedOutcome === "pass",
			"json.result.observedOutcome must be pass",
		);
		pushUnless(
			errors,
			mode?.result?.assertionsPassed === REQUIRED_ASSERTION_IDS.length &&
				mode?.result?.assertionsFailed === 0,
			"json.result must record every assertion passing",
		);
		pushUnless(
			errors,
			isSha256(mode?.result?.resultSha256),
			"json.result.resultSha256 must be a 64 character hex string",
		);
		pushUnless(
			errors,
			determinismIsValid(mode?.determinism),
			"json.determinism must prove identical results across two runs",
		);
	}
	if (modeName === "junit") {
		pushUnless(
			errors,
			mode?.junit?.tests === REQUIRED_ASSERTION_IDS.length &&
				mode?.junit?.failures === 0,
			"junit.junit must record every assertion with zero failures",
		);
		pushUnless(
			errors,
			REQUIRED_ASSERTION_IDS.every((id) =>
				stringArray(mode?.junit?.testcaseNames).includes(id),
			),
			"junit.junit.testcaseNames must cover every assertion",
		);
	}
	if (modeName === "text") {
		pushUnless(
			errors,
			mode?.output?.containsSummary === true,
			"text.output.containsSummary must be true",
		);
	}
}

function crossModeConsistencyIsValid(evidence) {
	const modes = Array.isArray(evidence?.modes) ? evidence.modes : [];
	const jsonMode = modes.find((mode) => mode?.mode === "json");
	if (!isObject(jsonMode)) {
		return false;
	}
	const determinismSha = evidence?.replay?.determinism?.resultSha256;
	if (
		JSON.stringify(canonicalJson(evidence?.replay?.determinism)) !==
			JSON.stringify(canonicalJson(jsonMode.determinism)) ||
		determinismSha !== jsonMode?.determinism?.resultSha256 ||
		determinismSha !== jsonMode?.result?.resultSha256 ||
		determinismSha !== jsonMode?.output?.sha256
	) {
		return false;
	}
	const transcriptModes = Array.isArray(evidence?.transcript?.modes)
		? evidence.transcript.modes
		: [];
	return modes.every((mode) => {
		const transcriptMode = transcriptModes.find(
			(entry) => entry?.mode === mode?.mode,
		);
		return (
			isObject(transcriptMode) &&
			transcriptMode?.output?.sha256 === mode?.output?.sha256 &&
			transcriptMode?.output?.bytes === mode?.output?.bytes
		);
	});
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
		evidence?.replay?.runner === SCENARIO_RUNNER,
		`replay.runner must be "${SCENARIO_RUNNER}"`,
	);
	pushUnless(
		errors,
		evidence?.replay?.scenario?.id === SCENARIO_ID &&
			evidence?.replay?.scenario?.schemaVersion === SCRIPTED_SCENARIO_SCHEMA &&
			evidence?.replay?.scenario?.sha256 === EXPECTED_SCENARIO_SHA256,
		"replay.scenario must reference the pinned published replay scenario",
	);
	pushUnless(
		errors,
		scenarioConfigIsValid(
			evidence?.replay?.scenarioConfig,
			EXPECTED_SCENARIO_SHA256,
		),
		"replay.scenarioConfig must describe the deterministic scenario runner configuration",
	);
	pushUnless(
		errors,
		determinismIsValid(evidence?.replay?.determinism),
		"replay.determinism must prove identical scenario results across two runs",
	);
	pushUnless(
		errors,
		crossModeConsistencyIsValid(evidence),
		"replay.determinism, json mode result, and transcript outputs must be hash-consistent",
	);
	pushUnless(
		errors,
		transcriptIsValid(evidence?.transcript, EXPECTED_SCENARIO_SHA256),
		"transcript must include queryable published replay transcript evidence for text, json, and junit",
	);

	const modes = Array.isArray(evidence?.modes) ? evidence.modes : [];
	const modeNames = sortedStrings(modes.map((mode) => mode?.mode));
	pushUnless(
		errors,
		JSON.stringify(modeNames) === JSON.stringify(REQUIRED_REPLAY_MODES),
		`modes must exactly cover ${REQUIRED_REPLAY_MODES.join(", ")}`,
	);
	for (const mode of modes) {
		validateModeEvidence(errors, mode);
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
		observability?.errors?.queryable === true &&
			observability.errors.expectedCount === 0 &&
			Array.isArray(observability.errors.modes) &&
			observability.errors.modes.length === 0 &&
			isObject(observability.errors.byStatus) &&
			Array.isArray(observability.errors.evidenceRefs),
		"observability.errors must declare a queryable zero-error trace",
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
		"observability.replay.modes must include text, json, and junit",
	);
	pushUnless(
		errors,
		scenarioConfigIsValid(
			observability?.scenarioConfig,
			EXPECTED_SCENARIO_SHA256,
		) &&
			scenarioConfigsMatch(
				observability?.scenarioConfig,
				evidence?.replay?.scenarioConfig,
			),
		"observability.scenarioConfig must mirror replay.scenarioConfig",
	);
	pushUnless(
		errors,
		transcriptObservabilityIsValid(
			observability?.transcript,
			EXPECTED_SCENARIO_SHA256,
		),
		"observability.transcript must summarize transcript modes, tool calls, and final status",
	);
	pushUnless(
		errors,
		observability?.scenario?.id === SCENARIO_ID &&
			observability?.scenario?.sha256 === EXPECTED_SCENARIO_SHA256 &&
			observability?.scenario?.observedOutcome === "pass" &&
			observability?.scenario?.failed === 0 &&
			observability?.scenario?.passed === REQUIRED_ASSERTION_IDS.length,
		"observability.scenario must record a passing run of the pinned scenario",
	);
	pushUnless(
		errors,
		stringArray(observability?.scenario?.auditEvents).includes(
			AUDIT_EVENT_TYPE,
		) &&
			stringArray(observability?.scenario?.evidenceRefs).includes(
				`audit-event:${AUDIT_EVENT_TYPE}`,
			) &&
			REQUIRED_ASSERTION_IDS.every((id) =>
				stringArray(observability?.scenario?.evidenceRefs).includes(
					`scenario-assertion:${id}`,
				),
			),
		"observability.scenario must surface audit event and assertion evidence",
	);
	pushUnless(
		errors,
		observability?.tools?.names?.includes?.("read") === true &&
			observability?.tools?.names?.includes?.("search") === true &&
			observability?.tools?.names?.includes?.("write") === true,
		"observability.tools.names must include read, search, and write",
	);
	for (const spec of REQUIRED_TOOL_EXECUTION_SPECS) {
		pushUnless(
			errors,
			observability?.tools?.callIds?.includes?.(spec.id) === true,
			`observability.tools.callIds must include ${spec.id}`,
		);
		pushUnless(
			errors,
			filterPublishedReplayEvidenceRefs(observability?.tools?.evidenceRefs).includes(
				`tool-call:${spec.id}`,
			),
			`observability.tools.evidenceRefs must include tool-call:${spec.id}`,
		);
	}
	pushUnless(
		errors,
		agentRuntimeInspectionIsValid(evidence?.agentRuntimeInspection),
		"agentRuntimeInspection must include fixture AgentRuntime ledger, durability, and completion gate evidence",
	);
	pushUnless(
		errors,
		agentRuntimeInspectionIsValid(observability?.agentRuntimeInspection),
		"observability.agentRuntimeInspection must summarize the fixture AgentRuntime inspection",
	);
	pushUnless(
		errors,
		queryableObservabilityIndexIsValid({ observability }),
		"observability.queryIndex must provide queryable install, scenario, tool, error, inspection, and final-status traces with release query descriptors",
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
