#!/usr/bin/env node
// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getNpmCommand,
	installedBinPath,
	readInstalledPackageJson,
	runInstalledCliSmoke,
	summarizeInstallablePackageMetadata,
} from "./install-smoke-utils.js";
import { getPackageMetadata } from "./package-metadata.js";
import { getRuntimeWorkspaceNames } from "./runtime-workspaces.mjs";
import { loadRootPackage } from "./workspace-utils.js";
import { assertPublishedReplayReleaseGate } from "./published-replay-evidence-gate.js";
import {
	REQUIRED_OBSERVABILITY_QUERY_TRACES,
	releaseObservabilityQueryDescriptor,
	releaseObservabilityQueryDescriptorIsValid,
} from "./release-observability-query-contract.js";

export { assertPublishedReplayReleaseGate };

const SCRIPTED_SCENARIO_SCHEMA = "evalops.maestro.scripted-scenario.v1";
const SCRIPTED_SCENARIO_RESULT_SCHEMA =
	"evalops.maestro.scripted-scenario-result.v1";
const PUBLISHED_REPLAY_EVIDENCE_SCHEMA =
	"evalops.maestro.published-replay-evidence.v1";
const PUBLISHED_REPLAY_TRANSCRIPT_SCHEMA =
	"evalops.maestro.published-replay-transcript.v1";
const AGENT_RUNTIME_LEDGER_SCHEMA = "evalops.maestro.agent-runtime-ledger.v1";
const AGENT_RUNTIME_COMPLETION_GATE = "maestro_agent_runtime_ledger_recorded";
const SCENARIO_ID = "maestro-published-replay";
const AUDIT_EVENT_TYPE = "maestro.scenario.replay.ready";
const SCRIPTED_REPLAY_TOOL_ALLOWLIST = ["read", "search", "write"];
const SCRIPTED_REPLAY_APPROVAL_MODE = "auto";
const FINAL_TEXT =
	"Published package golden path completed with manifest evidence.";
const TOOL_CALL_ID = "call-read-package-json";
const SEARCH_TOOL_CALL_ID = "call-search-package-manifest";
const WRITE_TOOL_CALL_ID = "call-write-published-artifact";
const REQUIRED_TOOL_EXECUTION_SPECS = [
	{ id: TOOL_CALL_ID, name: "read", inputPath: "package.json" },
	{ id: SEARCH_TOOL_CALL_ID, name: "search", inputPath: "package.json" },
	{ id: WRITE_TOOL_CALL_ID, name: "write", inputPath: "published-replay-artifact.json" },
];
const ARTIFACT_PATH = "published-replay-artifact.json";
const ARTIFACT_TEXT = JSON.stringify({
	source: "smoke-published-replay-e2e",
	manifest: "package.json",
});
const SEARCH_PATTERN = "maestro-published";
const REQUIRED_REPLAY_MODES = ["text", "json", "junit"];
const REQUIRED_ASSERTION_IDS = [
	"read-tool-called",
	"search-tool-called",
	"write-artifact-tool-called",
	"manifest-exists",
	"manifest-contains-search-pattern",
	"bash-tool-not-called",
	"audit-event-tagged",
];
const DETERMINISM_RUNS = 2;
const TERMINAL_AGENT_RUNTIME_STATES = new Set([
	"succeeded",
	"failed",
	"cancelled",
	"canceled",
]);
const PUBLISHED_REPLAY_EVIDENCE_REF_PREFIXES = [
	"tool-call:",
	"scenario-assertion:",
	"audit-event:",
	"inspection-session:",
];
const timeoutMs = Number.parseInt(
	process.env.MAESTRO_PUBLISHED_REPLAY_E2E_TIMEOUT_MS ?? "45000",
	10,
);
const replaySandboxModes = [
	"read-only",
	"workspace-write",
	"danger-full-access",
	"native",
	"docker",
	"local",
	"none",
];
// The native `maestro scenario run` surface has no sandbox flag; the release
// workflow still exports MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE, so keep
// validating it and record it as informational metadata in the evidence.
const replaySandboxMode =
	process.env.MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE?.trim() ||
	"workspace-write";

function fail(message, details) {
	console.error(message);
	if (details) {
		console.error(details);
	}
	process.exit(1);
}

if (!replaySandboxModes.includes(replaySandboxMode)) {
	fail(
		`Invalid MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE: "${replaySandboxMode}"`,
		`Allowed values: ${replaySandboxModes.join(", ")}`,
	);
}

function parseArgs(argv) {
	/** @type {{packageName: string; version: string; cliCommand: string; installRoot: string; evidencePath: string; evidenceDir: string; installer: string}} */
	const options = {
		packageName: "",
		version: "",
		cliCommand: "",
		installRoot: "",
		evidencePath: "",
		evidenceDir: "",
		installer: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--package":
				options.packageName = argv[++index] ?? "";
				break;
			case "--version":
				options.version = argv[++index] ?? "";
				break;
			case "--cli-command":
				options.cliCommand = argv[++index] ?? "";
				break;
			case "--install-root":
				options.installRoot = argv[++index] ?? "";
				break;
			case "--evidence-path":
				options.evidencePath = argv[++index] ?? "";
				break;
			case "--evidence-dir":
				options.evidenceDir = argv[++index] ?? "";
				break;
			case "--installer":
				options.installer = argv[++index] ?? "";
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function countBy(values) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const value of values) {
		const key = typeof value === "string" && value ? value : "unknown";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

function uniqueValues(values) {
	const seen = new Set();
	const result = [];
	for (const value of values) {
		if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
			continue;
		}
		seen.add(value);
		result.push(value);
	}
	return result;
}

function includesRequiredModes(values) {
	const set = new Set(Array.isArray(values) ? values : []);
	return REQUIRED_REPLAY_MODES.every((mode) => set.has(mode));
}

function cloneJson(value) {
	return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
	if (Array.isArray(value)) {
		return value.map(canonicalJson);
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalJson(entry)]),
	);
}

function inferPublishedInstaller({ installer, installMetadata }) {
	const normalizedInstaller =
		typeof installer === "string" ? installer.trim().toLowerCase() : "";
	if (normalizedInstaller) {
		return normalizedInstaller;
	}
	const label =
		typeof installMetadata?.label === "string" ? installMetadata.label : "";
	if (/\bvia npm\b/.test(label)) {
		return "npm";
	}
	return "local";
}

function installLabelForInstaller({ packageSpec, installer }) {
	const normalizedInstaller =
		typeof installer === "string" ? installer.trim().toLowerCase() : "";
	const suffix = normalizedInstaller === "npm" ? "via npm" : "published replay install";
	return `${packageSpec} ${suffix}`;
}

export function registryInstallPlanForInstaller({ installer, packageSpec }) {
	const normalizedInstaller =
		typeof installer === "string" ? installer.trim().toLowerCase() : "";
	switch (normalizedInstaller || "npm") {
		case "npm":
			return {
				installer: "npm",
				command: getNpmCommand(),
				initArgs: ["init", "-y"],
				installArgs: ["install", packageSpec],
				tempPrefix: "maestro-published-replay-install-",
			};
		default:
			throw new Error(
				`Unsupported published replay installer "${installer}". Use npm or pass --install-root for a preinstalled package.`,
			);
	}
}

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modeName(modeEvidence) {
	return typeof modeEvidence?.mode === "string" ? modeEvidence.mode : "unknown";
}

