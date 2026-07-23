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
const AGENT_RUNTIME_LIFECYCLE_SCHEMA =
	"evalops.maestro.agent-runtime-lifecycle.v1";
const REQUIRED_INSTALLERS = ["npm"];
const REQUIRED_REPLAY_MODES = ["json", "rpc", "text"];
const REQUIRED_RELEASE_GATE_CHECKS = [
	"installablePackageMetadata",
	"noForbiddenWorkspaceReferences",
	"noWorkspaceProtocolReferences",
	"providerConfig",
	"requiredReplayModes",
	"transcriptEvidence",
	"sessionEvidence",
	"toolEvidence",
	"toolExecutionEvidence",
	"searchRipgrepEvidence",
	"approvalTraceEvidence",
	"errorTraceEvidence",
	"artifactTraceEvidence",
	"queryableObservabilityIndex",
	"agentRuntimeLedger",
	"agentRuntimeLifecycle",
	"finalStatus",
];
const REQUIRED_AGENT_RUNTIME_WAIT_KINDS = ["approval", "tool_retry"];
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
	{ id: TOOL_CALL_ID, name: "read" },
	{ id: SEARCH_TOOL_CALL_ID, name: "search" },
	{ id: WRITE_TOOL_CALL_ID, name: "write" },
];
const ARTIFACT_PATH = "published-replay-artifact.json";
const SCRIPTED_REPLAY_PROVIDER = "scripted-replay";
const SCRIPTED_REPLAY_MODEL = "maestro-replay-v1";
const SCRIPTED_REPLAY_TOOL_ALLOWLIST = ["read", "search", "write"];
const SCRIPTED_REPLAY_APPROVAL_MODE = "auto";
const EXPECTED_PROMPT_LENGTH = 41;
const EXPECTED_PROMPT_SHA256 =
	"db296f4e8a050ac9e968523b0202171fca61524406900bbe534ae876ed506570";
