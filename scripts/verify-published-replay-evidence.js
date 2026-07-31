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
const SCENARIO_RUNNER_EXECUTE = "maestro scenario run --execute";
const SCENARIO_RUNNER_OFFLINE = "maestro scenario run";
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
	"toolExecutionEvidence",
	"sessionEvidence",
	"searchEvidence",
	"auditEventEvidence",
	"errorTraceEvidence",
	"queryableObservabilityIndex",
	"agentRuntimeLedger",
	"finalStatus",
];
const BASE_ASSERTION_IDS = [
	"read-tool-called",
	"write-artifact-tool-called",
	"manifest-exists",
	"manifest-contains-search-pattern",
	"artifact-exists",
	"artifact-contents",
	"bash-tool-not-called",
	"audit-event-tagged",
];
const SEARCH_ASSERTION_ID = "search-tool-called";
const TERMINAL_AGENT_RUNTIME_STATES = new Set([
	"succeeded",
	"failed",
	"cancelled",
	"canceled",
]);
const TOOL_CALL_ID = "call-read-package-json";
const SEARCH_TOOL_CALL_ID = "call-search-package-manifest";
const WRITE_TOOL_CALL_ID = "call-write-published-artifact";
const READ_TOOL_SPEC = { id: TOOL_CALL_ID, name: "read", inputPath: "package.json" };
const SEARCH_TOOL_SPEC = {
	id: SEARCH_TOOL_CALL_ID,
	name: "search",
	inputPath: "package.json",
};
const WRITE_TOOL_SPEC = {
	id: WRITE_TOOL_CALL_ID,
	name: "write",
	inputPath: "published-replay-artifact.json",
};
const ARTIFACT_PATH = "published-replay-artifact.json";
const SCRIPTED_REPLAY_APPROVAL_MODE = "auto";
const SEARCH_SKIP_REASON = "rg-not-found";
const EXECUTE_SKIP_REASON = "binary-lacks-execute";
const EXPECTED_FINAL_TEXT_SHA256 =
	"b1623066f0894eaf01ec8155297fa424a825ccfb65a82dfc406125d677662aff";
// The smoke generates one of two scenario variants depending on whether the
// ripgrep binary is available on PATH (the native `search` tool shells out
// to rg). Both hashes are pinned; the hash determines which evidence shape
// the verifier requires.
// The smoke generates one of four scenario variants (search leg x execute
// capability). All hashes are pinned; the hash determines which evidence
// shape the verifier requires, so a forged skip on a capable-variant hash is
// rejected and vice versa.
const EXPECTED_SCENARIO_SHA256_WITH_SEARCH =
	"57fa2783a7e1f062dfa8673f9b90c6d08d0df9de14690f492388697e2579909f";
const EXPECTED_SCENARIO_SHA256_NO_SEARCH =
	"04d2dc217b51f091272cfa6b96616624a12bf75cc3078150af07a518d8bfa0c0";
const EXPECTED_SCENARIO_SHA256_NO_EXECUTE_WITH_SEARCH =
	"a47fe043ffa85e49b05d2ebb4bd6d915885329b2cf57dd791d35afceee3446f6";
const EXPECTED_SCENARIO_SHA256_NO_EXECUTE_NO_SEARCH =
	"77a97b1a191dde2299d9d870d31f53aa27409fb5c5c3a36aec5af553e3c25742";
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

function variantForScenarioSha(scenarioSha256) {
	switch (scenarioSha256) {
		case EXPECTED_SCENARIO_SHA256_WITH_SEARCH:
			return { search: true, execute: true };
		case EXPECTED_SCENARIO_SHA256_NO_SEARCH:
			return { search: false, execute: true };
		case EXPECTED_SCENARIO_SHA256_NO_EXECUTE_WITH_SEARCH:
			return { search: true, execute: false };
		case EXPECTED_SCENARIO_SHA256_NO_EXECUTE_NO_SEARCH:
			return { search: false, execute: false };
		default:
			return null;
	}
}

function toolSpecsForSearch(searchExecuted) {
	return searchExecuted
		? [READ_TOOL_SPEC, SEARCH_TOOL_SPEC, WRITE_TOOL_SPEC]
		: [READ_TOOL_SPEC, WRITE_TOOL_SPEC];
}

// Workspace execution assertions (the written artifact) only exist in the
// scenario when the target binary advertises --execute.
const EXECUTION_ASSERTION_IDS = ["artifact-exists", "artifact-contents"];

