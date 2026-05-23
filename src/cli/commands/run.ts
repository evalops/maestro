import chalk from "chalk";
import { parseMcpToolName } from "../../mcp/names.js";
import {
	type AgentRuntimeLedgerReport,
	buildAgentRuntimeLedgerReport,
} from "../../server/agent-runtime-ledger.js";
import {
	type AgentTrajectoryInspectionReport,
	buildAgentTrajectoryInspectionReport,
} from "../../server/agent-trajectory-inspection.js";
import { DEFAULT_AGENT_TRAJECTORY_REPLAY_LAB_RULES } from "../../server/agent-trajectory-replay-lab.js";
import {
	type AgentTrajectoryReplayReport,
	replayAgentTrajectoryReport,
} from "../../server/agent-trajectory-replay.js";
import {
	type AgentTrajectoryScoreReport,
	scoreAgentTrajectoryReport,
} from "../../server/agent-trajectory-scorers.js";
import {
	type AgentTrajectoryReport,
	buildAgentTrajectoryReport,
} from "../../server/agent-trajectory.js";
import { buildComposerRunTimeline } from "../../server/session-timeline.js";
import { SessionManager } from "../../session/manager.js";
import { migrateToCurrentVersion } from "../../session/migration.js";
import type { SessionEntry, SessionHeaderEntry } from "../../session/types.js";

const RUN_RECONSTRUCTION_SCHEMA = "evalops.maestro.run-reconstruction.v1";

type ComposerRunTimeline = ReturnType<typeof buildComposerRunTimeline>;
type ComposerRunTimelineItem = ComposerRunTimeline["items"][number];

interface RunInspectOptions {
	json?: boolean;
	sessionDir?: string;
}

interface ReconstructionCountSummary {
	timelineItems: number;
	byType: Record<string, number>;
	byStatus: Record<string, number>;
	byVisibility: Record<string, number>;
}

interface ReconstructionCoverage {
	promptInputs: boolean;
	assistantResponses: boolean;
	toolRequests: boolean;
	toolResults: boolean;
	contextManifest: boolean;
	contextDiagnostics: boolean;
	fileChanges: boolean;
	artifacts: boolean;
	policyDecisions: boolean;
	diagnostics: boolean;
	compactions: boolean;
	pendingRequests: boolean;
	mcpContext: boolean;
}

interface PromptContextSummary {
	entries: number;
	projectDocs: number;
	mcpServers: number;
}

interface ContextManifestSummary {
	protocolVersion?: string;
	version?: number;
	cwd?: string;
	entries: number;
	projectDocs: number;
	mcpServers: number;
	mcpResources: number;
	mcpPrompts: number;
	diagnostics: number;
	byKind: Record<string, number>;
	bySource: Record<string, number>;
	byStatus: Record<string, number>;
	projectDocBytesRead?: number;
	projectDocMaxBytes?: number;
}

interface RunReconstructionReport {
	schemaVersion: typeof RUN_RECONSTRUCTION_SCHEMA;
	session: {
		id: string;
		title?: string;
		summary?: string;
		createdAt: string;
		updatedAt: string;
		messageCount: number;
		sessionFile: string;
		cwd?: string;
		model?: string;
	};
	counts: ReconstructionCountSummary;
	coverage: ReconstructionCoverage;
	promptContext: PromptContextSummary;
	contextManifest: ContextManifestSummary;
	timeline: ComposerRunTimeline;
	trajectory: AgentTrajectoryReport;
	trajectoryReplay: AgentTrajectoryReplayReport;
	trajectoryScore: AgentTrajectoryScoreReport;
	trajectoryInspection: AgentTrajectoryInspectionReport;
	agentRuntimeLedger: AgentRuntimeLedgerReport;
}

function usage(): string {
	return "Usage: maestro run inspect|ledger|replay|promote <session-id> [--json]";
}

function exitWithUsage(message: string): never {
	console.error(chalk.red(message));
	console.error(chalk.dim(usage()));
	process.exit(1);
}

function findHeader(entries: SessionEntry[]): SessionHeaderEntry | undefined {
	return entries.find(
		(entry): entry is SessionHeaderEntry => entry.type === "session",
	);
}