function filterPublishedReplayEvidenceRefs(refs) {
	return Array.isArray(refs)
		? refs.filter(
				(ref) =>
					typeof ref === "string" &&
					PUBLISHED_REPLAY_EVIDENCE_REF_PREFIXES.some((prefix) =>
						ref.startsWith(prefix),
					),
			)
		: [];
}

function toolSpecByCallId(callId) {
	return REQUIRED_TOOL_EXECUTION_SPECS.find((spec) => spec.id === callId);
}

function toolEvidenceForMode(modeEvidence) {
	return [modeEvidence?.tool, modeEvidence?.searchTool, modeEvidence?.artifactTool]
		.filter((tool) => tool && typeof tool === "object");
}

function scenarioConfigSatisfiesReleaseGate(scenarioConfig) {
	return (
		scenarioConfig?.scenarioSchemaVersion === SCRIPTED_SCENARIO_SCHEMA &&
		scenarioConfig?.scenarioId === SCENARIO_ID &&
		typeof scenarioConfig?.scenarioSha256 === "string" &&
		scenarioConfig.scenarioSha256.length === 64 &&
		scenarioConfig?.deterministic === true &&
		scenarioConfig?.externalCredentialsRequired === false &&
		scenarioConfig?.externalNetworkRequired === false &&
		Array.isArray(scenarioConfig?.toolAllowlist) &&
		SCRIPTED_REPLAY_TOOL_ALLOWLIST.every((toolName) =>
			scenarioConfig.toolAllowlist.includes(toolName),
		) &&
		scenarioConfig?.approvalMode === SCRIPTED_REPLAY_APPROVAL_MODE &&
		typeof scenarioConfig?.sandboxMode === "string" &&
		scenarioConfig.sandboxMode.length > 0
	);
}

function transcriptSatisfiesReleaseGate(transcript, scenarioSha256) {
	if (
		transcript?.schemaVersion !== PUBLISHED_REPLAY_TRANSCRIPT_SCHEMA ||
		transcript?.scenario?.sha256 !== scenarioSha256 ||
		!Array.isArray(transcript?.modes)
	) {
		return false;
	}
	const modeSet = new Set(transcript.modes.map((mode) => mode?.mode));
	const coverageModeSet = new Set(transcript?.coverage?.modes ?? []);
	const coverageToolCallIds = new Set(transcript?.coverage?.toolCallIds ?? []);
	if (
		!REQUIRED_REPLAY_MODES.every(
			(mode) => modeSet.has(mode) && coverageModeSet.has(mode),
		) ||
		REQUIRED_TOOL_EXECUTION_SPECS.some(
			(spec) => !coverageToolCallIds.has(spec.id),
		) ||
		transcript?.coverage?.finalStatus?.ok !== transcript.modes.length
	) {
		return false;
	}
	return transcript.modes.every((mode) => {
		const toolCalls = Array.isArray(mode?.toolCalls) ? mode.toolCalls : [];
		return (
			REQUIRED_REPLAY_MODES.includes(mode?.mode) &&
			mode?.scenarioSha256 === scenarioSha256 &&
			REQUIRED_TOOL_EXECUTION_SPECS.every((spec) => {
				const toolCall = toolCalls.find((entry) => entry?.id === spec.id);
				return (
					toolCall?.name === spec.name &&
					toolCall?.inputPath === spec.inputPath &&
					toolCall?.resultStatus === "success"
				);
			}) &&
			mode?.final?.status === "ok" &&
			mode?.final?.containsExpectedText === true &&
			typeof mode?.output?.sha256 === "string" &&
			mode.output.sha256.length === 64 &&
			finiteNumber(mode?.output?.bytes) > 0
		);
	});
}

function buildPublishedReplayTranscript({ modes, scenario }) {
	const transcriptModes = modes.map((modeEvidence) => {
		const toolCalls = REQUIRED_TOOL_EXECUTION_SPECS.map((spec) => {
			const explicitTool = [
				modeEvidence?.tool,
				modeEvidence?.searchTool,
				modeEvidence?.artifactTool,
			].find((tool) => tool?.callId === spec.id);
			return {
				id: spec.id,
				name: typeof explicitTool?.name === "string" ? explicitTool.name : spec.name,
				inputPath:
					typeof explicitTool?.inputPath === "string"
						? explicitTool.inputPath
						: spec.inputPath,
				resultStatus:
					typeof explicitTool?.resultStatus === "string"
						? explicitTool.resultStatus
						: "unknown",
				assertionId:
					typeof explicitTool?.assertionId === "string"
						? explicitTool.assertionId
						: undefined,
			};
		});
		return {
			mode: modeName(modeEvidence),
			scenarioSha256: scenario.sha256,
			output: {
				bytes: finiteNumber(modeEvidence?.output?.bytes),
				sha256:
					typeof modeEvidence?.output?.sha256 === "string"
						? modeEvidence.output.sha256
						: "",
			},
			toolCalls,
			final: {
				status:
					typeof modeEvidence?.final?.status === "string"
						? modeEvidence.final.status
						: "unknown",
				textSha256:
					typeof modeEvidence?.final?.textSha256 === "string"
						? modeEvidence.final.textSha256
						: undefined,
				containsExpectedText: modeEvidence?.final?.containsExpectedText === true,
			},
		};
	});
	return {
		schemaVersion: PUBLISHED_REPLAY_TRANSCRIPT_SCHEMA,
		scenario: {
			id: scenario.id,
			schemaVersion: scenario.schemaVersion,
			sha256: scenario.sha256,
		},
		modes: transcriptModes,
		coverage: {
			modes: uniqueValues(transcriptModes.map((mode) => mode.mode)),
			toolCallIds: uniqueValues(
				transcriptModes.flatMap((mode) =>
					mode.toolCalls.map((toolCall) => toolCall.id),
				),
			),
			finalStatus: countBy(transcriptModes.map((mode) => mode.final.status)),
		},
	};
}

function buildPublishedReplayTranscriptObservability(transcript) {
	const modes = Array.isArray(transcript?.modes) ? transcript.modes : [];
	return {
		schemaVersion: transcript?.schemaVersion,
		modes: Array.isArray(transcript?.coverage?.modes)
			? transcript.coverage.modes
			: uniqueValues(modes.map((mode) => mode?.mode)),
		toolCallIds: Array.isArray(transcript?.coverage?.toolCallIds)
			? transcript.coverage.toolCallIds
			: uniqueValues(
					modes.flatMap((mode) =>
						Array.isArray(mode?.toolCalls)
							? mode.toolCalls.map((toolCall) => toolCall?.id)
							: [],
					),
				),
		finalStatus:
			transcript?.coverage?.finalStatus &&
			typeof transcript.coverage.finalStatus === "object"
				? transcript.coverage.finalStatus
				: countBy(modes.map((mode) => mode?.final?.status)),
		scenarioSha256:
			typeof transcript?.scenario?.sha256 === "string"
				? transcript.scenario.sha256
				: "",
		outputSha256ByMode: Object.fromEntries(
			modes
				.filter(
					(mode) =>
						typeof mode?.mode === "string" &&
						typeof mode?.output?.sha256 === "string",
				)
				.map((mode) => [mode.mode, mode.output.sha256]),
		),
	};
}

function queryIndexEntry({
	key,
	traceType,
	status,
	modes = [],
	evidenceRefs = [],
	ids = [],
	counts = {},
}) {
	return {
		key,
		traceType,
		queryable: true,
		query: releaseObservabilityQueryDescriptor(traceType),
		status,
		modes: uniqueValues(modes),
		evidenceRefs: uniqueValues(evidenceRefs),
		ids: uniqueValues(ids),
		counts,
	};
}

