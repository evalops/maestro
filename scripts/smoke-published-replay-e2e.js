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
	readdirSync,
	rmSync,
	statSync,
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
const ARTIFACT_PATH = "published-replay-artifact.json";
const ARTIFACT_TEXT = JSON.stringify({
	source: "smoke-published-replay-e2e",
	manifest: "package.json",
});
const SEARCH_PATTERN = "maestro-published";
const REQUIRED_REPLAY_MODES = ["text", "json", "junit"];
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
// The native `maestro scenario run --execute` surface has no sandbox flag;
// the release workflow still exports MAESTRO_PUBLISHED_REPLAY_SANDBOX_MODE,
// so keep validating it and record it as informational metadata.
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

// The built-in `search` tool shells out to ripgrep. When rg is unavailable
// the smoke still proves read/write execution and records the search leg as
// explicitly skipped instead of failing the whole canary.
function detectRipgrep() {
	const result = spawnSync("rg", ["--version"], { encoding: "utf8" });
	return result.status === 0 && !result.error;
}
const ripgrepAvailable = detectRipgrep();
const SEARCH_SKIP_REASON = "rg-not-found";

const REQUIRED_TOOL_EXECUTION_SPECS = [
	{ id: TOOL_CALL_ID, name: "read", inputPath: "package.json" },
	...(ripgrepAvailable
		? [{ id: SEARCH_TOOL_CALL_ID, name: "search", inputPath: "package.json" }]
		: []),
	{ id: WRITE_TOOL_CALL_ID, name: "write", inputPath: ARTIFACT_PATH },
];
const REQUIRED_ASSERTION_IDS = [
	"read-tool-called",
	...(ripgrepAvailable ? ["search-tool-called"] : []),
	"write-artifact-tool-called",
	"manifest-exists",
	"manifest-contains-search-pattern",
	"artifact-exists",
	"artifact-contents",
	"bash-tool-not-called",
	"audit-event-tagged",
];

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

function toolEvidenceForMode(modeEvidence) {
	return [modeEvidence?.tool, modeEvidence?.searchTool, modeEvidence?.artifactTool]
		.filter((tool) => tool && typeof tool === "object");
}

function scenarioConfigSatisfiesReleaseGate(scenarioConfig, scenarioSha256) {
	return (
		scenarioConfig?.runner === "maestro scenario run --execute" &&
		scenarioConfig?.scenarioSchemaVersion === SCRIPTED_SCENARIO_SCHEMA &&
		scenarioConfig?.scenarioId === SCENARIO_ID &&
		scenarioConfig?.scenarioSha256 === scenarioSha256 &&
		scenarioConfig?.deterministic === true &&
		scenarioConfig?.externalCredentialsRequired === false &&
		scenarioConfig?.externalNetworkRequired === false &&
		Array.isArray(scenarioConfig?.toolAllowlist) &&
		REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
			scenarioConfig.toolAllowlist.includes(spec.name),
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
			typeof mode?.session?.sessionId === "string" &&
			mode.session.sessionId.length > 0 &&
			finiteNumber(mode?.session?.jsonlFileCount) > 0 &&
			typeof mode?.session?.sha256 === "string" &&
			mode.session.sha256.length === 64
		);
	});
}