function promptContextSummary(
	header: SessionHeaderEntry | undefined,
	timeline: ComposerRunTimeline,
): PromptContextSummary {
	const manifest = header?.promptContextManifest;
	const entries = Array.isArray(
		(manifest as { entries?: unknown } | undefined)?.entries,
	)
		? ((manifest as { entries: unknown[] }).entries ?? [])
		: [];
	let projectDocs = 0;
	const mcpServers = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const kind = (entry as { kind?: unknown }).kind;
		const sourceKind = (entry as { sourceKind?: unknown }).sourceKind;
		const resourceKind = (entry as { resourceKind?: unknown }).resourceKind;
		if (
			kind === "project_doc" ||
			sourceKind === "project" ||
			sourceKind === "global"
		) {
			projectDocs += 1;
		} else if (kind === "mcp_server" || resourceKind === "mcp_server") {
			const serverName =
				(entry as { serverName?: unknown }).serverName ??
				(entry as { resourceId?: unknown }).resourceId ??
				(entry as { providerId?: unknown }).providerId ??
				(entry as { id?: unknown }).id;
			mcpServers.add(typeof serverName === "string" ? serverName : "unknown");
		}
	}
	for (const tool of header?.tools ?? []) {
		const mcpTool = parseMcpToolName(tool.name);
		if (mcpTool) {
			mcpServers.add(mcpTool.server);
		}
	}
	for (const item of timeline.items) {
		if (!item.toolName) continue;
		const mcpTool = parseMcpToolName(item.toolName);
		if (mcpTool) {
			mcpServers.add(mcpTool.server);
		}
	}
	return {
		entries: entries.length,
		projectDocs,
		mcpServers: mcpServers.size,
	};
}

function contextManifestSummary(
	header: SessionHeaderEntry | undefined,
	timeline: ComposerRunTimeline,
	promptContext: PromptContextSummary,
): ContextManifestSummary {
	const manifest = header?.unifiedContextManifest;
	const byKind: Record<string, number> = {};
	const bySource: Record<string, number> = {};
	const byStatus: Record<string, number> = {};
	const mcpServers = new Set<string>();
	let mcpResources = 0;
	let mcpPrompts = 0;
	let projectDocs = 0;

	for (const entry of manifest?.entries ?? []) {
		increment(byKind, entry.kind);
		increment(bySource, entry.source);
		increment(byStatus, entry.status);
		if (entry.kind === "project_doc") {
			projectDocs += 1;
		}
		if (entry.kind === "mcp_server") {
			mcpServers.add(entry.serverName ?? entry.id);
		}
		if (entry.kind === "mcp_resource") {
			mcpResources += 1;
			if (entry.serverName) {
				mcpServers.add(entry.serverName);
			}
		}
		if (entry.kind === "mcp_prompt") {
			mcpPrompts += 1;
			if (entry.serverName) {
				mcpServers.add(entry.serverName);
			}
		}
	}

	for (const tool of header?.tools ?? []) {
		const mcpTool = parseMcpToolName(tool.name);
		if (mcpTool) {
			mcpServers.add(mcpTool.server);
		}
	}
	for (const item of timeline.items) {
		if (!item.toolName) continue;
		const mcpTool = parseMcpToolName(item.toolName);
		if (mcpTool) {
			mcpServers.add(mcpTool.server);
		}
	}

	const summary: ContextManifestSummary = {
		entries: manifest?.entries.length ?? promptContext.entries,
		projectDocs: manifest ? projectDocs : promptContext.projectDocs,
		mcpServers: manifest ? mcpServers.size : promptContext.mcpServers,
		mcpResources,
		mcpPrompts,
		diagnostics: manifest?.diagnostics.length ?? 0,
		byKind,
		bySource,
		byStatus,
	};
	if (manifest) {
		summary.protocolVersion = manifest.protocolVersion;
		summary.version = manifest.version;
		summary.cwd = manifest.cwd;
		summary.projectDocBytesRead = manifest.projectDocs.bytesRead;
		if (manifest.projectDocs.maxBytes !== undefined) {
			summary.projectDocMaxBytes = manifest.projectDocs.maxBytes;
		}
	}
	return summary;
}

function increment(map: Record<string, number>, key: unknown): void {
	if (typeof key !== "string" || key.length === 0) return;
	map[key] = (map[key] ?? 0) + 1;
}

