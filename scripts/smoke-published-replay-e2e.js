#!/usr/bin/env node
// @ts-check

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
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
import {
	getWorkspacePackages,
	loadRootPackage,
} from "./workspace-utils.js";

const SCRIPTED_SCENARIO_SCHEMA = "evalops.maestro.scripted-scenario.v1";
const PUBLISHED_REPLAY_EVIDENCE_SCHEMA =
	"evalops.maestro.published-replay-evidence.v1";
const FINAL_TEXT =
	"Published package golden path completed with manifest evidence.";
const TOOL_CALL_ID = "call-read-package-json";
const PROMPT_TEXT = "Replay the published package golden path.";
const REQUIRED_REPLAY_MODES = ["text", "json", "rpc"];
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
	/** @type {{packageName: string; version: string; cliCommand: string; installRoot: string; evidencePath: string; evidenceDir: string}} */
	const options = {
		packageName: "",
		version: "",
		cliCommand: "",
		installRoot: "",
		evidencePath: "",
		evidenceDir: "",
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

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function evidenceRefsForMode(modeEvidence) {
	const refs = modeEvidence?.agentRuntimeLedger?.toolWorkItem?.evidenceRefs;
	return Array.isArray(refs)
		? refs.filter((ref) => typeof ref === "string" && ref.length > 0)
		: [];
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

function buildPublishedReplayObservability({ installMetadata, modes }) {
	const modeNames = modes.map(modeName);
	const evidenceRefs = uniqueValues(modes.flatMap(evidenceRefsForMode));
	const approvalRefs = evidenceRefs.filter((ref) =>
		ref.startsWith("approval-request:"),
	);
	const artifactRefs = evidenceRefs.filter((ref) => ref.startsWith("artifact:"));
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

	return {
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
			names: uniqueValues(modes.map((modeEvidence) => modeEvidence?.tool?.name)),
			callIds: uniqueValues(modes.map((modeEvidence) => modeEvidence?.tool?.callId)),
			resultStatus: countBy(modes.map((modeEvidence) => modeEvidence?.tool?.resultStatus)),
			evidenceRefs,
			completionGates: uniqueValues(
				modes.map(
					(modeEvidence) =>
						modeEvidence?.agentRuntimeLedger?.toolWorkItem?.completionGate,
				),
			),
		},
		approvals: {
			count: approvalRefs.length,
			evidenceRefs: approvalRefs,
		},
		errors: {
			count: errorModes.length,
			modes: errorModes,
		},
		artifacts: {
			count: artifactRefs.length,
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
	};
}

function buildPublishedReplayReleaseGate({ observability, modes }) {
	const modeSet = new Set(observability.replay.modes);
	const checks = {
		installablePackageMetadata: observability.install.installable === true,
		noForbiddenWorkspaceReferences:
			observability.install.forbiddenReferences.length === 0,
		noWorkspaceProtocolReferences:
			observability.install.workspaceProtocolReferences.length === 0,
		requiredReplayModes: REQUIRED_REPLAY_MODES.every((mode) => modeSet.has(mode)),
		sessionEvidence:
			modes.length > 0 &&
			modes.every(
				(modeEvidence) =>
					modeEvidence?.session?.containsFinalText === true &&
					modeEvidence?.session?.containsToolCallId === true &&
					finiteNumber(modeEvidence?.session?.jsonlFileCount) > 0,
			),
		toolEvidence:
			modes.length > 0 &&
			modes.every((modeEvidence) => {
				const refs = evidenceRefsForMode(modeEvidence);
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

export function assertPublishedReplayReleaseGate(evidence) {
	if (evidence?.releaseGate?.satisfied === true) {
		return;
	}
	const failedChecks = Array.isArray(evidence?.releaseGate?.failedChecks)
		? evidence.releaseGate.failedChecks.join(", ")
		: "unknown";
	throw new Error(`Published replay release gate failed: ${failedChecks}`);
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
					"Published package replay with one real read tool call and a final assistant response.",
				metadata: {
					recordedFrom: "smoke-published-replay-e2e",
					recordedAt: "2026-05-23T00:00:00.000Z",
					modelOriginal: "maestro-replay-v1",
					toolsExpected: ["read"],
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
						],
					},
					{
						index: 1,
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
						id: "write-tool-not-called",
						kind: "tool_not_called",
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
		},
	};
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
	if (!sessionText.includes(FINAL_TEXT) || !sessionText.includes(TOOL_CALL_ID)) {
		return `${label} session evidence is missing the final text or tool call id.`;
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
	const toolWorkItem = operations.find((operation) => {
		const payload = operation?.payload;
		return (
			operation?.operation === "record_run_work_item" &&
			payload?.payload?.eventType === "tool.completed" &&
			payload?.payload?.toolName === "read"
		);
	});
	const evidenceRefs = Array.isArray(toolWorkItem?.payload?.evidenceRefs)
		? toolWorkItem.payload.evidenceRefs
		: [];
	if (!evidenceRefs.includes(`tool-call:${TOOL_CALL_ID}`)) {
		fail(`${label} AgentRuntime tool work item is missing tool-call evidence.`);
	}
	if (
		toolWorkItem?.payload?.completionGate !==
		"maestro_agent_runtime_ledger_recorded"
	) {
		fail(`${label} AgentRuntime tool work item is missing the completion gate.`);
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
			toolName: toolWorkItem.payload.payload.toolName,
			evidenceRefs: evidenceRefs.filter((ref) =>
				["tool-call:", "tool-execution:", "approval-request:"].some((prefix) =>
					ref.startsWith(prefix),
				),
			),
			completionGate: toolWorkItem.payload.completionGate,
		},
		durability: {
			reconstructable: true,
			sessionFilePresent: durability.sessionFilePresent === true,
			contextManifestPresent: durability.contextManifestPresent === true,
			replayDeterministic: true,
			promotionIdempotencyKey: durability.promotionIdempotencyKey,
		},
	};
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
				"read",
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
	const agentEnd = events.findLast?.((event) => event?.type === "agent_end");
	if (!agentEnd || agentEnd.aborted) {
		fail("Published RPC replay did not emit a successful agent_end event.");
	}
	const stateText = JSON.stringify(agentEnd);
	if (!stateText.includes(FINAL_TEXT) || !stateText.includes(TOOL_CALL_ID)) {
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
				"read",
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
	modes,
}) {
	const observability = buildPublishedReplayObservability({
		installMetadata,
		modes,
	});
	const releaseGate = buildPublishedReplayReleaseGate({
		observability,
		modes,
	});
	return {
		schemaVersion: PUBLISHED_REPLAY_EVIDENCE_SCHEMA,
		generatedAt: new Date().toISOString(),
		package: {
			spec: packageSpec,
			cliCommand,
			binPath,
			installMetadata,
		},
		replay: {
			provider: "scripted-replay",
			scenarioSchemaVersion: SCRIPTED_SCENARIO_SCHEMA,
			sandboxMode: replaySandboxMode,
			prompt: {
				length: PROMPT_TEXT.length,
				sha256: sha256(PROMPT_TEXT),
			},
			expected: {
				toolName: "read",
				toolCallId: TOOL_CALL_ID,
				toolInputPath: "package.json",
				finalTextSha256: sha256(FINAL_TEXT),
			},
		},
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
	const evidence = buildPublishedReplayEvidence({
		packageSpec,
		cliCommand,
		binPath,
		installMetadata,
		modes,
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
				label: `${packageSpec} published replay install`,
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