function buildPublishedReplayObservabilityQueryIndex(observability) {
	return [
		queryIndexEntry({
			key: "install",
			traceType: "install",
			status:
				observability.install.installable === true &&
				observability.install.forbiddenReferences.length === 0 &&
				observability.install.workspaceProtocolReferences.length === 0
					? "ok"
					: "failed",
			ids: observability.install.binCommands,
			counts: {
				forbiddenReferences: observability.install.forbiddenReferences.length,
				workspaceProtocolReferences:
					observability.install.workspaceProtocolReferences.length,
			},
		}),
		queryIndexEntry({
			key: "scenario",
			traceType: "scenario",
			status: includesRequiredModes(observability.scenario.modes)
				? "ok"
				: "failed",
			modes: observability.scenario.modes,
			evidenceRefs: observability.scenario.evidenceRefs,
			ids: [observability.scenario.id],
			counts: {
				assertions: observability.scenario.assertions,
				passed: observability.scenario.passed,
				failed: observability.scenario.failed,
			},
		}),
		queryIndexEntry({
			key: "tools",
			traceType: "tool",
			status:
				SCRIPTED_REPLAY_TOOL_ALLOWLIST.every((name) =>
					observability.tools.names.includes(name),
				) &&
				REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
					observability.tools.callIds.includes(spec.id),
				) &&
				includesRequiredModes(observability.replay.modes)
					? "ok"
					: "failed",
			modes: observability.replay.modes,
			evidenceRefs: observability.tools.evidenceRefs,
			ids: observability.tools.callIds,
			counts: observability.tools.resultStatus,
		}),
		queryIndexEntry({
			key: "errors",
			traceType: "error",
			status:
				observability.errors.queryable === true &&
				observability.errors.expectedCount === 0 &&
				observability.errors.count === 0
					? "ok"
					: "failed",
			modes: observability.errors.modes,
			evidenceRefs: observability.errors.evidenceRefs,
			counts: {
				count: observability.errors.count,
				expectedCount: observability.errors.expectedCount,
			},
		}),
		queryIndexEntry({
			key: "agentRuntimeInspection",
			traceType: "inspection",
			status: agentRuntimeInspectionSatisfiesReleaseGate(
				observability.agentRuntimeInspection,
			)
				? "ok"
				: "failed",
			evidenceRefs: observability.agentRuntimeInspection.evidenceRefs,
			ids: [observability.agentRuntimeInspection.sessionId],
			counts: {
				entries: observability.agentRuntimeInspection.counts.entries,
				promotionOperations:
					observability.agentRuntimeInspection.counts.promotionOperations,
				terminalOperations:
					observability.agentRuntimeInspection.counts.terminalOperations,
			},
		}),
		queryIndexEntry({
			key: "finalStatus",
			traceType: "final-status",
			status: observability.finalStatus.allOk === true ? "ok" : "failed",
			modes: observability.replay.modes,
			counts: observability.finalStatus.byStatus,
		}),
	];
}

function queryIndexEntryForTrace(queryIndex, traceType) {
	return Array.isArray(queryIndex)
		? queryIndex.find((entry) => entry?.traceType === traceType)
		: undefined;
}

function releaseQueryDescriptorSatisfiesReleaseGate(entry, traceType) {
	return releaseObservabilityQueryDescriptorIsValid(entry, traceType);
}

function queryableObservabilityIndexSatisfiesReleaseGate(observability) {
	const queryIndex = Array.isArray(observability?.queryIndex)
		? observability.queryIndex
		: [];
	if (
		!REQUIRED_OBSERVABILITY_QUERY_TRACES.every((traceType) =>
			queryIndex.some(
				(entry) =>
					entry?.traceType === traceType &&
					entry?.queryable === true &&
					entry?.status === "ok" &&
					releaseQueryDescriptorSatisfiesReleaseGate(entry, traceType),
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
	const toolRefs = Array.isArray(toolEntry?.evidenceRefs)
		? toolEntry.evidenceRefs
		: [];
	const scenarioRefs = Array.isArray(scenarioEntry?.evidenceRefs)
		? scenarioEntry.evidenceRefs
		: [];
	const inspectionRefs = Array.isArray(inspectionEntry?.evidenceRefs)
		? inspectionEntry.evidenceRefs
		: [];

	return (
		installEntry?.counts?.forbiddenReferences === 0 &&
		installEntry?.counts?.workspaceProtocolReferences === 0 &&
		includesRequiredModes(scenarioEntry?.modes) &&
		scenarioEntry?.ids?.includes?.(SCENARIO_ID) &&
		finiteNumber(scenarioEntry?.counts?.failed) === 0 &&
		finiteNumber(scenarioEntry?.counts?.passed) > 0 &&
		scenarioRefs.includes(`audit-event:${AUDIT_EVENT_TYPE}`) &&
		includesRequiredModes(toolEntry?.modes) &&
		REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
			toolEntry?.ids?.includes?.(spec.id),
		) &&
		REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
			toolRefs.includes(`tool-call:${spec.id}`),
		) &&
		errorEntry?.counts?.count === 0 &&
		errorEntry?.counts?.expectedCount === 0 &&
		inspectionEntry?.status === "ok" &&
		inspectionRefs.some((ref) => ref.startsWith("inspection-session:")) &&
		agentRuntimeInspectionSatisfiesReleaseGate(
			observability.agentRuntimeInspection,
		) &&
		includesRequiredModes(finalStatusEntry?.modes) &&
		finalStatusEntry?.counts?.ok === REQUIRED_REPLAY_MODES.length
	);
}

function agentRuntimeInspectionSatisfiesReleaseGate(inspection) {
	if (!inspection || typeof inspection !== "object") {
		return false;
	}
	const terminalStates =
		inspection?.outcomes?.terminalStates &&
		typeof inspection.outcomes.terminalStates === "object" &&
		!Array.isArray(inspection.outcomes.terminalStates)
			? Object.entries(inspection.outcomes.terminalStates)
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
		finiteNumber(inspection?.counts?.entries) > 0 &&
		finiteNumber(inspection?.counts?.promotionOperations) > 0 &&
		terminalStates.some(
			([state, count]) =>
				TERMINAL_AGENT_RUNTIME_STATES.has(state) &&
				typeof count === "number" &&
				Number.isFinite(count) &&
				count > 0,
		) &&
		inspection.completionGate === AGENT_RUNTIME_COMPLETION_GATE &&
		Array.isArray(inspection.toolCallEvidence) &&
		inspection.toolCallEvidence.length > 0 &&
		inspection.toolCallEvidence.every(
			(entry) =>
				typeof entry?.toolName === "string" &&
				typeof entry?.toolCallId === "string" &&
				entry?.completionGate === AGENT_RUNTIME_COMPLETION_GATE &&
				Array.isArray(entry?.evidenceKinds) &&
				entry.evidenceKinds.includes("tool_call"),
		) &&
		inspection.durability?.reconstructable === true &&
		inspection.durability?.replayDeterministic === true &&
		inspection.durability?.sessionFilePresent === true &&
		typeof inspection.durability?.promotionIdempotencyKey === "string" &&
		inspection.durability.promotionIdempotencyKey.length > 0
	);
}