function buildPublishedReplayTranscript({ modes, scenario }) {
	const transcriptModes = modes.map((modeEvidence) => {
		const toolCalls = REQUIRED_TOOL_EXECUTION_SPECS.map((spec) => {
			const explicitTool = toolEvidenceForMode(modeEvidence).find(
				(tool) => tool?.callId === spec.id,
			);
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
			session: {
				sessionId:
					typeof modeEvidence?.session?.sessionId === "string"
						? modeEvidence.session.sessionId
						: "",
				jsonlFileCount: finiteNumber(modeEvidence?.session?.jsonlFileCount),
				bytes: finiteNumber(modeEvidence?.session?.bytes),
				sha256:
					typeof modeEvidence?.session?.sha256 === "string"
						? modeEvidence.session.sha256
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
		sessionSha256ByMode: Object.fromEntries(
			modes
				.filter(
					(mode) =>
						typeof mode?.mode === "string" &&
						typeof mode?.session?.sha256 === "string",
				)
				.map((mode) => [mode.mode, mode.session.sha256]),
		),
	};
}

function agentRuntimeLedgerSatisfiesReleaseGate(ledger) {
	if (!ledger || typeof ledger !== "object") {
		return false;
	}
	return (
		ledger.schemaVersion === AGENT_RUNTIME_LEDGER_SCHEMA &&
		ledger.replayDeterministic === true &&
		ledger.hasHandleTrigger === true &&
		ledger.hasRecordRunStep === true &&
		ledger.hasRecordRunWorkItem === true &&
		ledger.hasTerminalOperation === true &&
		finiteNumber(ledger?.counts?.entries) > 0 &&
		finiteNumber(ledger?.counts?.promotionOperations) > 0 &&
		ledger.completionGate === AGENT_RUNTIME_COMPLETION_GATE &&
		Array.isArray(ledger.toolCallEvidence) &&
		REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
			ledger.toolCallEvidence.some(
				(entry) =>
					entry?.toolName === spec.name &&
					entry?.toolCallId === spec.id &&
					entry?.completionGate === AGENT_RUNTIME_COMPLETION_GATE &&
					Array.isArray(entry?.evidenceKinds) &&
					entry.evidenceKinds.includes("tool_call"),
			),
		) &&
		ledger.durability?.reconstructable === true &&
		ledger.durability?.replayDeterministic === true &&
		ledger.durability?.sessionFilePresent === true &&
		typeof ledger.durability?.promotionIdempotencyKey === "string" &&
		ledger.durability.promotionIdempotencyKey.length > 0
	);
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
			key: "sessions",
			traceType: "session",
			status: includesRequiredModes(observability.sessions.modes)
				? "ok"
				: "failed",
			modes: observability.sessions.modes,
			ids: observability.sessions.sessionIds,
			counts: {
				jsonlFileCount: observability.sessions.jsonlFileCount,
				bytes: observability.sessions.bytes,
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
				REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
					observability.tools.names.includes(spec.name),
				) &&
				REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
					observability.tools.callIds.includes(spec.id),
				) &&
				REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
					observability.tools.evidenceRefs.includes(`tool-call:${spec.id}`),
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
			key: "agentRuntimeLedger",
			traceType: "inspection",
			status:
				includesRequiredModes(observability.agentRuntimeLedger.modes) &&
				includesRequiredModes(
					observability.agentRuntimeLedger.replayDeterministicModes,
				) &&
				includesRequiredModes(observability.agentRuntimeLedger.durabilityModes)
					? "ok"
					: "failed",
			modes: observability.agentRuntimeLedger.modes,
			evidenceRefs: observability.agentRuntimeLedger.evidenceRefs,
			ids: observability.agentRuntimeLedger.sessionIds,
			counts: {
				entries: observability.agentRuntimeLedger.counts.entries,
				promotionOperations:
					observability.agentRuntimeLedger.counts.promotionOperations,
				terminalOperations:
					observability.agentRuntimeLedger.counts.terminalOperations,
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
	const sessionEntry = queryIndexEntryForTrace(queryIndex, "session");
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
		includesRequiredModes(sessionEntry?.modes) &&
		finiteNumber(sessionEntry?.counts?.jsonlFileCount) >=
			REQUIRED_REPLAY_MODES.length &&
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
		includesRequiredModes(inspectionEntry?.modes) &&
		inspectionRefs.some((ref) => ref.startsWith("inspection-session:")) &&
		includesRequiredModes(finalStatusEntry?.modes) &&
		finalStatusEntry?.counts?.ok === REQUIRED_REPLAY_MODES.length
	);
}

function buildPublishedReplayObservability({
	installMetadata,
	modes,
	scenario,
	scenarioConfig,
	transcript,
	scenarioResult,
}) {
	const modeNames = modes.map(modeName);
	const scenarioEvidenceRefs = uniqueValues([
		`audit-event:${AUDIT_EVENT_TYPE}`,
		...REQUIRED_ASSERTION_IDS.map((id) => `scenario-assertion:${id}`),
	]);
	const toolEvidenceRefs = uniqueValues(
		REQUIRED_TOOL_EXECUTION_SPECS.map((spec) => `tool-call:${spec.id}`),
	);
	const ledgerModes = modes.filter((modeEvidence) =>
		agentRuntimeLedgerSatisfiesReleaseGate(modeEvidence?.agentRuntimeLedger),
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
			runner: "maestro scenario run --execute",
			sandboxMode: replaySandboxMode,
			searchTool: ripgrepAvailable
				? { status: "executed" }
				: { status: "skipped", reason: SEARCH_SKIP_REASON },
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
		sessions: {
			modes: uniqueValues(
				modes
					.filter(
						(modeEvidence) =>
							modeEvidence?.session?.containsFinalText === true &&
							modeEvidence?.session?.containsToolCallId === true &&
							modeEvidence?.session?.containsWriteToolCallId === true &&
							(!ripgrepAvailable ||
								modeEvidence?.session?.containsSearchToolCallId === true),
					)
					.map(modeName),
			),
			sessionIds: uniqueValues(
				modes.map((modeEvidence) => modeEvidence?.session?.sessionId),
			),
			jsonlFileCount: modes.reduce(
				(total, modeEvidence) =>
					total + finiteNumber(modeEvidence?.session?.jsonlFileCount),
				0,
			),
			bytes: modes.reduce(
				(total, modeEvidence) => total + finiteNumber(modeEvidence?.session?.bytes),
				0,
			),
			sha256ByMode: Object.fromEntries(
				modes
					.filter((modeEvidence) => typeof modeEvidence?.session?.sha256 === "string")
					.map((modeEvidence) => [modeName(modeEvidence), modeEvidence.session.sha256]),
			),
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
		agentRuntimeLedger: {
			modes: uniqueValues(ledgerModes.map(modeName)),
			replayDeterministicModes: uniqueValues(
				ledgerModes
					.filter(
						(modeEvidence) =>
							modeEvidence?.agentRuntimeLedger?.replayDeterministic === true,
					)
					.map(modeName),
			),
			durabilityModes: uniqueValues(
				ledgerModes
					.filter(
						(modeEvidence) =>
							modeEvidence?.agentRuntimeLedger?.durability?.reconstructable ===
								true &&
							modeEvidence?.agentRuntimeLedger?.durability
								?.replayDeterministic === true &&
							typeof modeEvidence?.agentRuntimeLedger?.durability
								?.promotionIdempotencyKey === "string",
					)
					.map(modeName),
			),
			sessionIds: uniqueValues(
				modes.map((modeEvidence) => modeEvidence?.session?.sessionId),
			),
			completionGate: AGENT_RUNTIME_COMPLETION_GATE,
			toolCallIds: uniqueValues(
				ledgerModes.flatMap((modeEvidence) =>
					(Array.isArray(modeEvidence?.agentRuntimeLedger?.toolCallEvidence)
						? modeEvidence.agentRuntimeLedger.toolCallEvidence
						: []
					).map((entry) => entry?.toolCallId),
				),
			),
			counts: {
				entries: ledgerModes.reduce(
					(total, modeEvidence) =>
						total + finiteNumber(modeEvidence?.agentRuntimeLedger?.counts?.entries),
					0,
				),
				promotionOperations: ledgerModes.reduce(
					(total, modeEvidence) =>
						total +
						finiteNumber(
							modeEvidence?.agentRuntimeLedger?.counts?.promotionOperations,
						),
					0,
				),
				terminalOperations: ledgerModes.reduce(
					(total, modeEvidence) =>
						total +
						finiteNumber(
							modeEvidence?.agentRuntimeLedger?.counts?.terminalOperations,
						),
					0,
				),
			},
			evidenceRefs: uniqueValues(
				modes.flatMap((modeEvidence) =>
					typeof modeEvidence?.session?.sessionId === "string"
						? [`inspection-session:${modeEvidence.session.sessionId}`]
						: [],
				),
			),
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
}) {
	const modeSet = new Set(observability.replay.modes);
	const checks = {
		installablePackageMetadata: observability.install.installable === true,
		noForbiddenWorkspaceReferences:
			observability.install.forbiddenReferences.length === 0,
		noWorkspaceProtocolReferences:
			observability.install.workspaceProtocolReferences.length === 0,
		scenarioConfig: scenarioConfigSatisfiesReleaseGate(
			scenarioConfig,
			scenario.sha256,
		),
		requiredReplayModes: REQUIRED_REPLAY_MODES.every((mode) => modeSet.has(mode)),
		transcriptEvidence: transcriptSatisfiesReleaseGate(
			transcript,
			scenario.sha256,
		),
		deterministicReplayEvidence:
			determinism?.runs === DETERMINISM_RUNS &&
			determinism?.identical === true &&
			typeof determinism?.transcriptSha256 === "string" &&
			determinism.transcriptSha256.length === 64,
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
		toolExecutionEvidence:
			modes.length > 0 &&
			modes.every((modeEvidence) =>
				REQUIRED_TOOL_EXECUTION_SPECS.every((spec) =>
					(Array.isArray(modeEvidence?.agentRuntimeLedger?.toolCallEvidence)
						? modeEvidence.agentRuntimeLedger.toolCallEvidence
						: []
					).some(
						(entry) =>
							entry?.toolName === spec.name &&
							entry?.toolCallId === spec.id &&
							entry?.completionGate === AGENT_RUNTIME_COMPLETION_GATE,
					),
				),
			),
		sessionEvidence:
			modes.length > 0 &&
			modes.every(
				(modeEvidence) =>
					typeof modeEvidence?.session?.sessionId === "string" &&
					modeEvidence.session.sessionId.length > 0 &&
					modeEvidence?.session?.containsFinalText === true &&
					modeEvidence?.session?.containsToolCallId === true &&
					modeEvidence?.session?.containsWriteToolCallId === true &&
					(!ripgrepAvailable ||
						modeEvidence?.session?.containsSearchToolCallId === true) &&
					finiteNumber(modeEvidence?.session?.jsonlFileCount) > 0,
			),
		searchEvidence: ripgrepAvailable
			? observability.tools.names.includes("search") &&
				observability.tools.callIds.includes(SEARCH_TOOL_CALL_ID) &&
				observability.tools.evidenceRefs.includes(
					`tool-call:${SEARCH_TOOL_CALL_ID}`,
				)
			: observability.replay.searchTool?.status === "skipped" &&
				observability.replay.searchTool?.reason === SEARCH_SKIP_REASON,
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
		agentRuntimeLedger:
			modes.length > 0 &&
			modes.every((modeEvidence) =>
				agentRuntimeLedgerSatisfiesReleaseGate(modeEvidence?.agentRuntimeLedger),
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
	const frameZeroStatements = [
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
	];
	if (ripgrepAvailable) {
		frameZeroStatements.push({
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
		});
	}
	const assertions = [
		{
			id: "read-tool-called",
			kind: "tool_called",
			tool: "read",
		},
	];
	if (ripgrepAvailable) {
		assertions.push({
			id: "search-tool-called",
			kind: "tool_called",
			tool: "search",
		});
	}
	assertions.push(
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
			id: "artifact-exists",
			kind: "file_exists",
			path: ARTIFACT_PATH,
		},
		{
			id: "artifact-contents",
			kind: "file_contents",
			path: ARTIFACT_PATH,
			contains: "smoke-published-replay-e2e",
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
	);
	const content = `${JSON.stringify(
		{
			schemaVersion: SCRIPTED_SCENARIO_SCHEMA,
			id: SCENARIO_ID,
			description:
				"Published package replay executed through the real agent loop: recorded read/search/write tool calls run for real in the workspace, with manifest and artifact file assertions, audit event evidence, and a final assistant response.",
			metadata: {
				recordedFrom: "smoke-published-replay-e2e",
				recordedAt: "2026-05-23T00:00:00.000Z",
				modelOriginal: "maestro-replay-v1",
				toolsExpected: REQUIRED_TOOL_EXECUTION_SPECS.map((spec) => spec.name),
				auditEvents: [AUDIT_EVENT_TYPE],
			},
			frames: [
				{
					index: 0,
					statements: frameZeroStatements,
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
			assertions,
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

function collectFiles(dir) {
	if (!existsSync(dir)) return [];
	const files = [];
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			const stats = statSync(path);
			if (stats.isDirectory()) {
				pending.push(path);
			} else if (stats.isFile()) {
				files.push(path);
			}
		}
	}
	return files;
}

function sessionIdFromEvidenceText(sessionText) {
	for (const line of sessionText.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "session" && typeof entry?.id === "string") {
				return entry.id;
			}
		} catch {
			// Ignore non-JSON fragments; the missing-session-id check below
			// reports the actionable failure with the evidence label.
		}
	}
	return "";
}

// Real session evidence: `--execute` records a session JSONL in the standard
// session store for the scenario workspace. Verify the recording carries the
// final text and every executed tool call id. When `expectedSessionId` is
// given (the json mode runs the scenario twice), the evidence is anchored to
// that specific session file while the file count still covers every
// recorded session.
function sessionEvidenceForContext(context, label, expectedSessionId = "") {
	const sessionDir = rustSessionDirForContext(context);
	let sessionFiles = collectFiles(sessionDir).filter((path) =>
		path.endsWith(".jsonl"),
	);
	if (sessionFiles.length === 0) {
		fail(`${label} did not write a session JSONL file in ${sessionDir}.`);
	}
	if (expectedSessionId) {
		const matching = sessionFiles.filter((path) =>
			readFileSync(path, "utf8").includes(`"id":"${expectedSessionId}"`),
		);
		if (matching.length === 0) {
			fail(
				`${label} did not record the execution session ${expectedSessionId} in ${sessionDir}.`,
			);
		}
		sessionFiles = matching;
	}
	const sessionText = sessionFiles
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
	const requiredFragments = [FINAL_TEXT, TOOL_CALL_ID, WRITE_TOOL_CALL_ID];
	if (ripgrepAvailable) {
		requiredFragments.push(SEARCH_TOOL_CALL_ID);
	}
	for (const fragment of requiredFragments) {
		if (!sessionText.includes(fragment)) {
			fail(`${label} session evidence is missing "${fragment}".`);
		}
	}
	const sessionId = sessionIdFromEvidenceText(sessionText);
	if (!sessionId) {
		fail(`${label} session evidence is missing a session header id.`);
	}
	if (expectedSessionId && sessionId !== expectedSessionId) {
		fail(
			`${label} session id ${sessionId} did not match the execution session ${expectedSessionId}.`,
		);
	}
	return {
		sessionId,
		jsonlFileCount: sessionFiles.length,
		bytes: Buffer.byteLength(sessionText),
		sha256: sha256(sessionText),
		containsFinalText: true,
		containsToolCallId: true,
		containsSearchToolCallId: ripgrepAvailable,
		containsWriteToolCallId: true,
	};
}

// AgentRuntime evidence: reconstruct the *real* replay session with the
// published binary's own `run inspect` and require the completion-gated
// ledger operations, tool_call evidence refs, and durable idempotent
// promotion summary.
function agentRuntimeLedgerForSession(binPath, context, sessionId, label) {
	const result = spawnSync(binPath, ["run", "inspect", sessionId, "--json"], {
		cwd: context.runDir,
		encoding: "utf8",
		env: context.env,
		timeout: timeoutMs,
	});
	if (result.error) {
		fail(`${label} AgentRuntime ledger inspection failed to launch.`, result.error.stack);
	}
	if (result.status !== 0) {
		fail(
			`${label} AgentRuntime ledger inspection exited with ${result.status}.`,
			[result.stdout, result.stderr].filter(Boolean).join("\n\n"),
		);
	}
	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch (error) {
		fail(
			`${label} AgentRuntime ledger inspection did not emit JSON.`,
			`${result.stdout}\n${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const ledger = report?.agentRuntimeLedger;
	if (ledger?.schemaVersion !== AGENT_RUNTIME_LEDGER_SCHEMA) {
		fail(`${label} AgentRuntime ledger schema was not emitted.`);
	}
	const durability = report?.durability;
	if (durability?.reconstructable !== true) {
		fail(`${label} run inspection did not prove reconstructable durability.`);
	}
	if (durability?.replayDeterministic !== true) {
		fail(`${label} run inspection did not carry deterministic replay durability.`);
	}
	if (durability?.agentRuntimeLedgerEntries !== ledger?.counts?.entries) {
		fail(`${label} durability summary did not match AgentRuntime ledger entries.`);
	}
	if (typeof durability?.promotionIdempotencyKey !== "string") {
		fail(`${label} durability summary is missing the promotion idempotency key.`);
	}
	if (ledger?.replay?.deterministic !== true) {
		fail(`${label} AgentRuntime ledger replay was not deterministic.`);
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
		fail(`${label} AgentRuntime promotion plan is missing required operations.`);
	}
	const workItems = operations.filter(
		(operation) => operation?.operation === "record_run_work_item",
	);
	for (const workItem of workItems) {
		if (workItem?.payload?.completionGate !== AGENT_RUNTIME_COMPLETION_GATE) {
			fail(`${label} AgentRuntime work item is missing the completion gate.`);
		}
	}
	const runSteps = operations.filter(
		(operation) => operation?.operation === "record_run_step",
	);
	const toolCallEvidence = REQUIRED_TOOL_EXECUTION_SPECS.map((spec) => {
		const workItem = workItems.find((candidate) =>
			Array.isArray(candidate?.payload?.evidenceRefs)
				? candidate.payload.evidenceRefs.some(
						(ref) => ref?.kind === "tool_call" && ref?.id === spec.id,
					)
				: false,
		);
		if (!workItem) {
			fail(`${label} AgentRuntime ledger is missing tool_call evidence for ${spec.id}.`);
		}
		const runStep = runSteps.find(
		(candidate) => candidate?.ledgerEntryId === workItem?.ledgerEntryId,
		);
		return {
			toolName:
				typeof runStep?.payload?.toolName === "string"
					? runStep.payload.toolName
					: spec.name,
			toolCallId: spec.id,
			completionGate: workItem?.payload?.completionGate,
			evidenceKinds: uniqueValues(
				(Array.isArray(workItem?.payload?.evidenceRefs)
					? workItem.payload.evidenceRefs
					: []
				).map((ref) => ref?.kind),
			),
		};
	});
	return {
		schemaVersion: ledger.schemaVersion,
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
	};
}

function spawnScenarioRun(binPath, context, extraArgs, label) {
	const result = spawnSync(
		binPath,
		["scenario", "run", context.scenario.path, "--execute", ...extraArgs],
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
	const evidence = {
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
			source: "execution",
		},
		output,
	};
	if (ripgrepAvailable) {
		evidence.searchTool = {
			name: "search",
			callId: SEARCH_TOOL_CALL_ID,
			inputPath: "package.json",
			resultStatus: "success",
			assertionId: "search-tool-called",
		};
	}
	return evidence;
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
						(entry) =>
							entry?.kind === "tool_execution" && entry?.id === spec.id,
					)
				: false,
		);
		if (!assertion) {
			fail(
				`${label} is missing real tool-execution assertion evidence for ${spec.id}.`,
			);
		}
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
	const execution = result?.execution;
	if (!execution || typeof execution !== "object") {
		fail(`${label} did not emit the execution evidence block.`);
	}
	if (
		execution.provider !== "scripted-replay" ||
		execution.approvalMode !== SCRIPTED_REPLAY_APPROVAL_MODE ||
		execution.deterministic !== true
	) {
		fail(`${label} execution block has unexpected provider configuration.`);
	}
	if (execution.finalText !== FINAL_TEXT) {
		fail(`${label} execution final text did not match the scenario frame.`);
	}
	for (const spec of REQUIRED_TOOL_EXECUTION_SPECS) {
		const toolExecution = Array.isArray(execution.toolExecutions)
			? execution.toolExecutions.find(
					(entry) => entry?.callId === spec.id && entry?.tool === spec.name,
				)
			: undefined;
		if (toolExecution?.success !== true) {
			fail(`${label} execution block is missing a successful ${spec.name} execution.`);
		}
	}
	if (
		typeof execution.sessionId !== "string" ||
		execution.sessionId.length === 0 ||
		typeof execution.sessionPath !== "string" ||
		execution.sessionPath.length === 0 ||
		typeof execution.transcriptSha256 !== "string" ||
		execution.transcriptSha256.length !== 64
	) {
		fail(`${label} execution block is missing session or transcript evidence.`);
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
			`Scripted scenario ${SCENARIO_ID} \\(executed in agent loop\\): ${REQUIRED_ASSERTION_IDS.length}/${REQUIRED_ASSERTION_IDS.length} passed, 0 failed`,
		);
		if (!summaryPattern.test(stdout)) {
			fail(`${label} did not print the scenario pass summary.`, stdout);
		}
		for (const assertionId of REQUIRED_ASSERTION_IDS) {
			if (!stdout.includes(`PASS ${assertionId}`)) {
				fail(`${label} did not print a PASS line for ${assertionId}.`, stdout);
			}
		}
		const session = sessionEvidenceForContext(context, label);
		const agentRuntimeLedger = agentRuntimeLedgerForSession(
			binPath,
			context,
			session.sessionId,
			label,
		);
		console.log("Published text replay smoke passed.");
		const evidence = baseModeEvidence("text", context, {
			bytes: Buffer.byteLength(stdout),
			sha256: sha256(stdout),
			containsSummary: true,
		});
		evidence.session = session;
		evidence.agentRuntimeLedger = agentRuntimeLedger;
		return evidence;
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function runJsonMode(binPath) {
	const label = "Published JSON replay";
	const context = createRunContext("replay-json");
	try {
		const outputs = [];
		const results = [];
		for (let run = 0; run < DETERMINISM_RUNS; run += 1) {
			const runResult = spawnScenarioRun(binPath, context, ["--json"], label);
			outputs.push(runResult.stdout ?? "");
			results.push(
				assertScenarioResult(
					parseScenarioResult(runResult.stdout ?? "", label),
					context,
					label,
				),
			);
		}
		const transcriptHashes = results.map(
			(result) => result.execution.transcriptSha256,
		);
		const identical = transcriptHashes.every((hash) => hash === transcriptHashes[0]);
		if (!identical) {
			fail(
				`${label} was not deterministic across ${DETERMINISM_RUNS} runs.`,
				transcriptHashes.join("\n"),
			);
		}
		const scenarioResult = results[0];
		const session = sessionEvidenceForContext(
			context,
			label,
			scenarioResult.execution.sessionId,
		);
		const agentRuntimeLedger = agentRuntimeLedgerForSession(
			binPath,
			context,
			scenarioResult.execution.sessionId,
			label,
		);
		const evidence = baseModeEvidence("json", context, {
			bytes: Buffer.byteLength(outputs[0]),
			sha256: sha256(outputs[0]),
		});
		evidence.session = session;
		evidence.agentRuntimeLedger = agentRuntimeLedger;
		evidence.result = {
			schemaVersion: scenarioResult.schemaVersion,
			observedOutcome: scenarioResult.scenario.observedOutcome,
			assertionsPassed: finiteNumber(scenarioResult.counts?.passed),
			assertionsFailed: finiteNumber(scenarioResult.counts?.failed),
		};
		evidence.execution = {
			sessionId: scenarioResult.execution.sessionId,
			sessionPath: scenarioResult.execution.sessionPath,
			workspace: scenarioResult.execution.workspace,
			toolExecutions: scenarioResult.execution.toolExecutions,
			finalText: scenarioResult.execution.finalText,
			transcriptSha256: scenarioResult.execution.transcriptSha256,
		};
		evidence.determinism = {
			runs: DETERMINISM_RUNS,
			identical: true,
			transcriptSha256: scenarioResult.execution.transcriptSha256,
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
		const session = sessionEvidenceForContext(context, label);
		const agentRuntimeLedger = agentRuntimeLedgerForSession(
			binPath,
			context,
			session.sessionId,
			label,
		);
		console.log("Published JUnit replay smoke passed.");
		const evidence = baseModeEvidence("junit", context, {
			bytes: Buffer.byteLength(junit),
			sha256: sha256(junit),
		});
		evidence.session = session;
		evidence.agentRuntimeLedger = agentRuntimeLedger;
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
}) {
	const resolvedInstaller = inferPublishedInstaller({ installer, installMetadata });
	const scenarioConfig = {
		runner: "maestro scenario run --execute",
		scenarioSchemaVersion: SCRIPTED_SCENARIO_SCHEMA,
		scenarioId: scenario.id,
		scenarioSha256: scenario.sha256,
		deterministic: true,
		externalCredentialsRequired: false,
		externalNetworkRequired: false,
		toolAllowlist: REQUIRED_TOOL_EXECUTION_SPECS.map((spec) => spec.name),
		approvalMode: SCRIPTED_REPLAY_APPROVAL_MODE,
		sandboxMode: replaySandboxMode,
		searchTool: ripgrepAvailable
			? { status: "executed" }
			: { status: "skipped", reason: SEARCH_SKIP_REASON },
	};
	const transcript = buildPublishedReplayTranscript({ modes, scenario });
	const observability = buildPublishedReplayObservability({
		installMetadata,
		modes,
		scenario,
		scenarioConfig,
		transcript,
		scenarioResult,
	});
	const releaseGate = buildPublishedReplayReleaseGate({
		observability,
		modes,
		scenario,
		scenarioConfig,
		transcript,
		determinism,
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
			runner: "maestro scenario run --execute",
			scenarioSchemaVersion: SCRIPTED_SCENARIO_SCHEMA,
			scenario: {
				id: scenario.id,
				schemaVersion: scenario.schemaVersion,
				sha256: scenario.sha256,
			},
			sandboxMode: replaySandboxMode,
			scenarioConfig: cloneJson(scenarioConfig),
			searchTool: ripgrepAvailable
				? { status: "executed" }
				: { status: "skipped", reason: SEARCH_SKIP_REASON },
			determinism: cloneJson(determinism),
			expected: {
				toolName: "read",
				toolCallId: TOOL_CALL_ID,
				toolInputPath: "package.json",
				searchToolName: "search",
				searchToolCallId: SEARCH_TOOL_CALL_ID,
				searchToolInputPath: "package.json",
				searchEngine: "ripgrep",
				writeToolName: "write",
				writeToolCallId: WRITE_TOOL_CALL_ID,
				writeToolInputPath: ARTIFACT_PATH,
				finalTextSha256: sha256(FINAL_TEXT),
			},
		},
		transcript,
		observability,
		releaseGate,
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
	if (!ripgrepAvailable) {
		console.log(
			`ripgrep (rg) not found on PATH; recording the search leg as skipped (${SEARCH_SKIP_REASON}).`,
		);
	}

	const binPath = installedBinPath(installRoot, cliCommand);
	const modes = [];
	modes.push(runTextMode(binPath));
	const { evidence: jsonModeEvidence, scenarioResult } = runJsonMode(binPath);
	modes.push(jsonModeEvidence);
	modes.push(runJunitMode(binPath));
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
