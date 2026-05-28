#!/usr/bin/env node
// @ts-check

import { spawn, spawnSync } from "node:child_process";
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
import { basename, dirname, join, resolve } from "node:path";
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
import {
	getWorkspacePackages,
	loadRootPackage,
} from "./workspace-utils.js";
import { assertPublishedReplayReleaseGate } from "./published-replay-evidence-gate.js";

export { assertPublishedReplayReleaseGate };

const SCRIPTED_SCENARIO_SCHEMA = "evalops.maestro.scripted-scenario.v1";
const PUBLISHED_REPLAY_EVIDENCE_SCHEMA =
	"evalops.maestro.published-replay-evidence.v1";
const PUBLISHED_REPLAY_TRANSCRIPT_SCHEMA =
	"evalops.maestro.published-replay-transcript.v1";
const AGENT_RUNTIME_LIFECYCLE_SCHEMA =
	"evalops.maestro.agent-runtime-lifecycle.v1";
const SCRIPTED_REPLAY_PROVIDER = "scripted-replay";
const SCRIPTED_REPLAY_MODEL = "maestro-replay-v1";
const SCRIPTED_REPLAY_TOOL_ALLOWLIST = ["read", "search", "write"];
const SCRIPTED_REPLAY_APPROVAL_MODE = "auto";
const FINAL_TEXT =
	"Published package golden path completed with manifest evidence.";
const TOOL_CALL_ID = "call-read-package-json";
const SEARCH_TOOL_CALL_ID = "call-search-package-manifest";
const WRITE_TOOL_CALL_ID = "call-write-published-artifact";
const REQUIRED_TOOL_EXECUTION_SPECS = [
	{ id: TOOL_CALL_ID, name: "read" },
	{ id: SEARCH_TOOL_CALL_ID, name: "search" },
	{ id: WRITE_TOOL_CALL_ID, name: "write" },
];
const ARTIFACT_PATH = "published-replay-artifact.json";
const ARTIFACT_TEXT = JSON.stringify({
	source: "smoke-published-replay-e2e",
	manifest: "package.json",
});
const SEARCH_PATTERN = "maestro-published";
const PROMPT_TEXT = "Replay the published package golden path.";
const REQUIRED_REPLAY_MODES = ["text", "json", "rpc"];
const REQUIRED_OBSERVABILITY_QUERY_TRACES = [
	"install",
	"session",
	"tool",
	"search",
	"approval",
	"error",
	"artifact",
	"agent-runtime-lifecycle",
	"final-status",
];
const REQUIRED_AGENT_RUNTIME_WAIT_KINDS = ["approval", "tool_retry"];
const TERMINAL_AGENT_RUNTIME_STATES = new Set([
	"succeeded",
	"failed",
	"cancelled",
	"canceled",
]);
const PUBLISHED_REPLAY_EVIDENCE_REF_PREFIXES = [
	"tool-call:",
	"tool-execution:",
	"approval-request:",
	"pending-request:",
	"artifact:",
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
// Hosted Linux release runners do not always expose Maestro's native sandbox.
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

function inferPublishedInstaller({ installer, installMetadata }) {
	const normalizedInstaller =
		typeof installer === "string" ? installer.trim().toLowerCase() : "";
	if (normalizedInstaller) {
		return normalizedInstaller;
	}
	const label =
		typeof installMetadata?.label === "string" ? installMetadata.label : "";
	if (/\bvia Bun\b/.test(label)) {
		return "bun";
	}
	if (/\bvia npm\b/.test(label)) {
		return "npm";
	}
	return "local";
}

function installLabelForInstaller({ packageSpec, installer }) {
	const normalizedInstaller =
		typeof installer === "string" ? installer.trim().toLowerCase() : "";
	const suffix =
		normalizedInstaller === "bun"
			? "via Bun"
			: normalizedInstaller === "npm"
				? "via npm"
				: "published replay install";
	return `${packageSpec} ${suffix}`;
}

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function terminalOutcomesSatisfyReleaseGate(outcomes) {
	const terminalStates =
		outcomes?.terminalStates &&
		typeof outcomes.terminalStates === "object" &&
		!Array.isArray(outcomes.terminalStates)
			? Object.entries(outcomes.terminalStates)
			: [];
	const terminalEventTypes = Array.isArray(outcomes?.terminalEventTypes)
		? outcomes.terminalEventTypes
		: [];
	return (
		terminalStates.some(
			([state, count]) =>
				TERMINAL_AGENT_RUNTIME_STATES.has(state) &&
				typeof count === "number" &&
				Number.isFinite(count) &&
				count > 0,
		) &&
		terminalEventTypes.some(
			(eventType) => typeof eventType === "string" && eventType.length > 0,
		)
	);
}

function addCountMap(target, source) {
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		return;
	}
	for (const [key, value] of Object.entries(source)) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			continue;
		}
		target[key] = (target[key] ?? 0) + value;
	}
}

function modeName(modeEvidence) {
	return typeof modeEvidence?.mode === "string" ? modeEvidence.mode : "unknown";
}

function toolWorkItemsForMode(modeEvidence) {
	const ledger = modeEvidence?.agentRuntimeLedger;
	if (!ledger || typeof ledger !== "object") {
		return [];
	}
	if (Array.isArray(ledger.toolWorkItems)) {
		return ledger.toolWorkItems.filter(
			(item) => item && typeof item === "object",
		);
	}
	return ledger.toolWorkItem && typeof ledger.toolWorkItem === "object"
		? [ledger.toolWorkItem]
		: [];
}

function toolWorkItemForMode(modeEvidence, { toolName, toolCallId }) {
	return toolWorkItemsForMode(modeEvidence).find(
		(item) =>
			item?.toolName === toolName &&
			(!toolCallId ||
				item?.toolCallId === toolCallId ||
				filterPublishedReplayEvidenceRefs(item?.evidenceRefs).includes(
					`tool-call:${toolCallId}`,
				)),
	);
}