function buildPublishedReplayObservability({
	installMetadata,
	modes,
	scenario,
	scenarioConfig,
	transcript,
	scenarioResult,
	agentRuntimeInspection,
}) {
	const modeNames = modes.map(modeName);
	const scenarioEvidenceRefs = uniqueValues([
		`audit-event:${AUDIT_EVENT_TYPE}`,
		...REQUIRED_ASSERTION_IDS.map((id) => `scenario-assertion:${id}`),
	]);
	const toolEvidenceRefs = uniqueValues(
		REQUIRED_TOOL_EXECUTION_SPECS.map((spec) => `tool-call:${spec.id}`),
	);

	const observability = {
		install: {
			installable: installMetadata?.installable === true,
			forbiddenReferences: Array.isArray(installMetadata?.forbiddenReferences)
				? installMetadata.forbiddenReferences
				: [],
			workspaceProtocolReferences: Array.isArray(
				installMetadata?.workspaceProtocolReferences,
			)
				? installMetadata.workspaceProtocolReferences
				: [],
			binCommands: Array.isArray(installMetadata?.binCommands)
				? installMetadata.binCommands
				: [],
		},
		replay: {
			requiredModes: REQUIRED_REPLAY_MODES,
			modes: uniqueValues(modeNames),
			runner: "maestro scenario run",
			sandboxMode: replaySandboxMode,
		},
		scenarioConfig: cloneJson(scenarioConfig),
		transcript: buildPublishedReplayTranscriptObservability(transcript),
		scenario: {
			id: scenario.id,
			schemaVersion: scenario.schemaVersion,
			sha256: scenario.sha256,
			modes: uniqueValues(modeNames),
			assertions: finiteNumber(scenarioResult?.counts?.assertions),
			passed: finiteNumber(scenarioResult?.counts?.passed),
			failed: finiteNumber(scenarioResult?.counts?.failed),
			observedOutcome:
				typeof scenarioResult?.scenario?.observedOutcome === "string"
					? scenarioResult.scenario.observedOutcome
					: "unknown",
			auditEvents: Array.isArray(scenarioResult?.run?.auditEvents)
				? scenarioResult.run.auditEvents
				: [],
			evidenceRefs: scenarioEvidenceRefs,
		},
		tools: {
			names: uniqueValues(
				modes.flatMap((modeEvidence) =>
					toolEvidenceForMode(modeEvidence).map((tool) => tool?.name),
				),
			),
			callIds: uniqueValues(
				modes.flatMap((modeEvidence) =>
					toolEvidenceForMode(modeEvidence).map((tool) => tool?.callId),
				),
			),
			resultStatus: countBy(
				modes.flatMap((modeEvidence) =>
					toolEvidenceForMode(modeEvidence).map((tool) => tool?.resultStatus),
				),
			),
			evidenceRefs: toolEvidenceRefs,
		},
		errors: {
			queryable: true,
			expectedCount: 0,
			count: modes.filter((modeEvidence) => modeEvidence?.status !== "ok").length,
			modes: uniqueValues(
				modes
					.filter((modeEvidence) => modeEvidence?.status !== "ok")
					.map(modeName),
			),
			byStatus: countBy(modes.map((modeEvidence) => modeEvidence?.status)),
			evidenceRefs: [],
		},
		finalStatus: {
			allOk:
				modes.length > 0 &&
				modes.every(
					(modeEvidence) =>
						modeEvidence?.final?.status === "ok" &&
						modeEvidence?.final?.containsExpectedText === true,
				),
			byStatus: countBy(modes.map((modeEvidence) => modeEvidence?.final?.status)),
		},
		agentRuntimeInspection: cloneJson(agentRuntimeInspection),
	};
	return {
		...observability,
		queryIndex: buildPublishedReplayObservabilityQueryIndex(observability),
	};
}

function buildPublishedReplayReleaseGate({
	observability,
	modes,
	scenario,
	scenarioConfig,
	transcript,
	determinism,
	agentRuntimeInspection,
}) {
	const modeSet = new Set(observability.replay.modes);
	const checks = {
		installablePackageMetadata: observability.install.installable === true,
		noForbiddenWorkspaceReferences:
			observability.install.forbiddenReferences.length === 0,
		noWorkspaceProtocolReferences:
			observability.install.workspaceProtocolReferences.length === 0,
		scenarioConfig: scenarioConfigSatisfiesReleaseGate(scenarioConfig),
		requiredReplayModes: REQUIRED_REPLAY_MODES.every((mode) => modeSet.has(mode)),
		transcriptEvidence: transcriptSatisfiesReleaseGate(
			transcript,
			scenario.sha256,
		),
		deterministicReplayEvidence:
			determinism?.runs === DETERMINISM_RUNS &&
			determinism?.identical === true &&
			typeof determinism?.resultSha256 === "string" &&
			determinism.resultSha256.length === 64,
		scenarioAssertionEvidence:
			observability.scenario.observedOutcome === "pass" &&
			observability.scenario.failed === 0 &&
			observability.scenario.passed === REQUIRED_ASSERTION_IDS.length &&
			REQUIRED_ASSERTION_IDS.every((id) =>
				observability.scenario.evidenceRefs.includes(
					`scenario-assertion:${id}`,
				),
			),
		toolEvidence:
			modes.length > 0 &&
			modes.every((modeEvidence) =>
				REQUIRED_TOOL_EXECUTION_SPECS.every((spec) => {
					const tool = toolEvidenceForMode(modeEvidence).find(
						(entry) => entry?.callId === spec.id,
					);
					return (
						tool?.name === spec.name &&
						tool?.inputPath === spec.inputPath &&
						tool?.resultStatus === "success" &&
						typeof tool?.assertionId === "string" &&
						tool.assertionId.length > 0
					);
				}),
			),
		auditEventEvidence:
			observability.scenario.auditEvents.includes(AUDIT_EVENT_TYPE) &&
			observability.scenario.evidenceRefs.includes(
				`audit-event:${AUDIT_EVENT_TYPE}`,
			),
		errorTraceEvidence:
			observability.errors.queryable === true &&
			observability.errors.expectedCount === 0 &&
			observability.errors.count === 0 &&
			Array.isArray(observability.errors.modes),
		queryableObservabilityIndex:
			queryableObservabilityIndexSatisfiesReleaseGate(observability),
		agentRuntimeInspection:
			agentRuntimeInspectionSatisfiesReleaseGate(agentRuntimeInspection) &&
			agentRuntimeInspectionSatisfiesReleaseGate(
				observability.agentRuntimeInspection,
			),
		finalStatus: observability.finalStatus.allOk === true,
	};
	const failedChecks = Object.entries(checks)
		.filter(([, satisfied]) => satisfied !== true)
		.map(([name]) => name);

	return {
		releaseBlocking: true,
		satisfied: failedChecks.length === 0,
		requiredModes: REQUIRED_REPLAY_MODES,
		failedChecks,
		checks,
	};
}

async function getForbiddenWorkspaceNames() {
	const rootPackage = loadRootPackage();
	return getRuntimeWorkspaceNames(rootPackage);
}

export function resolvePublishedReplayEvidencePath({
	evidencePath = "",
	evidenceDir = "",
	env = process.env,
} = {}) {
	const explicitPath = evidencePath.trim();
	if (explicitPath) {
		return resolve(explicitPath);
	}

	const envPath = env.MAESTRO_PUBLISHED_REPLAY_EVIDENCE_PATH?.trim() ?? "";
	if (envPath) {
		return resolve(envPath);
	}

	const explicitDir = evidenceDir.trim();
	const envDir = env.MAESTRO_PUBLISHED_REPLAY_EVIDENCE_DIR?.trim() ?? "";
	const dir = explicitDir || envDir;
	if (!dir) {
		return "";
	}

	return join(resolve(dir), "published-replay-evidence.json");
}