function countTimeline(
	timeline: ComposerRunTimeline,
): ReconstructionCountSummary {
	const byType: Record<string, number> = {};
	const byStatus: Record<string, number> = {};
	const byVisibility: Record<string, number> = {};
	for (const item of timeline.items) {
		increment(byType, item.type);
		increment(byStatus, item.status);
		increment(byVisibility, item.visibility);
	}
	return {
		timelineItems: timeline.items.length,
		byType,
		byStatus,
		byVisibility,
	};
}

function buildCoverage(
	counts: ReconstructionCountSummary,
	promptContext: PromptContextSummary,
	contextManifest: ContextManifestSummary,
): ReconstructionCoverage {
	return {
		promptInputs: (counts.byType["message.user"] ?? 0) > 0,
		assistantResponses: (counts.byType["message.assistant"] ?? 0) > 0,
		toolRequests: (counts.byType["tool.requested"] ?? 0) > 0,
		toolResults:
			(counts.byType["tool.completed"] ?? 0) +
				(counts.byType["tool.failed"] ?? 0) >
			0,
		contextManifest: contextManifest.protocolVersion !== undefined,
		contextDiagnostics: contextManifest.diagnostics > 0,
		fileChanges: (counts.byType["file.changed"] ?? 0) > 0,
		artifacts: (counts.byType["artifact.linked"] ?? 0) > 0,
		policyDecisions: (counts.byType["policy.decision"] ?? 0) > 0,
		diagnostics: (counts.byType["diagnostic.delta"] ?? 0) > 0,
		compactions: (counts.byType["compaction.created"] ?? 0) > 0,
		pendingRequests: (counts.byType["wait.pending"] ?? 0) > 0,
		mcpContext: contextManifest.mcpServers > 0 || promptContext.mcpServers > 0,
	};
}

async function buildRunReconstructionReport(
	sessionId: string,
	options: RunInspectOptions = {},
): Promise<RunReconstructionReport | null> {
	const manager = new SessionManager(false, undefined, {
		sessionDir: options.sessionDir,
	});
	const sessionFile = manager.getSessionFileById(sessionId);
	if (!sessionFile) {
		return null;
	}
	const [session, entries] = await Promise.all([
		manager.loadSession(sessionId),
		manager.loadEntries(sessionId),
	]);
	if (!session || !entries) {
		return null;
	}
	migrateToCurrentVersion(entries);

	const header = findHeader(entries);
	const timeline = buildComposerRunTimeline({
		sessionId,
		entries,
		messages: session.messages,
	});
	const trajectory = buildAgentTrajectoryReport(timeline);
	const trajectoryReplay = replayAgentTrajectoryReport(trajectory);
	const trajectoryScore = scoreAgentTrajectoryReport(
		trajectory,
		DEFAULT_AGENT_TRAJECTORY_REPLAY_LAB_RULES,
	);
	const trajectoryInspection = buildAgentTrajectoryInspectionReport({
		timelineItems: timeline.items,
		trajectory,
		replay: trajectoryReplay,
		score: trajectoryScore,
	});
	const agentRuntimeLedger = buildAgentRuntimeLedgerReport({
		session: {
			id: session.id,
			sessionFile,
			...(header?.cwd ? { cwd: header.cwd } : {}),
			...(header?.model ? { model: header.model } : {}),
		},
		timeline,
		trajectory,
		replay: trajectoryReplay,
	});
	const counts = countTimeline(timeline);
	const context = promptContextSummary(header, timeline);
	const contextManifest = contextManifestSummary(header, timeline, context);

	const sessionReport: RunReconstructionReport["session"] = {
		id: session.id,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		messageCount: session.messageCount,
		sessionFile,
	};
	if (session.title) {
		sessionReport.title = session.title;
	}
	if (session.summary) {
		sessionReport.summary = session.summary;
	}
	if (header?.cwd) {
		sessionReport.cwd = header.cwd;
	}
	if (header?.model) {
		sessionReport.model = header.model;
	}

	return {
		schemaVersion: RUN_RECONSTRUCTION_SCHEMA,
		session: sessionReport,
		counts,
		coverage: buildCoverage(counts, context, contextManifest),
		promptContext: context,
		contextManifest,
		timeline,
		trajectory,
		trajectoryReplay,
		trajectoryScore,
		trajectoryInspection,
		agentRuntimeLedger,
	};
}