const PUBLISHED_REPLAY_EVIDENCE_REF_PREFIXES = [
	"tool-call:",
	"tool-execution:",
	"approval-request:",
	"pending-request:",
	"artifact:",
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

function filterPublishedReplayEvidenceRefs(refs) {
	return stringArray(refs).filter((ref) =>
		PUBLISHED_REPLAY_EVIDENCE_REF_PREFIXES.some((prefix) =>
			ref.startsWith(prefix),
		),
	);
}

function toolWorkItemsForMode(mode) {
	const ledger = isObject(mode?.agentRuntimeLedger)
		? mode.agentRuntimeLedger
		: {};
	if (Array.isArray(ledger.toolWorkItems)) {
		return ledger.toolWorkItems.filter(isObject);
	}
	return isObject(ledger.toolWorkItem) ? [ledger.toolWorkItem] : [];
}

function runStepsForMode(mode) {
	const ledger = isObject(mode?.agentRuntimeLedger)
		? mode.agentRuntimeLedger
		: {};
	return Array.isArray(ledger.runSteps) ? ledger.runSteps.filter(isObject) : [];
}

function evidenceRefsForMode(mode) {
	return toolWorkItemsForMode(mode).flatMap((item) =>
		filterPublishedReplayEvidenceRefs(item?.evidenceRefs),
	);
}

function toolWorkItemForMode(mode, { toolName, toolCallId }) {
	return toolWorkItemsForMode(mode).find(
		(item) =>
			item?.toolName === toolName &&
			(!toolCallId ||
				item?.toolCallId === toolCallId ||
				filterPublishedReplayEvidenceRefs(item?.evidenceRefs).includes(
					`tool-call:${toolCallId}`,
				)),
	);
}

function toolExecutionRefsForWorkItem(workItem) {
	return filterPublishedReplayEvidenceRefs(workItem?.evidenceRefs).filter((ref) =>
		ref.startsWith("tool-execution:"),
	);
}

function toolExecutionCoverageIsValid({ observability, modes }) {
	const refsByCallId = isObject(observability?.tools?.toolExecutionRefsByCallId)
		? observability.tools.toolExecutionRefsByCallId
		: {};
	const modesByCallId = isObject(
		observability?.tools?.toolExecutionModesByCallId,
	)
		? observability.tools.toolExecutionModesByCallId
		: {};
	const allExecutionRefs = stringArray(observability?.tools?.toolExecutionRefs);

	return REQUIRED_TOOL_EXECUTION_SPECS.every((toolSpec) => {
		const declaredRefs = stringArray(refsByCallId[toolSpec.id]);
		const declaredModes = stringArray(modesByCallId[toolSpec.id]);
		const actualRefs = new Set();
		const modeCoverage =
			Array.isArray(modes) &&
			modes.length > 0 &&
			modes.every((mode) => {
				const workItem = toolWorkItemForMode(mode, {
					toolName: toolSpec.name,
					toolCallId: toolSpec.id,
				});
				const refs = toolExecutionRefsForWorkItem(workItem);
				for (const ref of refs) {
					actualRefs.add(ref);
				}
				return refs.length > 0;
			});
		const declaredRefsMatchWorkItems =
			declaredRefs.length === actualRefs.size &&
			declaredRefs.every((ref) => actualRefs.has(ref));
		return (
			declaredRefs.length > 0 &&
			declaredRefs.every((ref) => ref.startsWith("tool-execution:")) &&
			declaredRefs.every((ref) => allExecutionRefs.includes(ref)) &&
			declaredRefsMatchWorkItems &&
			countModesWith(declaredModes, REQUIRED_REPLAY_MODES) ===
				REQUIRED_REPLAY_MODES.length &&
			modeCoverage
		);
	});
}

function agentRuntimeRunStepsAreValid(mode) {
	const steps = runStepsForMode(mode);
	if (steps.length === 0) {
		return false;
	}
	const stepIds = new Set();
	for (const step of steps) {
		if (
			typeof step.stepId !== "string" ||
			typeof step.ledgerEntryId !== "string" ||
			typeof step.kind !== "string" ||
			typeof step.state !== "string" ||
			typeof step.title !== "string"
		) {
			return false;
		}
		stepIds.add(step.stepId);
	}
	return stepIds.size === steps.length;
}

function modesWithEvidenceRefPrefix(modes, prefix) {
	const result = new Set();
	for (const mode of modes) {
		const modeName = typeof mode?.mode === "string" ? mode.mode : "";
		if (
			modeName &&
			evidenceRefsForMode(mode).some((ref) => ref.startsWith(prefix))
		) {
			result.add(modeName);
		}
	}
	return sortedStrings(Array.from(result));
}

function terminalOutcomesAreValid(outcomes) {
	const terminalStates = isObject(outcomes?.terminalStates)
		? Object.entries(outcomes.terminalStates)
		: [];
	const terminalEventTypes = stringArray(outcomes?.terminalEventTypes);
	return (
		terminalStates.some(
			([state, count]) =>
				TERMINAL_AGENT_RUNTIME_STATES.has(state) &&
				typeof count === "number" &&
				Number.isFinite(count) &&
				count > 0,
		) && terminalEventTypes.some((eventType) => eventType.length > 0)
	);
}

function waitHasOwnPendingRequestEvidence(wait) {
	return (
		typeof wait?.pendingRequestId === "string" &&
		stringArray(wait?.evidenceRefs).includes(
			`pending-request:${wait.pendingRequestId}`,
		)
	);
}

function agentRuntimeLifecycleIsValid(lifecycle) {
	const waits = Array.isArray(lifecycle?.waits)
		? lifecycle.waits.filter(isObject)
		: [];
	const waitKindsFromRecords = new Set(
		waits
			.map((wait) => wait?.pendingRequestKind)
			.filter((kind) => typeof kind === "string"),
	);
	const evidenceRefs = stringArray(lifecycle?.evidenceRefs);
	const waitEvidenceRefs = waits.flatMap((wait) =>
		stringArray(wait?.evidenceRefs),
	);
	const allEvidenceRefs = [...evidenceRefs, ...waitEvidenceRefs];
	const waitsHaveRequiredRecords = REQUIRED_AGENT_RUNTIME_WAIT_KINDS.every(
		(kind) =>
			waits.some(
					(wait) =>
						wait.pendingRequestKind === kind &&
						typeof wait.pendingRequestId === "string" &&
						typeof wait.waitType === "string" &&
						waitHasOwnPendingRequestEvidence(wait),
				),
	);
	return (
		isObject(lifecycle) &&
		lifecycle.schemaVersion === AGENT_RUNTIME_LIFECYCLE_SCHEMA &&
		typeof lifecycle.sessionId === "string" &&
		lifecycle.sessionId.length > 0 &&
		lifecycle.replayDeterministic === true &&
		REQUIRED_AGENT_RUNTIME_WAIT_KINDS.every((kind) =>
			waitKindsFromRecords.has(kind),
		) &&
		waitsHaveRequiredRecords &&
		Number.isFinite(lifecycle?.counts?.waits) &&
		lifecycle.counts.waits >= REQUIRED_AGENT_RUNTIME_WAIT_KINDS.length &&
		Number.isFinite(lifecycle?.counts?.approvalWaits) &&
		lifecycle.counts.approvalWaits > 0 &&
		Number.isFinite(lifecycle?.counts?.toolRetryWaits) &&
		lifecycle.counts.toolRetryWaits > 0 &&
		Number.isFinite(lifecycle?.counts?.terminalOperations) &&
		lifecycle.counts.terminalOperations > 0 &&
		terminalOutcomesAreValid(lifecycle?.outcomes) &&
		Number.isFinite(lifecycle?.operations?.waitRun) &&
		lifecycle.operations.waitRun >= REQUIRED_AGENT_RUNTIME_WAIT_KINDS.length &&
		Number.isFinite(lifecycle?.operations?.recordRunStep) &&
		lifecycle.operations.recordRunStep > 0 &&
		Number.isFinite(lifecycle?.operations?.recordRunWorkItem) &&
		lifecycle.operations.recordRunWorkItem > 0 &&
		Number.isFinite(lifecycle?.operations?.completeRun) &&
		lifecycle.operations.completeRun > 0 &&
		lifecycle?.durability?.reconstructable === true &&
		lifecycle?.durability?.replayDeterministic === true &&
		typeof lifecycle?.durability?.promotionIdempotencyKey === "string" &&
		waits.every(
			(wait) =>
					typeof wait.pendingRequestId === "string" &&
					typeof wait.pendingRequestKind === "string" &&
					typeof wait.waitType === "string" &&
					waitHasOwnPendingRequestEvidence(wait),
			) &&
			allEvidenceRefs.some((ref) => ref.startsWith("pending-request:"))
	);
}

function observabilityCoverageModes({ section, modes, prefix }) {
	const declaredModes = stringArray(section?.modes);
	if (declaredModes.length > 0) {
		return declaredModes;
	}

	const inferredModes = modesWithEvidenceRefPrefix(modes, prefix);
	if (inferredModes.length > 0) {
		return inferredModes;
	}

	return Number.isFinite(section?.count) &&
		section.count >= REQUIRED_REPLAY_MODES.length
		? REQUIRED_REPLAY_MODES
		: [];
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

function queryableObservabilityIndexIsValid({ observability, modes }) {
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
	const sessionEntry = queryIndexEntryForTrace(queryIndex, "session");
	const toolEntry = queryIndexEntryForTrace(queryIndex, "tool");
	const searchEntry = queryIndexEntryForTrace(queryIndex, "search");
	const approvalEntry = queryIndexEntryForTrace(queryIndex, "approval");
	const errorEntry = queryIndexEntryForTrace(queryIndex, "error");
	const artifactEntry = queryIndexEntryForTrace(queryIndex, "artifact");
	const lifecycleEntry = queryIndexEntryForTrace(
		queryIndex,
		"agent-runtime-lifecycle",
	);
	const finalStatusEntry = queryIndexEntryForTrace(queryIndex, "final-status");
	const toolRefs = stringArray(toolEntry?.evidenceRefs);
	const searchRefs = stringArray(searchEntry?.evidenceRefs);
	const approvalRefs = stringArray(approvalEntry?.evidenceRefs);
	const artifactRefs = stringArray(artifactEntry?.evidenceRefs);
	const lifecycleRefs = stringArray(lifecycleEntry?.evidenceRefs);

	return (
		isObject(installEntry?.counts) &&
		installEntry.counts.forbiddenReferences === 0 &&
		installEntry.counts.workspaceProtocolReferences === 0 &&
		queryIndexEntryHasRequiredModes(sessionEntry) &&
		Number.isFinite(sessionEntry?.counts?.jsonlFileCount) &&
		sessionEntry.counts.jsonlFileCount >= REQUIRED_REPLAY_MODES.length &&
		queryIndexEntryHasRequiredModes(toolEntry) &&
		[TOOL_CALL_ID, SEARCH_TOOL_CALL_ID, WRITE_TOOL_CALL_ID].every((id) =>
			stringArray(toolEntry?.ids).includes(id),
		) &&
		[TOOL_CALL_ID, SEARCH_TOOL_CALL_ID, WRITE_TOOL_CALL_ID].every((id) =>
			toolRefs.includes(`tool-call:${id}`),
		) &&
		toolExecutionCoverageIsValid({ observability, modes }) &&
		queryIndexEntryHasRequiredModes(searchEntry) &&
		stringArray(searchEntry?.ids).includes(SEARCH_TOOL_CALL_ID) &&
		searchRefs.includes(`tool-call:${SEARCH_TOOL_CALL_ID}`) &&
		queryIndexEntryHasRequiredModes(approvalEntry) &&
		approvalRefs.length > 0 &&
		approvalRefs.every((ref) => ref.startsWith("approval-request:")) &&
		errorEntry?.counts?.count === 0 &&
		errorEntry?.counts?.expectedCount === 0 &&
		queryIndexEntryHasRequiredModes(artifactEntry) &&
		artifactRefs.length > 0 &&
		artifactRefs.every((ref) => ref.startsWith("artifact:")) &&
		lifecycleEntry?.status === "ok" &&
		lifecycleRefs.some((ref) => ref.startsWith("pending-request:")) &&
		agentRuntimeLifecycleIsValid(observability?.agentRuntimeLifecycle) &&
		queryIndexEntryHasRequiredModes(finalStatusEntry) &&
		finalStatusEntry?.counts?.ok === REQUIRED_REPLAY_MODES.length &&
		countModesWith(modes.map((mode) => mode?.mode), REQUIRED_REPLAY_MODES) ===
			REQUIRED_REPLAY_MODES.length
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

function providerConfigIsValid(providerConfig) {
	return (
		isObject(providerConfig) &&
		providerConfig.provider === SCRIPTED_REPLAY_PROVIDER &&
		providerConfig.model === SCRIPTED_REPLAY_MODEL &&
		providerConfig.deterministic === true &&
		providerConfig.externalCredentialsRequired === false &&
		providerConfig.externalNetworkRequired === false &&
		providerConfig.approvalMode === SCRIPTED_REPLAY_APPROVAL_MODE &&
		typeof providerConfig.sandboxMode === "string" &&
		providerConfig.sandboxMode.length > 0 &&
		isObject(providerConfig.prompt) &&
		providerConfig.prompt.length === EXPECTED_PROMPT_LENGTH &&
		providerConfig.prompt.sha256 === EXPECTED_PROMPT_SHA256 &&
		SCRIPTED_REPLAY_TOOL_ALLOWLIST.every((toolName) =>
			stringArray(providerConfig.toolAllowlist).includes(toolName),
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

function providerConfigsMatch(left, right) {
	return (
		isObject(left) &&
		isObject(right) &&
		JSON.stringify(canonicalJson(left)) ===
			JSON.stringify(canonicalJson(right))
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

function transcriptIsValid(transcript) {
	if (
		!isObject(transcript) ||
		transcript.schemaVersion !== TRANSCRIPT_SCHEMA ||
		!transcriptCoversRequiredModes(transcript)
	) {
		return false;
	}
	const promptSha256 =
		typeof transcript?.prompt?.sha256 === "string"
			? transcript.prompt.sha256
			: "";
	const coverageModes = stringArray(transcript?.coverage?.modes);
	const coverageToolCallIds = stringArray(transcript?.coverage?.toolCallIds);
	if (
		transcript?.prompt?.length !== EXPECTED_PROMPT_LENGTH ||
		promptSha256 !== EXPECTED_PROMPT_SHA256 ||
		countModesWith(coverageModes, REQUIRED_REPLAY_MODES) !==
			REQUIRED_REPLAY_MODES.length ||
		!coverageToolCallIds.includes(TOOL_CALL_ID) ||
		!coverageToolCallIds.includes(SEARCH_TOOL_CALL_ID) ||
		!coverageToolCallIds.includes(WRITE_TOOL_CALL_ID) ||
		transcript?.coverage?.finalStatus?.ok !== REQUIRED_REPLAY_MODES.length
	) {
		return false;
	}
	return REQUIRED_REPLAY_MODES.every((modeName) => {
		const mode = transcriptModeEntry(transcript, modeName);
		const readTool = transcriptToolCall(mode, TOOL_CALL_ID);
		const searchTool = transcriptToolCall(mode, SEARCH_TOOL_CALL_ID);
		const writeTool = transcriptToolCall(mode, WRITE_TOOL_CALL_ID);
		return (
			isObject(mode) &&
			mode.provider === SCRIPTED_REPLAY_PROVIDER &&
			mode.promptSha256 === promptSha256 &&
			readTool?.name === "read" &&
			readTool?.inputPath === "package.json" &&
			readTool?.resultStatus === "success" &&
			searchTool?.name === "search" &&
			searchTool?.inputPath === "package.json" &&
			searchTool?.resultStatus === "success" &&
			writeTool?.name === "write" &&
			writeTool?.inputPath === ARTIFACT_PATH &&
			writeTool?.resultStatus === "success" &&
			mode?.final?.status === "ok" &&
			mode?.final?.containsExpectedText === true &&
			Number.isFinite(mode?.session?.jsonlFileCount) &&
			mode.session.jsonlFileCount > 0
		);
	});
}

function transcriptObservabilityIsValid(observabilityTranscript) {
	return (
		isObject(observabilityTranscript) &&
		observabilityTranscript.schemaVersion === TRANSCRIPT_SCHEMA &&
		observabilityTranscript.promptSha256 === EXPECTED_PROMPT_SHA256 &&
		countModesWith(observabilityTranscript.modes, REQUIRED_REPLAY_MODES) ===
			REQUIRED_REPLAY_MODES.length &&
		stringArray(observabilityTranscript.toolCallIds).includes(TOOL_CALL_ID) &&
		stringArray(observabilityTranscript.toolCallIds).includes(
			SEARCH_TOOL_CALL_ID,
		) &&
		stringArray(observabilityTranscript.toolCallIds).includes(
			WRITE_TOOL_CALL_ID,
		) &&
		observabilityTranscript?.finalStatus?.ok === REQUIRED_REPLAY_MODES.length
	);
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
		evidence?.replay?.provider === SCRIPTED_REPLAY_PROVIDER,
		"replay.provider must be scripted-replay",
	);
	pushUnless(
		errors,
		providerConfigIsValid(evidence?.replay?.providerConfig),
		"replay.providerConfig must describe scripted replay provider configuration",
	);
	pushUnless(
		errors,
		transcriptIsValid(evidence?.transcript),
		"transcript must include queryable published replay transcript evidence for text, json, and rpc",
	);
	const providerPrompt = isObject(evidence?.replay?.providerConfig?.prompt)
		? evidence.replay.providerConfig.prompt
		: {};
	const transcriptPrompt = isObject(evidence?.transcript?.prompt)
		? evidence.transcript.prompt
		: {};
	pushUnless(
		errors,
		providerPrompt.sha256 === transcriptPrompt.sha256 &&
			providerPrompt.length === transcriptPrompt.length,
		"replay.providerConfig.prompt must match transcript.prompt",
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
		pushUnless(
			errors,
			mode?.searchTool?.name === "search",
			`${modeName}.searchTool.name must be search`,
		);
		pushUnless(
			errors,
			mode?.searchTool?.callId === SEARCH_TOOL_CALL_ID,
			`${modeName}.searchTool.callId must be ${SEARCH_TOOL_CALL_ID}`,
		);
		pushUnless(
			errors,
			mode?.searchTool?.inputPath === "package.json",
			`${modeName}.searchTool.inputPath must be package.json`,
		);
		pushUnless(
			errors,
			mode?.searchTool?.resultStatus === "success",
			`${modeName}.searchTool.resultStatus must be success`,
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
			mode?.session?.containsSearchToolCallId === true,
			`${modeName}.session.containsSearchToolCallId must be true`,
		);
		pushUnless(
			errors,
			mode?.session?.containsWriteToolCallId === true,
			`${modeName}.session.containsWriteToolCallId must be true`,
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
		"observability.replay.modes must include text, json, and rpc",
	);
	pushUnless(
		errors,
		providerConfigIsValid(observability?.providerConfig) &&
			providerConfigsMatch(
				observability?.providerConfig,
				evidence?.replay?.providerConfig,
			),
		"observability.providerConfig must mirror replay.providerConfig",
	);
	pushUnless(
		errors,
		transcriptObservabilityIsValid(observability?.transcript),
		"observability.transcript must summarize transcript modes, tool calls, and final status",
	);
	pushUnless(
		errors,
		observability?.transcript?.promptSha256 === evidence?.transcript?.prompt?.sha256,
		"observability.transcript.promptSha256 must match transcript.prompt.sha256",
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
		observability?.tools?.names?.includes?.("search") === true,
		"observability.tools.names must include search",
	);
	pushUnless(
		errors,
		observability?.tools?.names?.includes?.("write") === true,
		"observability.tools.names must include write",
	);
	pushUnless(
		errors,
		observability?.tools?.callIds?.includes?.(TOOL_CALL_ID) === true,
		`observability.tools.callIds must include ${TOOL_CALL_ID}`,
	);
	pushUnless(
		errors,
		observability?.tools?.callIds?.includes?.(SEARCH_TOOL_CALL_ID) === true,
		`observability.tools.callIds must include ${SEARCH_TOOL_CALL_ID}`,
	);
	pushUnless(
		errors,
		observability?.tools?.callIds?.includes?.(WRITE_TOOL_CALL_ID) === true,
		`observability.tools.callIds must include ${WRITE_TOOL_CALL_ID}`,
	);
	pushUnless(
		errors,
		toolExecutionCoverageIsValid({ observability, modes }),
		"observability.tools must include ToolExecution evidence for read, search, and write in every replay mode",
	);
	pushUnless(
		errors,
		observability?.search?.engine === "ripgrep" &&
			observability.search.toolName === "search" &&
			observability.search.callId === SEARCH_TOOL_CALL_ID &&
			observability.search.inputPath === "package.json" &&
			countModesWith(observability.search.modes, REQUIRED_REPLAY_MODES) ===
				REQUIRED_REPLAY_MODES.length &&
			stringArray(observability.search.evidenceRefs).includes(
				`tool-call:${SEARCH_TOOL_CALL_ID}`,
			),
		"observability.search must include ripgrep search evidence for every replay mode",
	);
	pushUnless(
		errors,
		agentRuntimeLifecycleIsValid(evidence?.agentRuntimeLifecycle),
		"agentRuntimeLifecycle must include approval waits, tool_retry waits, and terminal outcome evidence",
	);
	pushUnless(
		errors,
		agentRuntimeLifecycleIsValid(observability?.agentRuntimeLifecycle),
		"observability.agentRuntimeLifecycle must summarize approval waits, tool_retry waits, and terminal outcomes",
	);
	const approvalRefs = stringArray(observability?.approvals?.evidenceRefs);
	const approvalModes = observabilityCoverageModes({
		section: observability?.approvals,
		modes,
		prefix: "approval-request:",
	});
	pushUnless(
		errors,
		countModesWith(approvalModes, REQUIRED_REPLAY_MODES) ===
			REQUIRED_REPLAY_MODES.length &&
			approvalRefs.length > 0 &&
			approvalRefs.every((ref) => ref.startsWith("approval-request:")),
		"observability.approvals must include approval-request evidence for every replay mode",
	);
	const artifactRefs = stringArray(observability?.artifacts?.evidenceRefs);
	const artifactModes = observabilityCoverageModes({
		section: observability?.artifacts,
		modes,
		prefix: "artifact:",
	});
	pushUnless(
		errors,
		countModesWith(artifactModes, REQUIRED_REPLAY_MODES) ===
			REQUIRED_REPLAY_MODES.length &&
			artifactRefs.length > 0 &&
			artifactRefs.every((ref) => ref.startsWith("artifact:")),
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
	pushUnless(
		errors,
		countModesWith(
			observability?.agentRuntimeLedger?.runStepModes,
			REQUIRED_REPLAY_MODES,
		) === REQUIRED_REPLAY_MODES.length &&
			modes.every(agentRuntimeRunStepsAreValid),
		"observability.agentRuntimeLedger.runStepModes and mode agentRuntimeLedger.runSteps must include AgentRuntime run-step records for text, json, and rpc",
	);
	pushUnless(
		errors,
		queryableObservabilityIndexIsValid({ observability, modes }),
		"observability.queryIndex must provide queryable install, session, tool, approval, error, artifact, and final-status traces with release query descriptors",
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