function assertionIdsForVariant(variant) {
	const ids = variant.search
		? [
				BASE_ASSERTION_IDS[0],
				SEARCH_ASSERTION_ID,
				...BASE_ASSERTION_IDS.slice(1),
			]
		: [...BASE_ASSERTION_IDS];
	if (!variant.execute) {
		return ids.filter((id) => !EXECUTION_ASSERTION_IDS.includes(id));
	}
	return ids;
}

function scenarioConfigIsValid(scenarioConfig, scenarioSha256, variant) {
	const searchTool = isObject(scenarioConfig?.searchTool)
		? scenarioConfig.searchTool
		: {};
	const execute = isObject(scenarioConfig?.execute) ? scenarioConfig.execute : {};
	return (
		isObject(scenarioConfig) &&
		scenarioConfig.runner ===
			(variant.execute ? SCENARIO_RUNNER_EXECUTE : SCENARIO_RUNNER_OFFLINE) &&
		scenarioConfig.scenarioSchemaVersion === SCRIPTED_SCENARIO_SCHEMA &&
		scenarioConfig.scenarioId === SCENARIO_ID &&
		scenarioConfig.scenarioSha256 === scenarioSha256 &&
		scenarioConfig.deterministic === true &&
		scenarioConfig.externalCredentialsRequired === false &&
		scenarioConfig.externalNetworkRequired === false &&
		scenarioConfig.approvalMode === SCRIPTED_REPLAY_APPROVAL_MODE &&
		typeof scenarioConfig.sandboxMode === "string" &&
		scenarioConfig.sandboxMode.length > 0 &&
		toolSpecsForSearch(variant.search).every((spec) =>
			stringArray(scenarioConfig.toolAllowlist).includes(spec.name),
		) &&
		(variant.search
			? searchTool.status === "executed"
			: searchTool.status === "skipped" &&
				searchTool.reason === SEARCH_SKIP_REASON) &&
		(variant.execute
			? execute.status === "executed"
			: execute.status === "skipped" &&
				execute.reason === EXECUTE_SKIP_REASON)
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

function determinismIsValid(determinism, executeCapable = true) {
	return (
		isObject(determinism) &&
		determinism.runs === 2 &&
		determinism.identical === true &&
		(executeCapable
			? isSha256(determinism.transcriptSha256)
			: isSha256(determinism.resultSha256))
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

function transcriptIsValid(transcript, scenarioSha256, variant) {
	const specs = toolSpecsForSearch(variant.search);
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
		specs.some((spec) => !coverageToolCallIds.includes(spec.id)) ||
		transcript?.coverage?.finalStatus?.ok !== REQUIRED_REPLAY_MODES.length
	) {
		return false;
	}
	return REQUIRED_REPLAY_MODES.every((modeName) => {
		const mode = transcriptModeEntry(transcript, modeName);
		return (
			isObject(mode) &&
			mode.scenarioSha256 === scenarioSha256 &&
			specs.every((spec) => {
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
			(variant.execute
				? typeof mode?.session?.sessionId === "string" &&
					mode.session.sessionId.length > 0 &&
					Number.isFinite(mode?.session?.jsonlFileCount) &&
					mode.session.jsonlFileCount > 0 &&
					Number.isFinite(mode?.session?.bytes) &&
					mode.session.bytes > 0 &&
					isSha256(mode?.session?.sha256)
				: mode?.session?.status === "skipped" &&
					mode?.session?.reason === EXECUTE_SKIP_REASON)
		);
	});
}

function transcriptObservabilityIsValid(
	observabilityTranscript,
	scenarioSha256,
	variant,
) {
	return (
		isObject(observabilityTranscript) &&
		observabilityTranscript.schemaVersion === TRANSCRIPT_SCHEMA &&
		observabilityTranscript.scenarioSha256 === scenarioSha256 &&
		countModesWith(observabilityTranscript.modes, REQUIRED_REPLAY_MODES) ===
			REQUIRED_REPLAY_MODES.length &&
		toolSpecsForSearch(variant.search).every((spec) =>
			stringArray(observabilityTranscript.toolCallIds).includes(spec.id),
		) &&
		observabilityTranscript?.finalStatus?.ok === REQUIRED_REPLAY_MODES.length
	);
}

function agentRuntimeLedgerIsValid(ledger, variant) {
	if (!isObject(ledger)) {
		return false;
	}
	const terminalStates = isObject(ledger?.outcomes?.terminalStates)
		? Object.entries(ledger.outcomes.terminalStates)
		: [];
	const toolCallEvidence = Array.isArray(ledger?.toolCallEvidence)
		? ledger.toolCallEvidence.filter(isObject)
		: [];
	return (
		ledger.schemaVersion === AGENT_RUNTIME_LEDGER_SCHEMA &&
		ledger.replayDeterministic === true &&
		ledger.hasHandleTrigger === true &&
		ledger.hasRecordRunStep === true &&
		ledger.hasRecordRunWorkItem === true &&
		ledger.hasTerminalOperation === true &&
		ledger.completionGate === AGENT_RUNTIME_COMPLETION_GATE &&
		Number.isFinite(ledger?.counts?.entries) &&
		ledger.counts.entries > 0 &&
		Number.isFinite(ledger?.counts?.promotionOperations) &&
		ledger.counts.promotionOperations > 0 &&
		Number.isFinite(ledger?.counts?.terminalOperations) &&
		ledger.counts.terminalOperations > 0 &&
		terminalStates.some(
			([state, count]) =>
				TERMINAL_AGENT_RUNTIME_STATES.has(state) &&
				typeof count === "number" &&
				Number.isFinite(count) &&
				count > 0,
		) &&
		toolSpecsForSearch(variant.search).every((spec) =>
			toolCallEvidence.some(
				(entry) =>
					entry?.toolName === spec.name &&
					entry?.toolCallId === spec.id &&
					entry?.completionGate === AGENT_RUNTIME_COMPLETION_GATE &&
					stringArray(entry?.evidenceKinds).includes("tool_call"),
			),
		) &&
		ledger?.durability?.reconstructable === true &&
		ledger?.durability?.replayDeterministic === true &&
		ledger?.durability?.sessionFilePresent === true &&
		typeof ledger?.durability?.promotionIdempotencyKey === "string" &&
		ledger.durability.promotionIdempotencyKey.length > 0
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

function queryableObservabilityIndexIsValid({ observability, variant }) {
	const queryIndex = Array.isArray(observability?.queryIndex)
		? observability.queryIndex
		: [];
	if (
		!REQUIRED_OBSERVABILITY_QUERY_TRACES.every((traceType) => {
			const expectedStatus =
				!variant.execute &&
				(traceType === "session" || traceType === "inspection")
					? "skipped"
					: "ok";
			return queryIndex.some(
				(entry) =>
					isObject(entry) &&
					entry.traceType === traceType &&
					entry.queryable === true &&
					entry.status === expectedStatus &&
					(expectedStatus !== "skipped" ||
						entry.reason === EXECUTE_SKIP_REASON) &&
					releaseQueryDescriptorIsValid(entry, traceType),
			);
		})
	) {
		return false;
	}

	const installEntry = queryIndexEntryForTrace(queryIndex, "install");
	const sessionEntry = queryIndexEntryForTrace(queryIndex, "session");
	const scenarioEntry = queryIndexEntryForTrace(queryIndex, "scenario");
	const toolEntry = queryIndexEntryForTrace(queryIndex, "tool");
	const errorEntry = queryIndexEntryForTrace(queryIndex, "error");
	const inspectionEntry = queryIndexEntryForTrace(queryIndex, "inspection");
	const finalStatusEntry = queryIndexEntryForTrace(queryIndex, "final-status");
	const toolRefs = stringArray(toolEntry?.evidenceRefs);
	const scenarioRefs = stringArray(scenarioEntry?.evidenceRefs);
	const inspectionRefs = stringArray(inspectionEntry?.evidenceRefs);
	const specs = toolSpecsForSearch(variant.search);
	const assertionIds = assertionIdsForVariant(variant);

	return (
		isObject(installEntry?.counts) &&
		installEntry.counts.forbiddenReferences === 0 &&
		installEntry.counts.workspaceProtocolReferences === 0 &&
		(variant.execute
			? queryIndexEntryHasRequiredModes(sessionEntry) &&
				Number.isFinite(sessionEntry?.counts?.jsonlFileCount) &&
				sessionEntry.counts.jsonlFileCount >= REQUIRED_REPLAY_MODES.length
			: sessionEntry?.status === "skipped" &&
				sessionEntry?.reason === EXECUTE_SKIP_REASON) &&
		queryIndexEntryHasRequiredModes(scenarioEntry) &&
		stringArray(scenarioEntry?.ids).includes(SCENARIO_ID) &&
		scenarioEntry?.counts?.failed === 0 &&
		scenarioEntry?.counts?.passed === assertionIds.length &&
		scenarioRefs.includes(`audit-event:${AUDIT_EVENT_TYPE}`) &&
		assertionIds.every((id) =>
			scenarioRefs.includes(`scenario-assertion:${id}`),
		) &&
		queryIndexEntryHasRequiredModes(toolEntry) &&
		specs.every((spec) => stringArray(toolEntry?.ids).includes(spec.id)) &&
		specs.every((spec) => toolRefs.includes(`tool-call:${spec.id}`)) &&
		errorEntry?.counts?.count === 0 &&
		errorEntry?.counts?.expectedCount === 0 &&
		(variant.execute
			? inspectionEntry?.status === "ok" &&
				queryIndexEntryHasRequiredModes(inspectionEntry) &&
				inspectionRefs.some((ref) => ref.startsWith("inspection-session:"))
			: inspectionEntry?.status === "skipped" &&
				inspectionEntry?.reason === EXECUTE_SKIP_REASON) &&
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

function validateModeEvidence(errors, mode, scenarioSha256, variant) {
	const modeName = typeof mode?.mode === "string" ? mode.mode : "unknown";
	const specs = toolSpecsForSearch(variant.search);
	const assertionIds = assertionIdsForVariant(variant);
	pushUnless(errors, mode?.status === "ok", `${modeName}.status must be ok`);
	pushUnless(
		errors,
		mode?.scenario?.id === SCENARIO_ID &&
			mode?.scenario?.schemaVersion === SCRIPTED_SCENARIO_SCHEMA &&
			mode?.scenario?.sha256 === scenarioSha256,
		`${modeName}.scenario must reference the pinned published replay scenario`,
	);
	const toolFields = [
		["tool", READ_TOOL_SPEC, "read-tool-called"],
		["artifactTool", WRITE_TOOL_SPEC, "write-artifact-tool-called"],
	];
	if (variant.search) {
		toolFields.splice(1, 0, [
			"searchTool",
			SEARCH_TOOL_SPEC,
			"search-tool-called",
		]);
	}
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
	if (!variant.search) {
		pushUnless(
			errors,
			mode?.searchTool === undefined,
			`${modeName}.searchTool must be absent when the search leg is skipped`,
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
	if (variant.execute) {
		pushUnless(
			errors,
			typeof mode?.session?.sessionId === "string" &&
				mode.session.sessionId.length > 0,
			`${modeName}.session.sessionId must be a non-empty string`,
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
			isSha256(mode?.session?.sha256),
			`${modeName}.session.sha256 must be a 64 character hex string`,
		);
		pushUnless(
			errors,
			mode?.session?.containsFinalText === true &&
				mode?.session?.containsToolCallId === true &&
				mode?.session?.containsWriteToolCallId === true &&
				mode?.session?.containsSearchToolCallId === variant.search,
			`${modeName}.session must record the final text and executed tool call ids`,
		);
		pushUnless(
			errors,
			agentRuntimeLedgerIsValid(mode?.agentRuntimeLedger, variant),
			`${modeName}.agentRuntimeLedger must include completion-gated ledger operations, tool_call evidence, and durable idempotent promotion`,
		);
	} else {
		pushUnless(
			errors,
			mode?.session?.status === "skipped" &&
				mode?.session?.reason === EXECUTE_SKIP_REASON,
			`${modeName}.session must be recorded as skipped (${EXECUTE_SKIP_REASON})`,
		);
		pushUnless(
			errors,
			mode?.agentRuntimeLedger?.status === "skipped" &&
				mode?.agentRuntimeLedger?.reason === EXECUTE_SKIP_REASON,
			`${modeName}.agentRuntimeLedger must be recorded as skipped (${EXECUTE_SKIP_REASON})`,
		);
	}

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
			mode?.result?.assertionsPassed === assertionIds.length &&
				mode?.result?.assertionsFailed === 0,
			"json.result must record every assertion passing",
		);
		pushUnless(
			errors,
			determinismIsValid(mode?.determinism, variant.execute),
			"json.determinism must prove identical results across two runs",
		);
		if (variant.execute) {
			pushUnless(
				errors,
				mode?.execution?.sessionId === mode?.session?.sessionId,
				"json.execution.sessionId must match the recorded session evidence",
			);
			pushUnless(
				errors,
				mode?.execution?.finalText ===
					"Published package golden path completed with manifest evidence.",
				"json.execution.finalText must match the scenario final frame",
			);
			pushUnless(
				errors,
				isSha256(mode?.execution?.transcriptSha256) &&
					mode?.execution?.transcriptSha256 ===
						mode?.determinism?.transcriptSha256,
				"json.execution.transcriptSha256 must match the determinism evidence",
			);
			pushUnless(
				errors,
				specs.every((spec) =>
					(Array.isArray(mode?.execution?.toolExecutions)
						? mode.execution.toolExecutions
						: []
					).some(
						(entry) =>
							entry?.callId === spec.id &&
							entry?.tool === spec.name &&
							entry?.success === true,
					),
				),
				"json.execution.toolExecutions must record every tool call succeeding",
			);
		} else {
			pushUnless(
				errors,
				mode?.execution === undefined,
				"json.execution must be absent when execute evidence is skipped",
			);
		}
	}
	if (modeName === "junit") {
		pushUnless(
			errors,
			mode?.junit?.tests === assertionIds.length &&
				mode?.junit?.failures === 0,
			"junit.junit must record every assertion with zero failures",
		);
		pushUnless(
			errors,
			assertionIds.every((id) =>
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

function crossModeConsistencyIsValid(evidence, variant) {
	const modes = Array.isArray(evidence?.modes) ? evidence.modes : [];
	const jsonMode = modes.find((mode) => mode?.mode === "json");
	if (!isObject(jsonMode)) {
		return false;
	}
	if (
		JSON.stringify(canonicalJson(evidence?.replay?.determinism)) !==
		JSON.stringify(canonicalJson(jsonMode.determinism))
	) {
		return false;
	}
	if (
		variant.execute &&
		evidence?.replay?.determinism?.transcriptSha256 !==
			jsonMode?.execution?.transcriptSha256
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
		if (
			!isObject(transcriptMode) ||
			transcriptMode?.output?.sha256 !== mode?.output?.sha256 ||
			transcriptMode?.output?.bytes !== mode?.output?.bytes
		) {
			return false;
		}
		if (variant.execute) {
			return (
				transcriptMode?.session?.sessionId === mode?.session?.sessionId &&
				transcriptMode?.session?.sha256 === mode?.session?.sha256
			);
		}
		return (
			transcriptMode?.session?.status === "skipped" &&
			transcriptMode?.session?.reason === EXECUTE_SKIP_REASON
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

	const scenarioSha256 =
		typeof evidence?.replay?.scenario?.sha256 === "string"
			? evidence.replay.scenario.sha256
			: "";
	const variant = variantForScenarioSha(scenarioSha256);
	pushUnless(
		errors,
		variant !== null,
		"replay.scenario.sha256 must match a pinned published replay scenario variant",
	);
	const resolvedVariant = variant ?? { search: false, execute: false };
	const specs = toolSpecsForSearch(resolvedVariant.search);
	const assertionIds = assertionIdsForVariant(resolvedVariant);

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
		evidence?.replay?.runner ===
			(resolvedVariant.execute ? SCENARIO_RUNNER_EXECUTE : SCENARIO_RUNNER_OFFLINE),
		`replay.runner must match the scenario variant's execute capability`,
	);
	pushUnless(
		errors,
		resolvedVariant.execute
			? evidence?.replay?.execute?.status === "executed"
			: evidence?.replay?.execute?.status === "skipped" &&
				evidence?.replay?.execute?.reason === EXECUTE_SKIP_REASON,
		"replay.execute must record the execute leg as executed or explicitly skipped",
	);
	pushUnless(
		errors,
		evidence?.replay?.scenario?.id === SCENARIO_ID &&
			evidence?.replay?.scenario?.schemaVersion === SCRIPTED_SCENARIO_SCHEMA &&
			evidence?.replay?.scenario?.sha256 === scenarioSha256,
		"replay.scenario must reference the pinned published replay scenario",
	);
	pushUnless(
		errors,
		scenarioConfigIsValid(
			evidence?.replay?.scenarioConfig,
			scenarioSha256,
			resolvedVariant,
		),
		"replay.scenarioConfig must describe the deterministic scenario execution configuration",
	);
	pushUnless(
		errors,
		resolvedVariant.search
			? evidence?.replay?.searchTool?.status === "executed"
			: evidence?.replay?.searchTool?.status === "skipped" &&
				evidence?.replay?.searchTool?.reason === SEARCH_SKIP_REASON,
		"replay.searchTool must record the search leg as executed or explicitly skipped",
	);
	pushUnless(
		errors,
		determinismIsValid(evidence?.replay?.determinism, resolvedVariant.execute),
		"replay.determinism must prove identical results across two runs",
	);
	pushUnless(
		errors,
		crossModeConsistencyIsValid(evidence, resolvedVariant),
		"replay.determinism, json mode execution, and transcript sessions must be consistent",
	);
	pushUnless(
		errors,
		transcriptIsValid(evidence?.transcript, scenarioSha256, resolvedVariant),
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
		validateModeEvidence(errors, mode, scenarioSha256, resolvedVariant);
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
			scenarioSha256,
			resolvedVariant,
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
			scenarioSha256,
			resolvedVariant,
		),
		"observability.transcript must summarize transcript modes, tool calls, and final status",
	);
	pushUnless(
		errors,
		observability?.scenario?.id === SCENARIO_ID &&
			observability?.scenario?.sha256 === scenarioSha256 &&
			observability?.scenario?.observedOutcome === "pass" &&
			observability?.scenario?.failed === 0 &&
			observability?.scenario?.passed === assertionIds.length,
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
			assertionIds.every((id) =>
				stringArray(observability?.scenario?.evidenceRefs).includes(
					`scenario-assertion:${id}`,
				),
			),
		"observability.scenario must surface audit event and assertion evidence",
	);
	pushUnless(
		errors,
		resolvedVariant.execute
			? countModesWith(observability?.sessions?.modes, REQUIRED_REPLAY_MODES) ===
					REQUIRED_REPLAY_MODES.length &&
				Number.isFinite(observability?.sessions?.jsonlFileCount) &&
				observability.sessions.jsonlFileCount >= REQUIRED_REPLAY_MODES.length &&
				REQUIRED_REPLAY_MODES.every(
					(mode) =>
						typeof observability?.sessions?.sha256ByMode?.[mode] === "string" &&
						observability.sessions.sha256ByMode[mode].length === 64,
				)
			: observability?.sessions?.skipped?.reason === EXECUTE_SKIP_REASON &&
				Array.isArray(observability?.sessions?.modes) &&
				observability.sessions.modes.length === 0 &&
				observability?.sessions?.jsonlFileCount === 0,
		"observability.sessions must record a session JSONL for every replay mode, or an explicit execute skip",
	);
	pushUnless(
		errors,
		specs.every(
			(spec) => observability?.tools?.names?.includes?.(spec.name) === true,
		),
		"observability.tools.names must include every executed tool",
	);
	for (const spec of specs) {
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
		resolvedVariant.execute
			? countModesWith(
						observability?.agentRuntimeLedger?.modes,
						REQUIRED_REPLAY_MODES,
					) === REQUIRED_REPLAY_MODES.length &&
				countModesWith(
					observability?.agentRuntimeLedger?.replayDeterministicModes,
					REQUIRED_REPLAY_MODES,
				) === REQUIRED_REPLAY_MODES.length &&
				countModesWith(
					observability?.agentRuntimeLedger?.durabilityModes,
					REQUIRED_REPLAY_MODES,
				) === REQUIRED_REPLAY_MODES.length &&
				observability?.agentRuntimeLedger?.completionGate ===
					AGENT_RUNTIME_COMPLETION_GATE &&
				specs.every((spec) =>
					stringArray(observability?.agentRuntimeLedger?.toolCallIds).includes(
						spec.id,
					),
				)
			: observability?.agentRuntimeLedger?.skipped?.reason ===
				EXECUTE_SKIP_REASON,
		"observability.agentRuntimeLedger must summarize completion-gated ledger evidence for every replay mode, or an explicit execute skip",
	);
	pushUnless(
		errors,
		queryableObservabilityIndexIsValid({ observability, variant: resolvedVariant }),
		"observability.queryIndex must provide queryable install, session, scenario, tool, error, inspection, and final-status traces with release query descriptors",
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