function createScenario(runDir) {
	const scenarioPath = join(runDir, `${SCENARIO_ID}.json`);
	const content = `${JSON.stringify(
		{
			schemaVersion: SCRIPTED_SCENARIO_SCHEMA,
			id: SCENARIO_ID,
			description:
				"Published package replay with recorded read/search/write tool calls, real manifest file assertions, audit event evidence, and a final assistant response.",
			metadata: {
				recordedFrom: "smoke-published-replay-e2e",
				recordedAt: "2026-05-23T00:00:00.000Z",
				modelOriginal: "maestro-replay-v1",
				toolsExpected: ["read", "search", "write"],
				auditEvents: [AUDIT_EVENT_TYPE],
			},
			frames: [
				{
					index: 0,
					statements: [
						{
							kind: "text",
							text: "I will inspect the published package manifest.",
						},
						{
							kind: "tool_call",
							id: TOOL_CALL_ID,
							tool: "read",
							input: {
								path: "package.json",
							},
							expectedResult: "success",
						},
						{
							kind: "tool_call",
							id: SEARCH_TOOL_CALL_ID,
							tool: "search",
							input: {
								pattern: SEARCH_PATTERN,
								paths: "package.json",
								outputMode: "content",
								literal: true,
							},
							expectedResult: "success",
						},
					],
				},
				{
					index: 1,
					statements: [
						{
							kind: "text",
							text: "I will write the release evidence artifact.",
						},
						{
							kind: "tool_call",
							id: WRITE_TOOL_CALL_ID,
							tool: "write",
							input: {
								path: ARTIFACT_PATH,
								content: ARTIFACT_TEXT,
								previewDiff: false,
								backup: false,
							},
							expectedResult: "success",
						},
					],
				},
				{
					index: 2,
					statements: [
						{
							kind: "text",
							text: FINAL_TEXT,
						},
						{
							kind: "end",
							reason: "complete",
						},
					],
				},
			],
			assertions: [
				{
					id: "read-tool-called",
					kind: "tool_called",
					tool: "read",
				},
				{
					id: "search-tool-called",
					kind: "tool_called",
					tool: "search",
				},
				{
					id: "write-artifact-tool-called",
					kind: "tool_called",
					tool: "write",
				},
				{
					id: "manifest-exists",
					kind: "file_exists",
					path: "package.json",
				},
				{
					id: "manifest-contains-search-pattern",
					kind: "file_contents",
					path: "package.json",
					contains: SEARCH_PATTERN,
				},
				{
					id: "bash-tool-not-called",
					kind: "tool_not_called",
					tool: "bash",
				},
				{
					id: "audit-event-tagged",
					kind: "audit_event_emitted",
					eventType: AUDIT_EVENT_TYPE,
				},
			],
		},
		null,
		2,
	)}\n`;
	writeFileSync(scenarioPath, content);
	return {
		path: scenarioPath,
		id: SCENARIO_ID,
		schemaVersion: SCRIPTED_SCENARIO_SCHEMA,
		sha256: sha256(content),
	};
}

function createRunContext(label) {
	const runDir = mkdtempSync(join(tmpdir(), `maestro-published-${label}-`));
	const home = join(runDir, "home");
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(runDir, "package.json"),
		`${JSON.stringify(
			{
				name: `maestro-published-${label}`,
				version: "1.0.0",
				private: true,
			},
			null,
			2,
		)}\n`,
	);
	return {
		runDir,
		scenario: createScenario(runDir),
		env: {
			...process.env,
			CI: "1",
			NO_COLOR: "1",
			HOME: home,
		},
	};
}

function spawnScenarioRun(binPath, context, extraArgs, label) {
	const result = spawnSync(
		binPath,
		["scenario", "run", context.scenario.path, ...extraArgs],
		{
			cwd: context.runDir,
			encoding: "utf8",
			env: context.env,
			timeout: timeoutMs,
		},
	);
	if (result.error) {
		fail(`${label} failed to launch.`, result.error.stack);
	}
	if (result.signal) {
		fail(
			`${label} terminated by signal ${result.signal}.`,
			[result.stdout, result.stderr].filter(Boolean).join("\n\n"),
		);
	}
	if (result.status !== 0) {
		fail(
			`${label} exited with code ${result.status}.`,
			[result.stdout, result.stderr].filter(Boolean).join("\n\n"),
		);
	}
	return result;
}

function baseModeEvidence(mode, context, output) {
	return {
		mode,
		status: "ok",
		scenario: {
			id: context.scenario.id,
			schemaVersion: context.scenario.schemaVersion,
			sha256: context.scenario.sha256,
		},
		tool: {
			name: "read",
			callId: TOOL_CALL_ID,
			inputPath: "package.json",
			resultStatus: "success",
			assertionId: "read-tool-called",
		},
		searchTool: {
			name: "search",
			callId: SEARCH_TOOL_CALL_ID,
			inputPath: "package.json",
			resultStatus: "success",
			assertionId: "search-tool-called",
		},
		artifactTool: {
			name: "write",
			callId: WRITE_TOOL_CALL_ID,
			inputPath: ARTIFACT_PATH,
			resultStatus: "success",
			assertionId: "write-artifact-tool-called",
		},
		final: {
			status: "ok",
			textSha256: sha256(FINAL_TEXT),
			containsExpectedText: true,
			source: "scenario-definition",
		},
		output,
	};
}