export function filterPublishedReplayEvidenceRefs(refs) {
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

function evidenceRefsForMode(modeEvidence) {
	return uniqueValues(
		toolWorkItemsForMode(modeEvidence).flatMap((item) =>
			filterPublishedReplayEvidenceRefs(item?.evidenceRefs),
		),
	);
}

function toolExecutionRefsForWorkItem(workItem) {
	return filterPublishedReplayEvidenceRefs(workItem?.evidenceRefs).filter((ref) =>
		ref.startsWith("tool-execution:"),
	);
}

function buildToolExecutionCoverage(modes) {
	const refsByCallId = Object.fromEntries(
		REQUIRED_TOOL_EXECUTION_SPECS.map((toolSpec) => [toolSpec.id, []]),
	);
	const modesByCallId = Object.fromEntries(
		REQUIRED_TOOL_EXECUTION_SPECS.map((toolSpec) => [toolSpec.id, []]),
	);

	for (const modeEvidence of modes) {
		for (const toolSpec of REQUIRED_TOOL_EXECUTION_SPECS) {
			const workItem = toolWorkItemForMode(modeEvidence, {
				toolName: toolSpec.name,
				toolCallId: toolSpec.id,
			});
			const refs = toolExecutionRefsForWorkItem(workItem);
			if (refs.length === 0) {
				continue;
			}
			refsByCallId[toolSpec.id].push(...refs);
			modesByCallId[toolSpec.id].push(modeName(modeEvidence));
		}
	}

	return {
		refs: uniqueValues(Object.values(refsByCallId).flat()),
		refsByCallId: Object.fromEntries(
			Object.entries(refsByCallId).map(([callId, refs]) => [
				callId,
				uniqueValues(refs),
			]),
		),
		modesByCallId: Object.fromEntries(
			Object.entries(modesByCallId).map(([callId, modeNames]) => [
				callId,
				uniqueValues(modeNames),
			]),
		),
	};
}

function toolExecutionCoverageSatisfiesReleaseGate(coverage) {
	return REQUIRED_TOOL_EXECUTION_SPECS.every((toolSpec) => {
		const refs = Array.isArray(coverage?.toolExecutionRefsByCallId?.[toolSpec.id])
			? coverage.toolExecutionRefsByCallId[toolSpec.id]
			: [];
		const modes = Array.isArray(
			coverage?.toolExecutionModesByCallId?.[toolSpec.id],
		)
			? coverage.toolExecutionModesByCallId[toolSpec.id]
			: [];
		return refs.length > 0 && includesRequiredModes(modes);
	});
}

function replayModesHaveToolExecutionRefs(modes) {
	return (
		modes.length > 0 &&
		modes.every((modeEvidence) =>
			REQUIRED_TOOL_EXECUTION_SPECS.every((toolSpec) => {
				const workItem = toolWorkItemForMode(modeEvidence, {
					toolName: toolSpec.name,
					toolCallId: toolSpec.id,
				});
				return toolExecutionRefsForWorkItem(workItem).length > 0;
			}),
		)
	);
}

function modesWithEvidenceRefPrefix(modes, prefix) {
	return uniqueValues(
		modes
			.filter((modeEvidence) =>
				evidenceRefsForMode(modeEvidence).some((ref) => ref.startsWith(prefix)),
			)
			.map(modeName),
	);
}

function buildAgentRuntimeLedgerObservability(modes) {
	const counts = {
		entries: 0,
		promotionOperations: 0,
		byKind: {},
		byState: {},
	};
	const operations = {
		handleTrigger: 0,
		recordRunStep: 0,
		recordRunWorkItem: 0,
		terminal: 0,
	};
	const ledgerModes = [];
	const replayDeterministicModes = [];
	const durabilityModes = [];
	const promotionIdempotencyKeys = [];

	for (const modeEvidence of modes) {
		const ledger = modeEvidence?.agentRuntimeLedger;
		if (!ledger || typeof ledger !== "object") {
			continue;
		}
		const currentMode = modeName(modeEvidence);
		ledgerModes.push(currentMode);
		counts.entries += finiteNumber(ledger.counts?.entries ?? ledger.entries);
		counts.promotionOperations += finiteNumber(
			ledger.counts?.promotionOperations ?? ledger.promotionOperations,
		);
		addCountMap(counts.byKind, ledger.counts?.byKind);
		addCountMap(counts.byState, ledger.counts?.byState);

		if (ledger.hasHandleTrigger === true) operations.handleTrigger += 1;
		if (ledger.hasRecordRunStep === true) operations.recordRunStep += 1;
		if (ledger.hasRecordRunWorkItem === true) operations.recordRunWorkItem += 1;
		if (ledger.hasTerminalOperation === true) operations.terminal += 1;
		if (ledger.replayDeterministic === true) {
			replayDeterministicModes.push(currentMode);
		}
		if (
			ledger.durability?.reconstructable === true &&
			ledger.durability?.replayDeterministic === true &&
			typeof ledger.durability?.promotionIdempotencyKey === "string"
		) {
			durabilityModes.push(currentMode);
			promotionIdempotencyKeys.push(ledger.durability.promotionIdempotencyKey);
		}
	}

	return {
		modes: uniqueValues(ledgerModes),
		replayDeterministicModes: uniqueValues(replayDeterministicModes),
		durabilityModes: uniqueValues(durabilityModes),
		promotionIdempotencyKeys: uniqueValues(promotionIdempotencyKeys),
		counts,
		operations,
	};
}

function normalizeAgentRuntimeLifecycle(lifecycle) {
	const waits = Array.isArray(lifecycle?.waits)
		? lifecycle.waits.filter((wait) => wait && typeof wait === "object")
		: [];
	const evidenceRefs = uniqueValues(
		waits.flatMap((wait) =>
			Array.isArray(wait?.evidenceRefs)
				? wait.evidenceRefs.filter((ref) => typeof ref === "string")
				: [],
		),
	);
	return {
		schemaVersion:
			typeof lifecycle?.schemaVersion === "string"
				? lifecycle.schemaVersion
				: AGENT_RUNTIME_LIFECYCLE_SCHEMA,
		sessionId: typeof lifecycle?.sessionId === "string" ? lifecycle.sessionId : "",
		replayDeterministic: lifecycle?.replayDeterministic === true,
		counts: {
			entries: finiteNumber(lifecycle?.counts?.entries),
			promotionOperations: finiteNumber(
				lifecycle?.counts?.promotionOperations,
			),
			waits: finiteNumber(lifecycle?.counts?.waits),
			approvalWaits: finiteNumber(lifecycle?.counts?.approvalWaits),
			toolRetryWaits: finiteNumber(lifecycle?.counts?.toolRetryWaits),
			terminalOperations: finiteNumber(
				lifecycle?.counts?.terminalOperations,
			),
		},
		operations: {
			handleTrigger: finiteNumber(lifecycle?.operations?.handleTrigger),
			recordRunStep: finiteNumber(lifecycle?.operations?.recordRunStep),
			recordRunWorkItem: finiteNumber(
				lifecycle?.operations?.recordRunWorkItem,
			),
			waitRun: finiteNumber(lifecycle?.operations?.waitRun),
			terminal: finiteNumber(lifecycle?.operations?.terminal),
			completeRun: finiteNumber(lifecycle?.operations?.completeRun),
			failRun: finiteNumber(lifecycle?.operations?.failRun),
		},
		waits,
		waitKinds: uniqueValues(waits.map((wait) => wait?.pendingRequestKind)),
		evidenceRefs,
		outcomes:
			lifecycle?.outcomes && typeof lifecycle.outcomes === "object"
				? cloneJson(lifecycle.outcomes)
				: { terminalStates: {}, terminalEventTypes: [] },
		durability:
			lifecycle?.durability && typeof lifecycle.durability === "object"
				? cloneJson(lifecycle.durability)
				: {},
	};
}

function agentRuntimeLifecycleSatisfiesReleaseGate(lifecycle) {
	const normalized = normalizeAgentRuntimeLifecycle(lifecycle);
	return (
		normalized.schemaVersion === AGENT_RUNTIME_LIFECYCLE_SCHEMA &&
		normalized.replayDeterministic === true &&
		normalized.sessionId.length > 0 &&
		REQUIRED_AGENT_RUNTIME_WAIT_KINDS.every((kind) =>
			normalized.waitKinds.includes(kind),
		) &&
		normalized.operations.waitRun >= REQUIRED_AGENT_RUNTIME_WAIT_KINDS.length &&
		normalized.operations.recordRunStep > 0 &&
		normalized.operations.recordRunWorkItem > 0 &&
		normalized.operations.terminal > 0 &&
		normalized.operations.completeRun > 0 &&
		normalized.counts.waits >= REQUIRED_AGENT_RUNTIME_WAIT_KINDS.length &&
		normalized.counts.approvalWaits > 0 &&
		normalized.counts.toolRetryWaits > 0 &&
		normalized.counts.terminalOperations > 0 &&
		terminalOutcomesSatisfyReleaseGate(normalized.outcomes) &&
		normalized.durability?.reconstructable === true &&
		normalized.durability?.replayDeterministic === true &&
		typeof normalized.durability?.promotionIdempotencyKey === "string" &&
		normalized.waits.every(
			(wait) =>
				typeof wait?.pendingRequestId === "string" &&
				typeof wait?.pendingRequestKind === "string" &&
				typeof wait?.waitType === "string" &&
				Array.isArray(wait?.evidenceRefs) &&
				wait.evidenceRefs.some((ref) => ref.startsWith("pending-request:")),
		)
	);
}

function buildPublishedReplayProviderConfig() {
	return {
		provider: SCRIPTED_REPLAY_PROVIDER,
		model: SCRIPTED_REPLAY_MODEL,
		api: "scripted-replay",
		deterministic: true,
		externalCredentialsRequired: false,
		externalNetworkRequired: false,
		credentialSources: [],
		toolAllowlist: [...SCRIPTED_REPLAY_TOOL_ALLOWLIST],
		approvalMode: SCRIPTED_REPLAY_APPROVAL_MODE,
		sandboxMode: replaySandboxMode,
		scenarioSchemaVersion: SCRIPTED_SCENARIO_SCHEMA,
		prompt: {
			length: PROMPT_TEXT.length,
			sha256: sha256(PROMPT_TEXT),
		},
	};
}

function transcriptToolCallForMode(modeEvidence, toolSpec) {
	const workItem = toolWorkItemForMode(modeEvidence, {
		toolName: toolSpec.name,
		toolCallId: toolSpec.id,
	});
	const explicitTool = toolSpec.explicitTool;
	if (!workItem && !explicitTool) {
		return null;
	}
	const evidenceRefs = filterPublishedReplayEvidenceRefs(workItem?.evidenceRefs);
	return {
		id:
			typeof explicitTool?.callId === "string"
				? explicitTool.callId
				: workItem?.toolCallId || toolSpec.id,
		name:
			typeof explicitTool?.name === "string"
				? explicitTool.name
				: workItem?.toolName || toolSpec.name,
		inputPath:
			typeof explicitTool?.inputPath === "string"
				? explicitTool.inputPath
				: toolSpec.inputPath,
		resultStatus:
			typeof explicitTool?.resultStatus === "string"
				? explicitTool.resultStatus
				: workItem
					? "success"
					: "unknown",
		evidenceRefs,
		completionGate:
			typeof workItem?.completionGate === "string"
				? workItem.completionGate
				: undefined,
	};
}

function toolEvidenceForMode(modeEvidence) {
	return [modeEvidence?.tool, modeEvidence?.searchTool, modeEvidence?.artifactTool]
		.filter((tool) => tool && typeof tool === "object");
}

function buildPublishedReplayTranscript({ modes }) {
	const promptSha256 = sha256(PROMPT_TEXT);
	const transcriptModes = modes.map((modeEvidence) => {
		const toolCalls = [
			transcriptToolCallForMode(modeEvidence, {
				id: TOOL_CALL_ID,
				name: "read",
				inputPath: "package.json",
				explicitTool: modeEvidence?.tool,
			}),
			transcriptToolCallForMode(modeEvidence, {
				id: SEARCH_TOOL_CALL_ID,
				name: "search",
				inputPath: "package.json",
				explicitTool: modeEvidence?.searchTool,
			}),
			transcriptToolCallForMode(modeEvidence, {
				id: WRITE_TOOL_CALL_ID,
				name: "write",
				inputPath: ARTIFACT_PATH,
				explicitTool: modeEvidence?.artifactTool,
			}),
		].filter(Boolean);
		return {
			mode: modeName(modeEvidence),
			provider: modeEvidence?.provider ?? SCRIPTED_REPLAY_PROVIDER,
			promptSha256,
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
				stateSha256:
					typeof modeEvidence?.final?.stateSha256 === "string"
						? modeEvidence.final.stateSha256
						: undefined,
				containsExpectedText:
					modeEvidence?.final?.containsExpectedText === true,
			},
		};
	});
	return {
		schemaVersion: PUBLISHED_REPLAY_TRANSCRIPT_SCHEMA,
		prompt: {
			length: PROMPT_TEXT.length,
			sha256: promptSha256,
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
			transcript?.coverage?.finalStatus && typeof transcript.coverage.finalStatus === "object"
				? transcript.coverage.finalStatus
				: countBy(modes.map((mode) => mode?.final?.status)),
		promptSha256:
			typeof transcript?.prompt?.sha256 === "string"
				? transcript.prompt.sha256
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
			ids: Object.keys(observability.sessions.sha256ByMode),
			counts: {
				jsonlFileCount: observability.sessions.jsonlFileCount,
				bytes: observability.sessions.bytes,
			},
		}),
		queryIndexEntry({
			key: "tools",
			traceType: "tool",
			status:
				["read", "search", "write"].every((name) =>
					observability.tools.names.includes(name),
				) &&
				[TOOL_CALL_ID, SEARCH_TOOL_CALL_ID, WRITE_TOOL_CALL_ID].every((id) =>
					observability.tools.callIds.includes(id),
				) &&
				toolExecutionCoverageSatisfiesReleaseGate(observability.tools)
					? "ok"
					: "failed",
			modes: observability.replay.modes,
			evidenceRefs: observability.tools.evidenceRefs,
			ids: observability.tools.callIds,
			counts: observability.tools.resultStatus,
		}),
		queryIndexEntry({
			key: "search",
			traceType: "search",
			status:
				observability.search.engine === "ripgrep" &&
				observability.search.callId === SEARCH_TOOL_CALL_ID &&
				includesRequiredModes(observability.search.modes)
					? "ok"
					: "failed",
			modes: observability.search.modes,
			evidenceRefs: observability.search.evidenceRefs,
			ids: [observability.search.callId],
			counts: {
				modes: observability.search.modes.length,
			},
		}),
		queryIndexEntry({
			key: "approvals",
			traceType: "approval",
			status: includesRequiredModes(observability.approvals.modes)
				? "ok"
				: "failed",
			modes: observability.approvals.modes,
			evidenceRefs: observability.approvals.evidenceRefs,
			counts: { count: observability.approvals.count },
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
			key: "artifacts",
			traceType: "artifact",
			status: includesRequiredModes(observability.artifacts.modes)
				? "ok"
				: "failed",
			modes: observability.artifacts.modes,
			evidenceRefs: observability.artifacts.evidenceRefs,
			counts: { count: observability.artifacts.count },
		}),
		queryIndexEntry({
			key: "agentRuntimeLifecycle",
			traceType: "agent-runtime-lifecycle",
			status: agentRuntimeLifecycleSatisfiesReleaseGate(
				observability.agentRuntimeLifecycle,
			)
				? "ok"
				: "failed",
			evidenceRefs: observability.agentRuntimeLifecycle.evidenceRefs,
			ids: observability.agentRuntimeLifecycle.waits.map(
				(wait) => wait?.pendingRequestId,
			),
			counts: {
				waits: observability.agentRuntimeLifecycle.counts.waits,
				approvalWaits:
					observability.agentRuntimeLifecycle.counts.approvalWaits,
				toolRetryWaits:
					observability.agentRuntimeLifecycle.counts.toolRetryWaits,
				terminalOperations:
					observability.agentRuntimeLifecycle.counts.terminalOperations,
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
					entry?.status === "ok",
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
	const toolRefs = Array.isArray(toolEntry?.evidenceRefs)
		? toolEntry.evidenceRefs
		: [];
	const searchRefs = Array.isArray(searchEntry?.evidenceRefs)
		? searchEntry.evidenceRefs
		: [];
	const approvalRefs = Array.isArray(approvalEntry?.evidenceRefs)
		? approvalEntry.evidenceRefs
		: [];
	const artifactRefs = Array.isArray(artifactEntry?.evidenceRefs)
		? artifactEntry.evidenceRefs
		: [];
	const lifecycleRefs = Array.isArray(lifecycleEntry?.evidenceRefs)
		? lifecycleEntry.evidenceRefs
		: [];

	return (
		installEntry?.counts?.forbiddenReferences === 0 &&
		installEntry?.counts?.workspaceProtocolReferences === 0 &&
		includesRequiredModes(sessionEntry?.modes) &&
		finiteNumber(sessionEntry?.counts?.jsonlFileCount) >=
			REQUIRED_REPLAY_MODES.length &&
		includesRequiredModes(toolEntry?.modes) &&
		[TOOL_CALL_ID, SEARCH_TOOL_CALL_ID, WRITE_TOOL_CALL_ID].every((id) =>
			toolEntry?.ids?.includes?.(id),
		) &&
		[TOOL_CALL_ID, SEARCH_TOOL_CALL_ID, WRITE_TOOL_CALL_ID].every((id) =>
			toolRefs.includes(`tool-call:${id}`),
		) &&
		toolExecutionCoverageSatisfiesReleaseGate(observability.tools) &&
		includesRequiredModes(searchEntry?.modes) &&
		searchEntry?.ids?.includes?.(SEARCH_TOOL_CALL_ID) &&
		searchRefs.includes(`tool-call:${SEARCH_TOOL_CALL_ID}`) &&
		includesRequiredModes(approvalEntry?.modes) &&
		approvalRefs.length > 0 &&
		approvalRefs.every((ref) => ref.startsWith("approval-request:")) &&
		errorEntry?.counts?.count === 0 &&
		errorEntry?.counts?.expectedCount === 0 &&
		includesRequiredModes(artifactEntry?.modes) &&
		artifactRefs.length > 0 &&
		artifactRefs.every((ref) => ref.startsWith("artifact:")) &&
		lifecycleEntry?.status === "ok" &&
		lifecycleRefs.some((ref) => ref.startsWith("pending-request:")) &&
		agentRuntimeLifecycleSatisfiesReleaseGate(
			observability.agentRuntimeLifecycle,
		) &&
		includesRequiredModes(finalStatusEntry?.modes) &&
		finalStatusEntry?.counts?.ok === REQUIRED_REPLAY_MODES.length
	);
}

function providerConfigSatisfiesReleaseGate(providerConfig) {
	return (
		providerConfig?.provider === SCRIPTED_REPLAY_PROVIDER &&
		providerConfig?.model === SCRIPTED_REPLAY_MODEL &&
		providerConfig?.deterministic === true &&
		providerConfig?.externalCredentialsRequired === false &&
		providerConfig?.externalNetworkRequired === false &&
		Array.isArray(providerConfig?.toolAllowlist) &&
		SCRIPTED_REPLAY_TOOL_ALLOWLIST.every((toolName) =>
			providerConfig.toolAllowlist.includes(toolName),
		) &&
		providerConfig?.approvalMode === SCRIPTED_REPLAY_APPROVAL_MODE &&
		typeof providerConfig?.sandboxMode === "string" &&
		providerConfig.sandboxMode.length > 0
	);
}

function transcriptSatisfiesReleaseGate(transcript) {
	if (
		transcript?.schemaVersion !== PUBLISHED_REPLAY_TRANSCRIPT_SCHEMA ||
		transcript?.prompt?.sha256 !== sha256(PROMPT_TEXT) ||
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
		!coverageToolCallIds.has(TOOL_CALL_ID) ||
		!coverageToolCallIds.has(SEARCH_TOOL_CALL_ID) ||
		!coverageToolCallIds.has(WRITE_TOOL_CALL_ID) ||
		transcript?.coverage?.finalStatus?.ok !== transcript.modes.length
	) {
		return false;
	}
	return transcript.modes.every((mode) => {
		const toolCalls = Array.isArray(mode?.toolCalls) ? mode.toolCalls : [];
		const readTool = toolCalls.find((toolCall) => toolCall?.id === TOOL_CALL_ID);
		const searchTool = toolCalls.find(
			(toolCall) => toolCall?.id === SEARCH_TOOL_CALL_ID,
		);
		const writeTool = toolCalls.find(
			(toolCall) => toolCall?.id === WRITE_TOOL_CALL_ID,
		);
		return (
			REQUIRED_REPLAY_MODES.includes(mode?.mode) &&
			mode?.provider === SCRIPTED_REPLAY_PROVIDER &&
			mode?.promptSha256 === transcript.prompt.sha256 &&
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
			finiteNumber(mode?.session?.jsonlFileCount) > 0
		);
	});
}

function buildPublishedReplayObservability({
	installMetadata,
	modes,
	providerConfig,
	transcript,
	agentRuntimeLifecycle,
}) {
	const modeNames = modes.map(modeName);
	const evidenceRefs = uniqueValues(modes.flatMap(evidenceRefsForMode));
	const toolExecutionCoverage = buildToolExecutionCoverage(modes);
	const searchModes = uniqueValues(
		modes
			.filter((modeEvidence) =>
				Boolean(
					toolWorkItemForMode(modeEvidence, {
						toolName: "search",
						toolCallId: SEARCH_TOOL_CALL_ID,
					}),
				),
			)
			.map(modeName),
	);
	const searchEvidenceRefs = uniqueValues(
		modes.flatMap((modeEvidence) =>
			filterPublishedReplayEvidenceRefs(
				toolWorkItemForMode(modeEvidence, {
					toolName: "search",
					toolCallId: SEARCH_TOOL_CALL_ID,
				})?.evidenceRefs,
			),
		),
	);
	const approvalRefs = evidenceRefs.filter((ref) =>
		ref.startsWith("approval-request:"),
	);
	const artifactRefs = evidenceRefs.filter((ref) => ref.startsWith("artifact:"));
	const approvalModes = modesWithEvidenceRefPrefix(modes, "approval-request:");
	const artifactModes = modesWithEvidenceRefPrefix(modes, "artifact:");
	const errorModes = uniqueValues(
		modes
			.filter((modeEvidence) => {
				const toolStatus = modeEvidence?.tool?.resultStatus;
				const finalStatus = modeEvidence?.final?.status;
				return (
					modeEvidence?.status !== "ok" ||
					(typeof toolStatus === "string" && toolStatus !== "success") ||
					(typeof finalStatus === "string" && finalStatus !== "ok")
				);
			})
			.map(modeName),
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
			provider: "scripted-replay",
			sandboxMode: replaySandboxMode,
		},
		providerConfig: cloneJson(providerConfig),
		transcript: buildPublishedReplayTranscriptObservability(transcript),
		sessions: {
			modes: uniqueValues(
				modes
					.filter(
						(modeEvidence) =>
							modeEvidence?.session?.containsFinalText === true &&
							modeEvidence?.session?.containsToolCallId === true,
					)
					.map(modeName),
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
				modes
					.flatMap((modeEvidence) => toolWorkItemsForMode(modeEvidence))
					.map((item) => item?.toolName),
			),
			callIds: uniqueValues(
				modes
					.flatMap((modeEvidence) => toolWorkItemsForMode(modeEvidence))
					.map((item) => item?.toolCallId),
			),
			resultStatus: countBy(
				modes
					.flatMap((modeEvidence) => toolEvidenceForMode(modeEvidence))
					.map((tool) => tool?.resultStatus),
			),
			evidenceRefs,
			toolExecutionRefs: toolExecutionCoverage.refs,
			toolExecutionRefsByCallId: toolExecutionCoverage.refsByCallId,
			toolExecutionModesByCallId: toolExecutionCoverage.modesByCallId,
			completionGates: uniqueValues(
				modes
					.flatMap((modeEvidence) => toolWorkItemsForMode(modeEvidence))
					.map((item) => item?.completionGate),
			),
		},
		search: {
			engine: "ripgrep",
			toolName: "search",
			callId: SEARCH_TOOL_CALL_ID,
			inputPath: "package.json",
			patternSha256: sha256(SEARCH_PATTERN),
			modes: searchModes,
			evidenceRefs: searchEvidenceRefs,
		},
		approvals: {
			count: approvalModes.length,
			modes: approvalModes,
			evidenceRefs: approvalRefs,
		},
		errors: {
			queryable: true,
			expectedCount: 0,
			count: errorModes.length,
			modes: errorModes,
			byStatus: countBy(modes.map((modeEvidence) => modeEvidence?.status)),
			evidenceRefs: [],
		},
		artifacts: {
			count: artifactModes.length,
			modes: artifactModes,
			evidenceRefs: artifactRefs,
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
		agentRuntimeLedger: buildAgentRuntimeLedgerObservability(modes),
		agentRuntimeLifecycle: normalizeAgentRuntimeLifecycle(
			agentRuntimeLifecycle,
		),
	};
	return {
		...observability,
		queryIndex: buildPublishedReplayObservabilityQueryIndex(observability),
	};
}

function buildPublishedReplayReleaseGate({
	observability,
	modes,
	providerConfig,
	transcript,
	agentRuntimeLifecycle,
}) {
	const modeSet = new Set(observability.replay.modes);
	const checks = {
		installablePackageMetadata: observability.install.installable === true,
		noForbiddenWorkspaceReferences:
			observability.install.forbiddenReferences.length === 0,
		noWorkspaceProtocolReferences:
			observability.install.workspaceProtocolReferences.length === 0,
		providerConfig: providerConfigSatisfiesReleaseGate(providerConfig),
		requiredReplayModes: REQUIRED_REPLAY_MODES.every((mode) => modeSet.has(mode)),
		transcriptEvidence: transcriptSatisfiesReleaseGate(transcript),
		sessionEvidence:
			modes.length > 0 &&
			modes.every(
				(modeEvidence) =>
					modeEvidence?.session?.containsFinalText === true &&
					modeEvidence?.session?.containsToolCallId === true &&
					modeEvidence?.session?.containsSearchToolCallId === true &&
					modeEvidence?.session?.containsWriteToolCallId === true &&
					finiteNumber(modeEvidence?.session?.jsonlFileCount) > 0,
			),
		toolEvidence:
			modes.length > 0 &&
			modes.every((modeEvidence) => {
				const readWorkItem = toolWorkItemForMode(modeEvidence, {
					toolName: "read",
					toolCallId: TOOL_CALL_ID,
				});
				const refs = filterPublishedReplayEvidenceRefs(
					readWorkItem?.evidenceRefs,
				);
				return (
					modeEvidence?.tool?.name === "read" &&
					modeEvidence?.tool?.callId === TOOL_CALL_ID &&
					modeEvidence?.tool?.inputPath === "package.json" &&
					modeEvidence?.tool?.resultStatus === "success" &&
					refs.includes(`tool-call:${TOOL_CALL_ID}`) &&
					modeEvidence?.agentRuntimeLedger?.toolWorkItem?.completionGate ===
						"maestro_agent_runtime_ledger_recorded"
				);
			}),
		toolExecutionEvidence:
			replayModesHaveToolExecutionRefs(modes) &&
			toolExecutionCoverageSatisfiesReleaseGate(observability.tools),
		searchRipgrepEvidence:
			modes.length > 0 &&
			modes.every((modeEvidence) => {
				const searchWorkItem = toolWorkItemForMode(modeEvidence, {
					toolName: "search",
					toolCallId: SEARCH_TOOL_CALL_ID,
				});
				const refs = filterPublishedReplayEvidenceRefs(
					searchWorkItem?.evidenceRefs,
				);
				return (
					modeEvidence?.searchTool?.name === "search" &&
					modeEvidence?.searchTool?.callId === SEARCH_TOOL_CALL_ID &&
					modeEvidence?.searchTool?.inputPath === "package.json" &&
					modeEvidence?.searchTool?.resultStatus === "success" &&
					refs.includes(`tool-call:${SEARCH_TOOL_CALL_ID}`) &&
					searchWorkItem?.completionGate ===
						"maestro_agent_runtime_ledger_recorded" &&
					observability.search.engine === "ripgrep" &&
					observability.search.modes.includes(modeName(modeEvidence))
				);
			}),
		approvalTraceEvidence:
			modes.length > 0 &&
			modes.every((modeEvidence) =>
				evidenceRefsForMode(modeEvidence).some((ref) =>
					ref.startsWith("approval-request:"),
				),
			),
		errorTraceEvidence:
			observability.errors.queryable === true &&
			observability.errors.expectedCount === 0 &&
			observability.errors.count === 0 &&
			Array.isArray(observability.errors.modes),
		artifactTraceEvidence:
			modes.length > 0 &&
			modes.every((modeEvidence) =>
				evidenceRefsForMode(modeEvidence).some((ref) =>
					ref.startsWith("artifact:"),
				),
			),
		queryableObservabilityIndex:
			queryableObservabilityIndexSatisfiesReleaseGate(observability),
		agentRuntimeLedger:
			modes.length > 0 &&
			modes.every((modeEvidence) => {
				const ledger = modeEvidence?.agentRuntimeLedger;
				return (
					ledger?.schemaVersion === "evalops.maestro.agent-runtime-ledger.v1" &&
					ledger?.replayDeterministic === true &&
					ledger?.hasHandleTrigger === true &&
					ledger?.hasRecordRunStep === true &&
					ledger?.hasRecordRunWorkItem === true &&
					ledger?.hasTerminalOperation === true &&
					ledger?.durability?.reconstructable === true &&
					ledger?.durability?.replayDeterministic === true &&
					typeof ledger?.durability?.promotionIdempotencyKey === "string"
				);
			}),
		agentRuntimeLifecycle:
			agentRuntimeLifecycleSatisfiesReleaseGate(agentRuntimeLifecycle) &&
			agentRuntimeLifecycleSatisfiesReleaseGate(
				observability.agentRuntimeLifecycle,
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
	const runtimeWorkspaceNames = getRuntimeWorkspaceNames(rootPackage);
	const workspacePackages = await getWorkspacePackages(rootPackage);
	return Array.from(
		new Set([
			...runtimeWorkspaceNames,
			...workspacePackages
				.filter((workspacePackage) => workspacePackage.data.private === true)
				.map((workspacePackage) => workspacePackage.name),
		]),
	).sort();
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

function createScenario(runDir, id) {
	const scenarioPath = join(runDir, `${id}.json`);
	writeFileSync(
		scenarioPath,
		`${JSON.stringify(
			{
				schemaVersion: SCRIPTED_SCENARIO_SCHEMA,
				id,
				description:
					"Published package replay with real read/write tool calls, approval trace evidence, artifact trace evidence, and a final assistant response.",
				metadata: {
					recordedFrom: "smoke-published-replay-e2e",
					recordedAt: "2026-05-23T00:00:00.000Z",
					modelOriginal: "maestro-replay-v1",
					toolsExpected: ["read", "search", "write"],
					auditEvents: ["maestro.scenario.replay.ready"],
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
						id: "audit-event-tagged",
						kind: "audit_event_emitted",
						eventType: "maestro.scenario.replay.ready",
					},
				],
			},
			null,
			2,
		)}\n`,
	);
	return scenarioPath;
}

function createRunContext(label) {
	const runDir = mkdtempSync(join(tmpdir(), `maestro-published-${label}-`));
	const home = join(runDir, "home");
	const maestroHome = join(runDir, "maestro-home");
	const agentDir = join(runDir, "agent");
	const sessionDir = join(runDir, "sessions");
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
		scenarioPath: createScenario(runDir, label),
		sessionDir,
		env: {
			...process.env,
			CI: "1",
			NO_COLOR: "1",
			HOME: home,
			MAESTRO_HOME: maestroHome,
			MAESTRO_AGENT_DIR: agentDir,
			MAESTRO_SESSION_DIR: sessionDir,
			ANTHROPIC_API_KEY: "test-key",
			OPENAI_API_KEY: "test-key",
			MAESTRO_PLAN_MODE: "1",
		},
	};
}

function scopedSessionDirForContext(context) {
	const cwd = realpathSync(context.runDir);
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(context.sessionDir, safePath);
}

function writeAgentRuntimeLifecycleFixtureSession(context, label) {
	const sessionId = `published-lifecycle-${label}`;
	const entries = [
		{
			type: "session",
			version: 2,
			id: sessionId,
			timestamp: "2026-05-23T00:00:00.000Z",
			cwd: context.runDir,
			model: SCRIPTED_REPLAY_MODEL,
			unifiedContextManifest: {
				protocolVersion: "maestro.unified-context-manifest.v1",
				version: 1,
				cwd: context.runDir,
				projectDocs: {
					cwd: context.runDir,
					candidates: ["package.json"],
					bytesRead: 0,
					entries: [],
					diagnostics: [],
				},
				entries: [],
				diagnostics: [],
			},
			tools: [{ name: "search" }, { name: "write" }],
		},
		{
			type: "message",
			id: "user-lifecycle-1",
			parentId: null,
			timestamp: "2026-05-23T00:00:01.000Z",
			message: {
				role: "user",
				content: "Exercise AgentRuntime waits and retry joins.",
				timestamp: 1779494401000,
			},
		},
		{
			type: "message",
			id: "assistant-lifecycle-1",
			parentId: "user-lifecycle-1",
			timestamp: "2026-05-23T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I will run a governed search." },
					{
						type: "toolCall",
						id: "call-lifecycle-search",
						name: "search",
						arguments: { pattern: "maestro", paths: "package.json" },
					},
				],
				api: "scripted-replay",
				provider: SCRIPTED_REPLAY_PROVIDER,
				model: SCRIPTED_REPLAY_MODEL,
				stopReason: "toolUse",
				timestamp: 1779494402000,
			},
		},
		{
			type: "message",
			id: "tool-lifecycle-search",
			parentId: "assistant-lifecycle-1",
			timestamp: "2026-05-23T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-lifecycle-search",
				toolName: "search",
				content: [{ type: "text", text: "search failed" }],
				isError: true,
				timestamp: 1779494403000,
				details: {
					toolExecutionId: "tool-exec-lifecycle-search",
					governedOutcome: {
						classification: "approval_required",
						approvalRequestId: "approval-lifecycle-search",
					},
				},
			},
		},
		{
			type: "custom",
			id: "pending-lifecycle-approval-entry",
			parentId: "tool-lifecycle-search",
			timestamp: "2026-05-23T00:00:03.250Z",
			customType: "pending_request",
			data: {
				request: {
					id: "pending-lifecycle-approval",
					kind: "approval",
					status: "pending",
					visibility: "user",
					sessionId,
					toolCallId: "call-lifecycle-search",
					toolName: "search",
					displayName: "Governed search",
					args: { pattern: "maestro", paths: "package.json" },
					reason: "Approval is required before continuing.",
					createdAt: "2026-05-23T00:00:03.250Z",
					source: "platform",
					platform: {
						source: "tool_execution",
						toolExecutionId: "tool-exec-lifecycle-search",
						approvalRequestId: "approval-lifecycle-search",
					},
				},
			},
		},
		{
			type: "custom",
			id: "pending-lifecycle-retry-entry",
			parentId: "tool-lifecycle-search",
			timestamp: "2026-05-23T00:00:03.500Z",
			customType: "pending_request",
			data: {
				request: {
					id: "pending-lifecycle-retry",
					kind: "tool_retry",
					status: "pending",
					visibility: "user",
					sessionId,
					toolCallId: "call-lifecycle-search",
					toolName: "search",
					displayName: "Retry governed search",
					args: { pattern: "maestro", paths: "package.json" },
					reason: "The failed search needs a retry decision.",
					createdAt: "2026-05-23T00:00:03.500Z",
					source: "platform",
					platform: {
						source: "tool_execution",
						toolExecutionId: "tool-exec-lifecycle-search",
						approvalRequestId: "approval-lifecycle-retry",
					},
				},
			},
		},
		{
			type: "message",
			id: "assistant-lifecycle-final",
			parentId: "tool-lifecycle-search",
			timestamp: "2026-05-23T00:00:04.000Z",
			message: {
				role: "assistant",
				content:
					"Lifecycle fixture reached a terminal outcome after wait capture.",
				api: "scripted-replay",
				provider: SCRIPTED_REPLAY_PROVIDER,
				model: SCRIPTED_REPLAY_MODEL,
				stopReason: "stop",
				timestamp: 1779494404000,
			},
		},
	];
	const sessionFileName = `2026-05-23T00-00-00-000Z_${sessionId}.jsonl`;
	const scopedSessionDir = scopedSessionDirForContext(context);
	const candidateDirs = uniqueValues([
		scopedSessionDir,
		context.sessionDir,
		join(context.env.MAESTRO_AGENT_DIR, "sessions", basename(scopedSessionDir)),
	]);
	for (const sessionDir of candidateDirs) {
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, sessionFileName),
			`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
	}
	return sessionId;
}

function parseJsonLines(stdout, label) {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				fail(
					`${label} emitted invalid JSON on stdout line ${index + 1}.`,
					`${line}\n${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
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

function assertSessionEvidence(sessionDir, label) {
	const report = sessionEvidenceReport(sessionDir, label);
	if (typeof report === "string") fail(report);
	return report;
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
			// Ignore non-JSON fragments; the missing session id check below reports
			// the actionable failure with the evidence label and directory.
		}
	}
	return "";
}

function sessionEvidenceReport(sessionDir, label) {
	const sessionFiles = collectFiles(sessionDir).filter((path) =>
		path.endsWith(".jsonl"),
	);
	if (sessionFiles.length === 0) {
		return `${label} did not write a session JSONL file in ${sessionDir}.`;
	}
	const sessionText = sessionFiles
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
	if (
		!sessionText.includes(FINAL_TEXT) ||
		!sessionText.includes(TOOL_CALL_ID) ||
		!sessionText.includes(SEARCH_TOOL_CALL_ID) ||
		!sessionText.includes(WRITE_TOOL_CALL_ID)
	) {
		return `${label} session evidence is missing the final text or tool call ids.`;
	}
	const sessionId = sessionIdFromEvidenceText(sessionText);
	if (!sessionId) {
		return `${label} session evidence is missing a session header id.`;
	}
	return {
		sessionId,
		jsonlFileCount: sessionFiles.length,
		bytes: Buffer.byteLength(sessionText),
		sha256: sha256(sessionText),
		containsFinalText: true,
		containsToolCallId: true,
		containsSearchToolCallId: true,
		containsWriteToolCallId: true,
	};
}

function assertAgentRuntimeLedger(binPath, context, label) {
	const session = assertSessionEvidence(context.sessionDir, label);
	const result = spawnSync(
		binPath,
		["run", "inspect", session.sessionId, "--json"],
		{
			cwd: context.runDir,
			encoding: "utf8",
			env: context.env,
			timeout: timeoutMs,
		},
	);
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
	if (ledger?.schemaVersion !== "evalops.maestro.agent-runtime-ledger.v1") {
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
	const hasTerminalOperation = operations.some(
		(operation) =>
			operation?.operation === "complete_run" ||
			operation?.operation === "fail_run",
	);
	if (
		!hasHandleTrigger ||
		!hasRecordRunStep ||
		!hasRecordRunWorkItem ||
		!hasTerminalOperation
	) {
		fail(`${label} AgentRuntime promotion plan is missing required operations.`);
	}
	const summarizeToolWorkItem = (operation) => {
		const payload = operation?.payload;
		const evidenceRefs = filterPublishedReplayEvidenceRefs(payload?.evidenceRefs);
		const toolCallRef = evidenceRefs.find((ref) =>
			ref.startsWith("tool-call:"),
		);
		return {
			toolName: payload?.payload?.toolName,
			toolCallId: toolCallRef?.slice("tool-call:".length),
			evidenceRefs,
			completionGate: payload?.completionGate,
		};
	};
	const toolWorkItems = operations
		.filter((operation) => {
			const payload = operation?.payload;
			return (
				operation?.operation === "record_run_work_item" &&
				payload?.payload?.eventType === "tool.completed"
			);
		})
		.map(summarizeToolWorkItem);
	const toolWorkItem = toolWorkItems.find((item) => {
		return (
			item?.toolName === "read" &&
			item?.evidenceRefs.includes(`tool-call:${TOOL_CALL_ID}`)
		);
	});
	const searchToolWorkItem = toolWorkItems.find((item) => {
		return (
			item?.toolName === "search" &&
			item?.evidenceRefs.includes(`tool-call:${SEARCH_TOOL_CALL_ID}`)
		);
	});
	const artifactToolWorkItem = toolWorkItems.find((item) => {
		return (
			item?.toolName === "write" &&
			item?.evidenceRefs.includes(`tool-call:${WRITE_TOOL_CALL_ID}`)
		);
	});
	if (!toolWorkItem) {
		fail(`${label} AgentRuntime tool work item is missing read evidence.`);
	}
	if (!searchToolWorkItem) {
		fail(`${label} AgentRuntime tool work item is missing search evidence.`);
	}
	if (!artifactToolWorkItem) {
		fail(`${label} AgentRuntime tool work item is missing write evidence.`);
	}
	if (
		!artifactToolWorkItem.evidenceRefs.some((ref) =>
			ref.startsWith("approval-request:"),
		)
	) {
		fail(`${label} AgentRuntime write work item is missing approval evidence.`);
	}
	if (
		!artifactToolWorkItem.evidenceRefs.some((ref) =>
			ref.startsWith("artifact:"),
		)
	) {
		fail(`${label} AgentRuntime write work item is missing artifact evidence.`);
	}
	for (const [workItem, toolName] of [
		[toolWorkItem, "read"],
		[searchToolWorkItem, "search"],
		[artifactToolWorkItem, "write"],
	]) {
		if (
			!workItem.evidenceRefs.some((ref) => ref.startsWith("tool-execution:"))
		) {
			fail(
				`${label} AgentRuntime ${toolName} work item is missing ToolExecution evidence.`,
			);
		}
	}
	if (!toolWorkItem.evidenceRefs.includes(`tool-call:${TOOL_CALL_ID}`)) {
		fail(`${label} AgentRuntime tool work item is missing tool-call evidence.`);
	}
	if (toolWorkItem.completionGate !== "maestro_agent_runtime_ledger_recorded") {
		fail(`${label} AgentRuntime tool work item is missing the completion gate.`);
	}
	if (
		searchToolWorkItem.completionGate !== "maestro_agent_runtime_ledger_recorded"
	) {
		fail(
			`${label} AgentRuntime search work item is missing the completion gate.`,
		);
	}
	return {
		schemaVersion: ledger.schemaVersion,
		replayDeterministic: true,
		entries: ledger.counts?.entries ?? 0,
		promotionOperations: ledger.counts?.promotionOperations ?? operations.length,
		counts: {
			entries: ledger.counts?.entries ?? 0,
			promotionOperations: ledger.counts?.promotionOperations ?? operations.length,
			byKind: ledger.counts?.byKind ?? {},
			byState: ledger.counts?.byState ?? {},
		},
		hasHandleTrigger,
		hasRecordRunStep,
		hasRecordRunWorkItem,
		hasTerminalOperation,
		toolWorkItem: {
			toolName: toolWorkItem.toolName,
			toolCallId: toolWorkItem.toolCallId,
			evidenceRefs: toolWorkItem.evidenceRefs,
			completionGate: toolWorkItem.completionGate,
		},
		toolWorkItems,
		durability: {
			reconstructable: true,
			sessionFilePresent: durability.sessionFilePresent === true,
			contextManifestPresent: durability.contextManifestPresent === true,
			replayDeterministic: true,
			promotionIdempotencyKey: durability.promotionIdempotencyKey,
		},
	};
}

function assertAgentRuntimeLifecycle(binPath) {
	const context = createRunContext("agent-runtime-lifecycle");
	try {
		const sessionId = writeAgentRuntimeLifecycleFixtureSession(
			context,
			"agent-runtime-lifecycle",
		);
		const result = spawnSync(
			binPath,
			["run", "inspect", sessionId, "--json"],
			{
				cwd: context.runDir,
				encoding: "utf8",
				env: context.env,
				timeout: timeoutMs,
			},
		);
		if (result.error) {
			fail(
				"Published AgentRuntime lifecycle fixture inspection failed to launch.",
				result.error.stack,
			);
		}
		if (result.status !== 0) {
			fail(
				`Published AgentRuntime lifecycle fixture inspection exited with ${result.status}.`,
				[result.stdout, result.stderr].filter(Boolean).join("\n\n"),
			);
		}
		let report;
		try {
			report = JSON.parse(result.stdout);
		} catch (error) {
			fail(
				"Published AgentRuntime lifecycle fixture inspection did not emit JSON.",
				`${result.stdout}\n${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const ledger = report?.agentRuntimeLedger;
		const operations = Array.isArray(ledger?.promotion?.operations)
			? ledger.promotion.operations
			: [];
		const waitOperations = operations.filter(
			(operation) => operation?.operation === "wait_run",
		);
		const waitWorkItems = operations.filter(
			(operation) =>
				operation?.operation === "record_run_work_item" &&
				typeof operation?.payload?.pendingRequestId === "string",
		);
		const terminalOperations = operations.filter(
			(operation) =>
				operation?.operation === "complete_run" ||
				operation?.operation === "fail_run",
		);
		const waits = waitOperations.map((operation) => {
			const payload = operation?.payload ?? {};
			const workItem = waitWorkItems.find(
				(candidate) =>
					candidate?.payload?.pendingRequestId === payload.pendingRequestId,
			);
			return {
				pendingRequestId: payload.pendingRequestId,
				pendingRequestKind: payload.pendingRequestKind,
				waitType: payload.waitType,
				approvalRequestId: payload.approvalRequestId,
				toolExecutionId: payload.toolExecutionId,
				evidenceRefs: filterPublishedReplayEvidenceRefs(
					workItem?.payload?.evidenceRefs,
				),
			};
		});
		const operationsSummary = {
			handleTrigger: operations.filter(
				(operation) => operation?.operation === "handle_trigger",
			).length,
			recordRunStep: operations.filter(
				(operation) => operation?.operation === "record_run_step",
			).length,
			recordRunWorkItem: operations.filter(
				(operation) => operation?.operation === "record_run_work_item",
			).length,
			waitRun: waitOperations.length,
			terminal: terminalOperations.length,
			completeRun: terminalOperations.filter(
				(operation) => operation?.operation === "complete_run",
			).length,
			failRun: terminalOperations.filter(
				(operation) => operation?.operation === "fail_run",
			).length,
		};
		const lifecycle = {
			schemaVersion: AGENT_RUNTIME_LIFECYCLE_SCHEMA,
			sessionId,
			replayDeterministic: ledger?.replay?.deterministic === true,
			counts: {
				entries: finiteNumber(ledger?.counts?.entries),
				promotionOperations: finiteNumber(
					ledger?.counts?.promotionOperations ?? operations.length,
				),
				waits: waitOperations.length,
				approvalWaits: waits.filter(
					(wait) => wait.pendingRequestKind === "approval",
				).length,
				toolRetryWaits: waits.filter(
					(wait) => wait.pendingRequestKind === "tool_retry",
				).length,
				terminalOperations: terminalOperations.length,
			},
			operations: operationsSummary,
			waits,
			outcomes: {
				terminalStates: countBy(
					terminalOperations.map((operation) => operation?.payload?.state),
				),
				terminalEventTypes: uniqueValues(
					terminalOperations.map((operation) => operation?.payload?.eventType),
				),
			},
			durability: {
				reconstructable: report?.durability?.reconstructable === true,
				sessionFilePresent: report?.durability?.sessionFilePresent === true,
				contextManifestPresent:
					report?.durability?.contextManifestPresent === true,
				replayDeterministic: report?.durability?.replayDeterministic === true,
				promotionIdempotencyKey: report?.durability?.promotionIdempotencyKey,
				pendingRequests: report?.durability?.pendingRequests ?? 0,
			},
		};
		if (!agentRuntimeLifecycleSatisfiesReleaseGate(lifecycle)) {
			fail(
				"Published AgentRuntime lifecycle fixture did not cover approval waits, retry waits, and terminal outcomes.",
				JSON.stringify(lifecycle, null, 2),
			);
		}
		console.log("Published AgentRuntime lifecycle fixture smoke passed.");
		return lifecycle;
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function assertJsonMode(messages, context, label) {
	const toolCall = messages.find(
		(message) =>
			message?.type === "item" &&
			message?.subtype === "tool_call" &&
			message?.data?.toolName === "read",
	);
	if (toolCall?.data?.args?.path !== "package.json") {
		fail(`${label} did not emit the expected read tool_call JSONL event.`);
	}

	const toolResult = messages.find(
		(message) =>
			message?.type === "item" &&
			message?.subtype === "tool_result" &&
			message?.data?.toolCallId === TOOL_CALL_ID,
	);
	if (!toolResult || toolResult.data?.isError) {
		fail(`${label} did not emit a successful read tool_result JSONL event.`);
	}
	const searchToolCall = messages.find(
		(message) =>
			message?.type === "item" &&
			message?.subtype === "tool_call" &&
			message?.data?.toolName === "search",
	);
	if (
		searchToolCall?.data?.args?.paths !== "package.json" ||
		searchToolCall?.data?.args?.pattern !== SEARCH_PATTERN
	) {
		fail(`${label} did not emit the expected search tool_call JSONL event.`);
	}
	const searchToolResult = messages.find(
		(message) =>
			message?.type === "item" &&
			message?.subtype === "tool_result" &&
			message?.data?.toolCallId === SEARCH_TOOL_CALL_ID,
	);
	if (!searchToolResult || searchToolResult.data?.isError) {
		fail(`${label} did not emit a successful search tool_result JSONL event.`);
	}
	const writeToolCall = messages.find(
		(message) =>
			message?.type === "item" &&
			message?.subtype === "tool_call" &&
			message?.data?.toolName === "write",
	);
	if (writeToolCall?.data?.args?.path !== ARTIFACT_PATH) {
		fail(`${label} did not emit the expected write tool_call JSONL event.`);
	}
	const writeToolResult = messages.find(
		(message) =>
			message?.type === "item" &&
			message?.subtype === "tool_result" &&
			message?.data?.toolCallId === WRITE_TOOL_CALL_ID,
	);
	if (!writeToolResult || writeToolResult.data?.isError) {
		fail(`${label} did not emit a successful write tool_result JSONL event.`);
	}

	const finalMessage = messages
		.filter(
			(message) =>
				message?.type === "item" &&
				message?.subtype === "message_complete" &&
				typeof message?.data?.text === "string",
		)
		.at(-1);
	if (!finalMessage?.data?.text?.includes(FINAL_TEXT)) {
		fail(`${label} did not emit the final assistant response.`);
	}
	if (finalMessage.data?.provider !== "scripted-replay") {
		fail(`${label} did not run through the scripted replay provider.`);
	}

	if (
		!messages.some(
			(message) =>
				message?.type === "thread" &&
				message?.phase === "end" &&
				message?.status === "ok",
		)
	) {
		fail(`${label} did not emit a thread end ok event.`);
	}

	return {
		mode: "json",
		status: "ok",
		provider: finalMessage.data.provider,
		stdout: {
			jsonLineCount: messages.length,
			eventTypes: countBy(
				messages.map((message) =>
					[message?.type, message?.subtype].filter(Boolean).join(":"),
				),
			),
		},
		tool: {
			name: "read",
			callId: toolResult.data.toolCallId,
			inputPath: toolCall.data.args.path,
			resultStatus: "success",
		},
		searchTool: {
			name: "search",
			callId: searchToolResult.data.toolCallId,
			inputPath: searchToolCall.data.args.paths,
			resultStatus: "success",
		},
		artifactTool: {
			name: "write",
			callId: writeToolResult.data.toolCallId,
			inputPath: writeToolCall.data.args.path,
			resultStatus: "success",
		},
		final: {
			status: "ok",
			textSha256: sha256(finalMessage.data.text),
			containsExpectedText: true,
		},
		session: assertSessionEvidence(context.sessionDir, label),
	};
}

function runSingleShotMode(binPath, label, mode) {
	const context = createRunContext(label);
	try {
		const result = spawnSync(
			binPath,
			[
				"--replay",
				context.scenarioPath,
				"--mode",
				mode,
				"--approval-mode",
				"auto",
				"--sandbox",
				replaySandboxMode,
				"--tools",
				SCRIPTED_REPLAY_TOOL_ALLOWLIST.join(","),
				PROMPT_TEXT,
			],
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
		return { context, stdout: result.stdout };
	} catch (error) {
		rmSync(context.runDir, { recursive: true, force: true });
		throw error;
	}
}

function runTextMode(binPath) {
	const { context, stdout } = runSingleShotMode(
		binPath,
		"replay-text",
		"text",
	);
	try {
		if (!stdout.includes(FINAL_TEXT)) {
			fail("Published text replay did not print the final assistant response.");
		}
		const session = assertSessionEvidence(
			context.sessionDir,
			"Published text replay",
		);
		const agentRuntimeLedger = assertAgentRuntimeLedger(
			binPath,
			context,
			"Published text replay",
		);
		console.log("Published text replay smoke passed.");
		return {
			mode: "text",
			status: "ok",
			provider: "scripted-replay",
			stdout: {
				bytes: Buffer.byteLength(stdout),
				sha256: sha256(stdout),
				containsFinalText: true,
			},
			tool: {
				name: "read",
				callId: TOOL_CALL_ID,
				inputPath: "package.json",
				resultStatus: "success",
			},
			searchTool: {
				name: "search",
				callId: SEARCH_TOOL_CALL_ID,
				inputPath: "package.json",
				resultStatus: "success",
			},
			artifactTool: {
				name: "write",
				callId: WRITE_TOOL_CALL_ID,
				inputPath: ARTIFACT_PATH,
				resultStatus: "success",
			},
			final: {
				status: "ok",
				textSha256: sha256(FINAL_TEXT),
				containsExpectedText: true,
			},
			session,
			agentRuntimeLedger,
		};
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function runJsonMode(binPath) {
	const { context, stdout } = runSingleShotMode(
		binPath,
		"replay-json",
		"json",
	);
	try {
		const evidence = assertJsonMode(
			parseJsonLines(stdout, "Published JSON replay"),
			context,
			"Published JSON replay",
		);
		evidence.agentRuntimeLedger = assertAgentRuntimeLedger(
			binPath,
			context,
			"Published JSON replay",
		);
		console.log("Published JSON replay smoke passed.");
		return evidence;
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function assertRpcEvents(events, context) {
	if (!events.some((event) => event?.type === "agent_start")) {
		fail("Published RPC replay did not emit agent_start.");
	}
	if (
		!events.some(
			(event) =>
				event?.type === "tool_execution_start" &&
				event?.toolName === "read" &&
				event?.args?.path === "package.json",
		)
	) {
		fail("Published RPC replay did not emit the expected read tool start.");
	}
	if (
		!events.some(
			(event) =>
				event?.type === "tool_execution_end" &&
				event?.toolName === "read" &&
				!event?.isError,
		)
	) {
		fail("Published RPC replay did not emit a successful read tool result.");
	}
	if (
		!events.some(
			(event) =>
				event?.type === "tool_execution_start" &&
				event?.toolName === "search" &&
				event?.args?.paths === "package.json" &&
				event?.args?.pattern === SEARCH_PATTERN,
		)
	) {
		fail("Published RPC replay did not emit the expected search tool start.");
	}
	if (
		!events.some(
			(event) =>
				event?.type === "tool_execution_end" &&
				event?.toolName === "search" &&
				!event?.isError,
		)
	) {
		fail("Published RPC replay did not emit a successful search tool result.");
	}
	if (
		!events.some(
			(event) =>
				event?.type === "tool_execution_start" &&
				event?.toolName === "write" &&
				event?.args?.path === ARTIFACT_PATH,
		)
	) {
		fail("Published RPC replay did not emit the expected write tool start.");
	}
	if (
		!events.some(
			(event) =>
				event?.type === "tool_execution_end" &&
				event?.toolName === "write" &&
				!event?.isError,
		)
	) {
		fail("Published RPC replay did not emit a successful write tool result.");
	}
	const agentEnd = events.findLast?.((event) => event?.type === "agent_end");
	if (!agentEnd || agentEnd.aborted) {
		fail("Published RPC replay did not emit a successful agent_end event.");
	}
	const stateText = JSON.stringify(agentEnd);
	if (
		!stateText.includes(FINAL_TEXT) ||
		!stateText.includes(TOOL_CALL_ID) ||
		!stateText.includes(SEARCH_TOOL_CALL_ID) ||
		!stateText.includes(WRITE_TOOL_CALL_ID)
	) {
		fail("Published RPC replay final state is missing replay evidence.");
	}
	return {
		mode: "rpc",
		status: "ok",
		provider: "scripted-replay",
		events: {
			count: events.length,
			types: countBy(events.map((event) => event?.type)),
			hasAgentStart: true,
			hasToolExecutionStart: true,
			hasToolExecutionEnd: true,
			hasAgentEnd: true,
		},
		tool: {
			name: "read",
			callId: TOOL_CALL_ID,
			inputPath: "package.json",
			resultStatus: "success",
		},
		searchTool: {
			name: "search",
			callId: SEARCH_TOOL_CALL_ID,
			inputPath: "package.json",
			resultStatus: "success",
		},
		artifactTool: {
			name: "write",
			callId: WRITE_TOOL_CALL_ID,
			inputPath: ARTIFACT_PATH,
			resultStatus: "success",
		},
		final: {
			status: "ok",
			aborted: false,
			stateSha256: sha256(stateText),
			containsExpectedText: true,
			containsToolCallId: true,
		},
	};
}

function runRpcMode(binPath) {
	return new Promise((resolvePromise, reject) => {
		const context = createRunContext("replay-rpc");
		const child = spawn(
			binPath,
			[
				"--mode",
				"rpc",
				"--replay",
				context.scenarioPath,
				"--approval-mode",
				"auto",
				"--sandbox",
				replaySandboxMode,
				"--tools",
				SCRIPTED_REPLAY_TOOL_ALLOWLIST.join(","),
			],
			{
				cwd: context.runDir,
				encoding: "utf8",
				env: context.env,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		const events = [];
		let stdoutBuffer = "";
		let stderr = "";
		let finished = false;
		let settled = false;
		let rpcEvidence;
		let forceKillTimer;
		const timer = setTimeout(() => {
			finish(new Error("Published RPC replay smoke timed out."));
		}, timeoutMs);

		function settle(error) {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			let settleError = error;
			if (!settleError && rpcEvidence) {
				const session = sessionEvidenceReport(
					context.sessionDir,
					"Published RPC replay",
				);
				if (typeof session === "string") {
					settleError = new Error(session);
				} else {
					rpcEvidence.session = session;
					rpcEvidence.agentRuntimeLedger = assertAgentRuntimeLedger(
						binPath,
						context,
						"Published RPC replay",
					);
				}
			}
			rmSync(context.runDir, { recursive: true, force: true });
			if (settleError) reject(settleError);
			else resolvePromise(rpcEvidence);
		}

		function finish(error) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (child.exitCode !== null || child.signalCode !== null) {
				settle(error);
				return;
			}
			child.once("exit", () => settle(error));
			if (!child.kill("SIGTERM")) {
				settle(error);
				return;
			}
			forceKillTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 2000);
			forceKillTimer.unref?.();
		}

		function handleEvent(event) {
			events.push(event);
			if (event?.type !== "agent_end") {
				return;
			}
			try {
				rpcEvidence = assertRpcEvents(events, context);
				console.log("Published RPC replay smoke passed.");
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		}

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("{")) continue;
				try {
					handleEvent(JSON.parse(trimmed));
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => finish(error));
		child.on("exit", (code, signal) => {
			if (!finished && code !== 0) {
				finish(
					new Error(
						`Published RPC replay exited early with code ${code} signal ${signal}.\n${stderr}`,
					),
				);
			}
		});

		child.stdin.write(`${JSON.stringify({ type: "prompt", message: PROMPT_TEXT })}\n`);
	});
}

export function buildPublishedReplayEvidence({
	packageSpec,
	cliCommand,
	binPath,
	installMetadata = null,
	installer = "",
	modes,
	agentRuntimeLifecycle = null,
}) {
	const resolvedInstaller = inferPublishedInstaller({ installer, installMetadata });
	const providerConfig = buildPublishedReplayProviderConfig();
	const transcript = buildPublishedReplayTranscript({ modes });
	const observability = buildPublishedReplayObservability({
		installMetadata,
		modes,
		providerConfig,
		transcript,
		agentRuntimeLifecycle,
	});
	const releaseGate = buildPublishedReplayReleaseGate({
		observability,
		modes,
		providerConfig,
		transcript,
		agentRuntimeLifecycle,
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
			provider: SCRIPTED_REPLAY_PROVIDER,
			scenarioSchemaVersion: SCRIPTED_SCENARIO_SCHEMA,
			sandboxMode: replaySandboxMode,
			providerConfig: cloneJson(providerConfig),
			prompt: {
				length: PROMPT_TEXT.length,
				sha256: sha256(PROMPT_TEXT),
			},
			expected: {
				toolName: "read",
				toolCallId: TOOL_CALL_ID,
				toolInputPath: "package.json",
				searchToolName: "search",
				searchToolCallId: SEARCH_TOOL_CALL_ID,
				searchToolInputPath: "package.json",
				searchEngine: "ripgrep",
				finalTextSha256: sha256(FINAL_TEXT),
			},
		},
		transcript,
		observability,
		releaseGate,
		agentRuntimeLifecycle: normalizeAgentRuntimeLifecycle(
			agentRuntimeLifecycle,
		),
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
	modes.push(runJsonMode(binPath));
	modes.push(await runRpcMode(binPath));
	const agentRuntimeLifecycle = assertAgentRuntimeLifecycle(binPath);
	const evidence = buildPublishedReplayEvidence({
		packageSpec,
		cliCommand,
		binPath,
		installMetadata,
		installer,
		modes,
		agentRuntimeLifecycle,
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
	const npmCommand = getNpmCommand();
	const evidencePath = resolvePublishedReplayEvidencePath({
		evidencePath: overrides.evidencePath,
		evidenceDir: overrides.evidenceDir,
	});
	let installRoot = overrides.installRoot
		? resolve(overrides.installRoot)
		: "";
	const shouldCleanup = !installRoot;

	if (!installRoot) {
		installRoot = mkdtempSync(join(tmpdir(), "maestro-published-replay-install-"));
		try {
			spawnSync(npmCommand, ["init", "-y"], {
				cwd: installRoot,
				stdio: "ignore",
			});
			const install = spawnSync(npmCommand, ["install", packageSpec], {
				cwd: installRoot,
				encoding: "utf8",
				stdio: "inherit",
			});
			if (install.error) {
				throw install.error;
			}
			if (install.status !== 0) {
				throw new Error(`npm install ${packageSpec} exited with ${install.status}`);
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