function renderCoverage(coverage: ReconstructionCoverage): string {
	const labels: Array<[keyof ReconstructionCoverage, string]> = [
		["promptInputs", "prompt inputs"],
		["assistantResponses", "assistant responses"],
		["toolRequests", "tool requests"],
		["toolResults", "tool results"],
		["contextManifest", "context manifest"],
		["contextDiagnostics", "context diagnostics"],
		["fileChanges", "file changes"],
		["artifacts", "artifacts"],
		["policyDecisions", "policy decisions"],
		["diagnostics", "diagnostics"],
		["compactions", "compactions"],
		["pendingRequests", "pending waits"],
		["mcpContext", "MCP context"],
	];
	return labels
		.map(([key, label]) => `${coverage[key] ? "yes" : "no"} ${label}`)
		.join(", ");
}

function renderTimelinePreview(timeline: ComposerRunTimeline): string[] {
	return timeline.items.slice(0, 12).map((item: ComposerRunTimelineItem) => {
		const parts = [
			item.timestamp,
			item.type,
			item.status,
			item.title,
			item.summary,
		].filter(Boolean);
		return `  - ${parts.join(" | ")}`;
	});
}

function renderRunReconstruction(report: RunReconstructionReport): string {
	const lines = [
		chalk.bold(`Run reconstruction: ${report.session.id}`),
		`Session file: ${report.session.sessionFile}`,
		`Messages: ${report.session.messageCount}`,
		`Timeline items: ${report.counts.timelineItems}`,
		`Trajectory events: ${report.trajectory.counts.events}`,
		`Replay deltas: ${report.trajectoryReplay.counts.deltas} (${report.trajectoryReplay.counts.errors} errors, ${report.trajectoryReplay.counts.warnings} warnings)`,
		`Trajectory score: ${report.trajectoryScore.counts.failed} failed, ${report.trajectoryScore.counts.warnings} warnings across ${report.trajectoryScore.counts.rules} rule(s)`,
		`Replay lab: ${report.trajectoryInspection.counts.jumpTargets} event/source jump target(s), redaction=${report.trajectoryInspection.redaction.default}`,
		`AgentRuntime ledger: ${report.agentRuntimeLedger.counts.entries} entries, ${report.agentRuntimeLedger.counts.promotionOperations} dry-run promotion op(s), replay deterministic=${report.agentRuntimeLedger.replay.deterministic ? "yes" : "no"}`,
		`Coverage: ${renderCoverage(report.coverage)}`,
		`Prompt context: ${report.promptContext.entries} entries (${report.promptContext.projectDocs} docs, ${report.promptContext.mcpServers} MCP servers)`,
		`Context manifest: ${report.contextManifest.entries} entries (${report.contextManifest.projectDocs} docs, ${report.contextManifest.mcpServers} MCP servers, ${report.contextManifest.mcpResources} resources, ${report.contextManifest.mcpPrompts} prompts, ${report.contextManifest.diagnostics} diagnostics)`,
		"",
		chalk.bold("Timeline preview"),
		...renderTimelinePreview(report.timeline),
	];
	if (report.timeline.items.length > 12) {
		lines.push(`  ... ${report.timeline.items.length - 12} more item(s)`);
	}
	return lines.join("\n");
}

export async function handleRunCommand(
	subcommand?: string,
	args: string[] = [],
	options: RunInspectOptions = {},
): Promise<void> {
	if (
		subcommand !== "inspect" &&
		subcommand !== "ledger" &&
		subcommand !== "replay" &&
		subcommand !== "promote"
	) {
		exitWithUsage("Run subcommand required.");
	}
	const sessionId = args.find((arg) => !arg.startsWith("-"));
	if (!sessionId) {
		exitWithUsage("Session id required.");
	}

	const report = await buildRunReconstructionReport(sessionId, options);
	if (!report) {
		exitWithUsage(`Session not found: ${sessionId}`);
	}

	if (subcommand === "ledger") {
		console.log(JSON.stringify(report.agentRuntimeLedger, null, 2));
		return;
	}
	if (subcommand === "replay") {
		console.log(JSON.stringify(report.agentRuntimeLedger.replay, null, 2));
		return;
	}
	if (subcommand === "promote") {
		console.log(JSON.stringify(report.agentRuntimeLedger.promotion, null, 2));
		return;
	}

	if (options.json || args.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	console.log(renderRunReconstruction(report));
}

export const testing = {
	buildRunReconstructionReport,
	renderRunReconstruction,
};