function parseScenarioResult(stdout, label) {
	let result;
	try {
		result = JSON.parse(stdout);
	} catch (error) {
		fail(
			`${label} did not emit a JSON scenario result.`,
			`${stdout}\n${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return result;
}

function assertionById(result, assertionId) {
	return Array.isArray(result?.assertions)
		? result.assertions.find((assertion) => assertion?.id === assertionId)
		: undefined;
}

function assertScenarioResult(result, context, label) {
	if (result?.schemaVersion !== SCRIPTED_SCENARIO_RESULT_SCHEMA) {
		fail(`${label} did not emit the ${SCRIPTED_SCENARIO_RESULT_SCHEMA} schema.`);
	}
	if (result?.scenarioSchemaVersion !== SCRIPTED_SCENARIO_SCHEMA) {
		fail(`${label} did not replay a ${SCRIPTED_SCENARIO_SCHEMA} scenario.`);
	}
	if (result?.scenario?.id !== SCENARIO_ID) {
		fail(`${label} replayed an unexpected scenario id.`);
	}
	if (result?.scenario?.observedOutcome !== "pass") {
		fail(
			`${label} observed outcome was not "pass".`,
			JSON.stringify(result?.scenario),
		);
	}
	if (result?.run?.replay !== true || result?.run?.frames !== 3) {
		fail(`${label} did not replay all three scenario frames.`);
	}
	if (finiteNumber(result?.counts?.failed) !== 0) {
		fail(`${label} reported failed assertions.`, JSON.stringify(result?.counts));
	}
	if (finiteNumber(result?.counts?.passed) !== REQUIRED_ASSERTION_IDS.length) {
		fail(
			`${label} did not pass all ${REQUIRED_ASSERTION_IDS.length} assertions.`,
			JSON.stringify(result?.counts),
		);
	}
	for (const assertionId of REQUIRED_ASSERTION_IDS) {
		const assertion = assertionById(result, assertionId);
		if (assertion?.status !== "pass") {
			fail(
				`${label} assertion ${assertionId} did not pass.`,
				JSON.stringify(assertion),
			);
		}
	}
	for (const spec of REQUIRED_TOOL_EXECUTION_SPECS) {
		const assertion = REQUIRED_ASSERTION_IDS.map((id) =>
			assertionById(result, id),
		).find((candidate) =>
			Array.isArray(candidate?.evidence)
				? candidate.evidence.some(
						(entry) => entry?.kind === "tool_call" && entry?.id === spec.id,
					)
				: false,
		);
		if (!assertion) {
			fail(`${label} is missing tool_call assertion evidence for ${spec.id}.`);
		}
	}
	const manifestAssertion = assertionById(
		result,
		"manifest-contains-search-pattern",
	);
	if (
		!Array.isArray(manifestAssertion?.evidence) ||
		!manifestAssertion.evidence.some(
			(entry) => entry?.kind === "file" && entry?.id === "package.json",
		)
	) {
		fail(`${label} is missing real manifest file_contents evidence.`);
	}
	const auditAssertion = assertionById(result, "audit-event-tagged");
	if (
		!Array.isArray(auditAssertion?.evidence) ||
		!auditAssertion.evidence.some(
			(entry) => entry?.kind === "audit_event" && entry?.id === AUDIT_EVENT_TYPE,
		)
	) {
		fail(`${label} is missing audit event evidence.`);
	}
	if (
		!Array.isArray(result?.run?.auditEvents) ||
		!result.run.auditEvents.includes(AUDIT_EVENT_TYPE)
	) {
		fail(`${label} did not surface the ${AUDIT_EVENT_TYPE} audit event.`);
	}
	return result;
}

function runTextMode(binPath) {
	const label = "Published text replay";
	const context = createRunContext("replay-text");
	try {
		const result = spawnScenarioRun(binPath, context, [], label);
		const stdout = result.stdout ?? "";
		const summaryPattern = new RegExp(
			`Scripted scenario ${SCENARIO_ID}: ${REQUIRED_ASSERTION_IDS.length}/${REQUIRED_ASSERTION_IDS.length} passed, 0 failed`,
		);
		if (!summaryPattern.test(stdout)) {
			fail(`${label} did not print the scenario pass summary.`, stdout);
		}
		for (const assertionId of REQUIRED_ASSERTION_IDS) {
			if (!stdout.includes(`PASS ${assertionId}`)) {
				fail(`${label} did not print a PASS line for ${assertionId}.`, stdout);
			}
		}
		console.log("Published text replay smoke passed.");
		return baseModeEvidence("text", context, {
			bytes: Buffer.byteLength(stdout),
			sha256: sha256(stdout),
			containsSummary: true,
		});
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function runJsonMode(binPath) {
	const label = "Published JSON replay";
	const context = createRunContext("replay-json");
	try {
		const outputs = [];
		for (let run = 0; run < DETERMINISM_RUNS; run += 1) {
			const result = spawnScenarioRun(binPath, context, ["--json"], label);
			outputs.push(result.stdout ?? "");
		}
		const identical = outputs.every((output) => output === outputs[0]);
		if (!identical) {
			fail(`${label} was not deterministic across ${DETERMINISM_RUNS} runs.`);
		}
		const scenarioResult = assertScenarioResult(
			parseScenarioResult(outputs[0], label),
			context,
			label,
		);
		const evidence = baseModeEvidence("json", context, {
			bytes: Buffer.byteLength(outputs[0]),
			sha256: sha256(outputs[0]),
		});
		evidence.result = {
			schemaVersion: scenarioResult.schemaVersion,
			observedOutcome: scenarioResult.scenario.observedOutcome,
			assertionsPassed: finiteNumber(scenarioResult.counts?.passed),
			assertionsFailed: finiteNumber(scenarioResult.counts?.failed),
			resultSha256: sha256(outputs[0]),
		};
		evidence.determinism = {
			runs: DETERMINISM_RUNS,
			identical: true,
			resultSha256: sha256(outputs[0]),
		};
		console.log("Published JSON replay smoke passed.");
		return { evidence, scenarioResult };
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function runJunitMode(binPath) {
	const label = "Published JUnit replay";
	const context = createRunContext("replay-junit");
	try {
		const junitPath = join(context.runDir, "junit.xml");
		spawnScenarioRun(binPath, context, ["--junit", junitPath], label);
		if (!existsSync(junitPath)) {
			fail(`${label} did not write a JUnit report to ${junitPath}.`);
		}
		const junit = readFileSync(junitPath, "utf8");
		const suiteMatch = junit.match(
			/<testsuite name="([^"]+)" tests="(\d+)" failures="(\d+)"/,
		);
		if (!suiteMatch) {
			fail(`${label} wrote a JUnit report without a testsuite header.`, junit);
		}
		const [, suiteName, tests, failures] = suiteMatch;
		if (suiteName !== SCENARIO_ID) {
			fail(`${label} JUnit testsuite name was ${suiteName}, expected ${SCENARIO_ID}.`);
		}
		if (Number.parseInt(tests, 10) !== REQUIRED_ASSERTION_IDS.length) {
			fail(`${label} JUnit report did not cover every assertion.`, junit);
		}
		if (failures !== "0") {
			fail(`${label} JUnit report recorded failures.`, junit);
		}
		for (const assertionId of REQUIRED_ASSERTION_IDS) {
			if (!junit.includes(`name="${assertionId}"`)) {
				fail(`${label} JUnit report is missing testcase ${assertionId}.`, junit);
			}
		}
		console.log("Published JUnit replay smoke passed.");
		const evidence = baseModeEvidence("junit", context, {
			bytes: Buffer.byteLength(junit),
			sha256: sha256(junit),
		});
		evidence.junit = {
			tests: Number.parseInt(tests, 10),
			failures: 0,
			testcaseNames: [...REQUIRED_ASSERTION_IDS],
		};
		return evidence;
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function rustSessionDirForContext(context) {
	const cwd = realpathSync(context.runDir);
	const sanitized = cwd.replace(/[/\\:]/g, "-").replace(/^-+|-+$/g, "");
	return join(
		context.env.HOME,
		".composer",
		"agent",
		"sessions",
		`--${sanitized}--`,
	);
}

// Writes a disclosed fixture session so the published binary's native
// `maestro run inspect` reconstruction pipeline (timeline, AgentRuntime
// ledger, durability) can be audited end to end. This does not stand in for
// replay-produced sessions: the fixture provenance is recorded in the
// evidence via agentRuntimeInspection.fixture === true.
function writeAgentRuntimeInspectionFixtureSession(context) {
	const sessionId = "published-inspection-fixture";
	const cwd = realpathSync(context.runDir);
	const readCallId = "call-inspect-read-package-json";
	const writeCallId = "call-inspect-write-artifact";
	const entries = [
		{
			type: "session",
			version: 2,
			id: sessionId,
			timestamp: "2026-05-23T00:00:00.000Z",
			cwd,
			model: "maestro-replay-v1",
		},
		{
			type: "message",
			id: "user-inspection-1",
			parentId: null,
			timestamp: "2026-05-23T00:00:01.000Z",
			message: {
				role: "user",
				content: "Replay the published package golden path.",
				timestamp: 1779494401000,
			},
		},
		{
			type: "message",
			id: "assistant-inspection-1",
			parentId: "user-inspection-1",
			timestamp: "2026-05-23T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I will inspect the published package manifest." },
					{
						type: "toolCall",
						id: readCallId,
						name: "read",
						arguments: { path: "package.json" },
					},
				],
				api: "scripted-replay",
				provider: "scripted-replay",
				model: "maestro-replay-v1",
				stopReason: "toolUse",
				timestamp: 1779494402000,
			},
		},
		{
			type: "message",
			id: "tool-inspection-read",
			parentId: "assistant-inspection-1",
			timestamp: "2026-05-23T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: readCallId,
				toolName: "read",
				content: [{ type: "text", text: "{\"name\":\"maestro-published\"}" }],
				isError: false,
				timestamp: 1779494403000,
				details: { toolExecutionId: "tool-exec-inspection-read" },
			},
		},
		{
			type: "message",
			id: "assistant-inspection-2",
			parentId: "tool-inspection-read",
			timestamp: "2026-05-23T00:00:04.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I will write the release evidence artifact." },
					{
						type: "toolCall",
						id: writeCallId,
						name: "write",
						arguments: { path: ARTIFACT_PATH, content: ARTIFACT_TEXT },
					},
				],
				api: "scripted-replay",
				provider: "scripted-replay",
				model: "maestro-replay-v1",
				stopReason: "toolUse",
				timestamp: 1779494404000,
			},
		},
		{
			type: "message",
			id: "tool-inspection-write",
			parentId: "assistant-inspection-2",
			timestamp: "2026-05-23T00:00:05.000Z",
			message: {
				role: "toolResult",
				toolCallId: writeCallId,
				toolName: "write",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 1779494405000,
				details: { toolExecutionId: "tool-exec-inspection-write" },
			},
		},
		{
			type: "message",
			id: "assistant-inspection-final",
			parentId: "tool-inspection-write",
			timestamp: "2026-05-23T00:00:06.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: FINAL_TEXT }],
				api: "scripted-replay",
				provider: "scripted-replay",
				model: "maestro-replay-v1",
				stopReason: "stop",
				timestamp: 1779494406000,
			},
		},
	];
	const sessionDir = rustSessionDirForContext(context);
	mkdirSync(sessionDir, { recursive: true });
	// The native session reader discovers headers via compact JSONL
	// (`"type":"session"` substring scan); keep one compact entry per line.
	writeFileSync(
		join(sessionDir, `2026-05-23T00-00-00-000Z_${sessionId}.jsonl`),
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return { sessionId, toolCallIds: [readCallId, writeCallId] };
}

function assertAgentRuntimeInspection(binPath) {
	const label = "Published AgentRuntime inspection";
	const context = createRunContext("agent-runtime-inspection");
	try {
		const { sessionId, toolCallIds } =
			writeAgentRuntimeInspectionFixtureSession(context);
		const result = spawnSync(binPath, ["run", "inspect", sessionId, "--json"], {
			cwd: context.runDir,
			encoding: "utf8",
			env: context.env,
			timeout: timeoutMs,
		});
		if (result.error) {
			fail(`${label} failed to launch.`, result.error.stack);
		}
		if (result.status !== 0) {
			fail(
				`${label} exited with ${result.status}.`,
				[result.stdout, result.stderr].filter(Boolean).join("\n\n"),
			);
		}
		let report;
		try {
			report = JSON.parse(result.stdout);
		} catch (error) {
			fail(
				`${label} did not emit JSON.`,
				`${result.stdout}\n${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const ledger = report?.agentRuntimeLedger;
		if (ledger?.schemaVersion !== AGENT_RUNTIME_LEDGER_SCHEMA) {
			fail(`${label} did not emit the ${AGENT_RUNTIME_LEDGER_SCHEMA} schema.`);
		}
		const durability = report?.durability;
		if (durability?.reconstructable !== true) {
			fail(`${label} did not prove reconstructable durability.`);
		}
		if (durability?.replayDeterministic !== true) {
			fail(`${label} did not carry deterministic replay durability.`);
		}
		if (durability?.agentRuntimeLedgerEntries !== ledger?.counts?.entries) {
			fail(`${label} durability summary did not match ledger entries.`);
		}
		if (typeof durability?.promotionIdempotencyKey !== "string") {
			fail(`${label} is missing the promotion idempotency key.`);
		}
		if (ledger?.replay?.deterministic !== true) {
			fail(`${label} ledger replay was not deterministic.`);
		}
		const operations = Array.isArray(ledger?.promotion?.operations)
			? ledger.promotion.operations
			: [];
		const hasHandleTrigger = operations.some(
			(operation) => operation?.operation === "handle_trigger",
		);
		const hasRecordRunStep = operations.some(
			(operation) => operation?.operation === "record_run_step",
		);
		const hasRecordRunWorkItem = operations.some(
			(operation) => operation?.operation === "record_run_work_item",
		);
		const terminalOperations = operations.filter(
			(operation) =>
				operation?.operation === "complete_run" ||
				operation?.operation === "fail_run",
		);
		if (
			!hasHandleTrigger ||
			!hasRecordRunStep ||
			!hasRecordRunWorkItem ||
			terminalOperations.length === 0
		) {
			fail(`${label} promotion plan is missing required operations.`);
		}
		const workItems = operations.filter(
			(operation) => operation?.operation === "record_run_work_item",
		);
		for (const workItem of workItems) {
			if (workItem?.payload?.completionGate !== AGENT_RUNTIME_COMPLETION_GATE) {
				fail(`${label} work item is missing the completion gate.`);
			}
		}
		const runSteps = operations.filter(
			(operation) => operation?.operation === "record_run_step",
		);
		const toolCallEvidence = toolCallIds.map((toolCallId) => {
			const workItem = workItems.find((candidate) =>
				Array.isArray(candidate?.payload?.evidenceRefs)
					? candidate.payload.evidenceRefs.some(
							(ref) => ref?.kind === "tool_call" && ref?.id === toolCallId,
						)
					: false,
			);
			if (!workItem) {
				fail(`${label} is missing tool_call evidence for ${toolCallId}.`);
			}
			const runStep = runSteps.find(
				(candidate) =>
					candidate?.payload?.stepId === workItem?.ledgerEntryId ||
					candidate?.ledgerEntryId === workItem?.ledgerEntryId,
			);
			const toolName =
				typeof runStep?.payload?.toolName === "string"
					? runStep.payload.toolName
					: "";
			if (!toolName) {
				fail(`${label} is missing the tool name for ${toolCallId}.`);
			}
			return {
				toolName,
				toolCallId,
				completionGate: workItem?.payload?.completionGate,
				evidenceKinds: uniqueValues(
					(Array.isArray(workItem?.payload?.evidenceRefs)
						? workItem.payload.evidenceRefs
						: []
					).map((ref) => ref?.kind),
				),
			};
		});
		console.log("Published AgentRuntime inspection smoke passed.");
		return {
			fixture: true,
			sessionId,
			ledgerSchemaVersion: ledger.schemaVersion,
			replayDeterministic: true,
			hasHandleTrigger,
			hasRecordRunStep,
			hasRecordRunWorkItem,
			hasTerminalOperation: terminalOperations.length > 0,
			completionGate: AGENT_RUNTIME_COMPLETION_GATE,
			counts: {
				entries: finiteNumber(ledger?.counts?.entries),
				promotionOperations: finiteNumber(
					ledger?.counts?.promotionOperations ?? operations.length,
				),
				terminalOperations: terminalOperations.length,
			},
			outcomes: {
				terminalStates: countBy(
					terminalOperations.map((operation) => operation?.payload?.state),
				),
				terminalEventTypes: uniqueValues(
					terminalOperations.map((operation) => operation?.payload?.eventType),
				),
			},
			toolCallEvidence,
			durability: {
				reconstructable: true,
				sessionFilePresent: durability.sessionFilePresent === true,
				replayDeterministic: true,
				promotionIdempotencyKey: durability.promotionIdempotencyKey,
			},
			evidenceRefs: uniqueValues([
				`inspection-session:${sessionId}`,
				...toolCallIds.map((toolCallId) => `tool-call:${toolCallId}`),
			]),
		};
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

export function buildPublishedReplayEvidence({
	packageSpec,
	cliCommand,
	binPath,
	installMetadata = null,
	installer = "",
	modes,
	scenario,
	scenarioResult,
	determinism,
	agentRuntimeInspection,
}) {
	const resolvedInstaller = inferPublishedInstaller({ installer, installMetadata });
	const scenarioConfig = {
		runner: "maestro scenario run",
		scenarioSchemaVersion: SCRIPTED_SCENARIO_SCHEMA,
		scenarioId: scenario.id,
		scenarioSha256: scenario.sha256,
		deterministic: true,
		externalCredentialsRequired: false,
		externalNetworkRequired: false,
		toolAllowlist: [...SCRIPTED_REPLAY_TOOL_ALLOWLIST],
		approvalMode: SCRIPTED_REPLAY_APPROVAL_MODE,
		sandboxMode: replaySandboxMode,
	};
	const transcript = buildPublishedReplayTranscript({ modes, scenario });
	const observability = buildPublishedReplayObservability({
		installMetadata,
		modes,
		scenario,
		scenarioConfig,
		transcript,
		scenarioResult,
		agentRuntimeInspection,
	});
	const releaseGate = buildPublishedReplayReleaseGate({
		observability,
		modes,
		scenario,
		scenarioConfig,
		transcript,
		determinism,
		agentRuntimeInspection,
	});
	return {
		schemaVersion: PUBLISHED_REPLAY_EVIDENCE_SCHEMA,
		generatedAt: new Date().toISOString(),
		installer: resolvedInstaller,
		package: {
			spec: packageSpec,
			cliCommand,
			binPath,
			installMetadata,
		},
		replay: {
			runner: "maestro scenario run",
			scenarioSchemaVersion: SCRIPTED_SCENARIO_SCHEMA,
			scenario: {
				id: scenario.id,
				schemaVersion: scenario.schemaVersion,
				sha256: scenario.sha256,
			},
			sandboxMode: replaySandboxMode,
			scenarioConfig: cloneJson(scenarioConfig),
			determinism: cloneJson(determinism),
			expected: {
				toolName: "read",
				toolCallId: TOOL_CALL_ID,
				toolInputPath: "package.json",
				searchToolName: "search",
				searchToolCallId: SEARCH_TOOL_CALL_ID,
				searchToolInputPath: "package.json",
				writeToolName: "write",
				writeToolCallId: WRITE_TOOL_CALL_ID,
				writeToolInputPath: ARTIFACT_PATH,
				finalTextSha256: sha256(FINAL_TEXT),
			},
		},
		transcript,
		observability,
		releaseGate,
		agentRuntimeInspection: cloneJson(agentRuntimeInspection),
		modes,
	};
}

function writePublishedReplayEvidence(evidencePath, evidence) {
	if (!evidencePath) {
		return;
	}
	mkdirSync(dirname(evidencePath), { recursive: true });
	writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(`Published replay E2E evidence written to ${evidencePath}.`);
}

export async function runPublishedReplayE2E({
	installRoot,
	cliCommand,
	packageSpec,
	evidencePath = "",
	installMetadata = null,
	installer = "",
}) {
	if (process.env.MAESTRO_SKIP_PUBLISHED_REPLAY_E2E === "1") {
		console.log(`Skipping published replay E2E smoke for ${packageSpec}.`);
		return null;
	}

	const binPath = installedBinPath(installRoot, cliCommand);
	const modes = [];
	modes.push(runTextMode(binPath));
	const { evidence: jsonModeEvidence, scenarioResult } = runJsonMode(binPath);
	modes.push(jsonModeEvidence);
	modes.push(runJunitMode(binPath));
	const agentRuntimeInspection = assertAgentRuntimeInspection(binPath);
	const scenario = modes[0].scenario;
	const determinism = jsonModeEvidence.determinism;
	const evidence = buildPublishedReplayEvidence({
		packageSpec,
		cliCommand,
		binPath,
		installMetadata,
		installer,
		modes,
		scenario,
		scenarioResult,
		determinism,
		agentRuntimeInspection,
	});
	writePublishedReplayEvidence(
		resolvePublishedReplayEvidencePath({ evidencePath }),
		evidence,
	);
	assertPublishedReplayReleaseGate(evidence);
	console.log(`Published replay E2E smoke passed for ${packageSpec}.`);
	return evidence;
}

async function main() {
	const defaults = getPackageMetadata();
	const overrides = parseArgs(process.argv.slice(2));
	const cliCommand = overrides.cliCommand || defaults.cliCommand;
	const name = overrides.packageName || defaults.name;
	const version = overrides.version || defaults.version;
	const packageSpec = `${name}@${version}`;
	const installer = overrides.installer || "npm";
	const evidencePath = resolvePublishedReplayEvidencePath({
		evidencePath: overrides.evidencePath,
		evidenceDir: overrides.evidenceDir,
	});
	let installRoot = overrides.installRoot
		? resolve(overrides.installRoot)
		: "";
	const shouldCleanup = !installRoot;

	if (!installRoot) {
		const installPlan = registryInstallPlanForInstaller({
			installer,
			packageSpec,
		});
		installRoot = mkdtempSync(join(tmpdir(), installPlan.tempPrefix));
		try {
			spawnSync(installPlan.command, installPlan.initArgs, {
				cwd: installRoot,
				stdio: "ignore",
			});
			const install = spawnSync(installPlan.command, installPlan.installArgs, {
				cwd: installRoot,
				encoding: "utf8",
				stdio: "inherit",
			});
			if (install.error) {
				throw install.error;
			}
			if (install.status !== 0) {
				throw new Error(
					`${installPlan.command} ${installPlan.installArgs.join(" ")} exited with ${install.status}`,
				);
			}
		} catch (error) {
			if (shouldCleanup) {
				rmSync(installRoot, { recursive: true, force: true });
			}
			throw error;
		}
	}

	try {
		const installMetadata = summarizeInstallablePackageMetadata(
			readInstalledPackageJson(name, installRoot),
			{
				label: installLabelForInstaller({ packageSpec, installer }),
				forbiddenWorkspaceNames: await getForbiddenWorkspaceNames(),
			},
		);
		runInstalledCliSmoke(installRoot, {
			cliCommand,
			expectedVersion: version,
			label: "published replay CLI",
		});
		await runPublishedReplayE2E({
			installRoot,
			cliCommand,
			packageSpec,
			evidencePath,
			installMetadata,
			installer,
		});
	} finally {
		if (shouldCleanup) {
			rmSync(installRoot, { recursive: true, force: true });
		}
	}
}

const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypointPath && fileURLToPath(import.meta.url) === entrypointPath) {
	await main();
}
