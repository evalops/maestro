import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	type Stats,
	existsSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import {
	basename,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	type AgentWorkBoard,
	type GitHubAgentWorkProjection,
	buildAgentWorkBoard,
} from "../agent/agent-work-board.js";
import type { MissionManifest } from "../agent/mission-manifest.js";
import {
	type MissionStoreSnapshot,
	getMissionDir,
	listMissionStoreSnapshots,
	sanitizeMissionId,
} from "../agent/mission-store.js";
import { PATHS, SESSION_CONFIG } from "../config/constants.js";
import {
	type A2ACockpitNextAction,
	classifyTaskState,
	summarizeA2ACockpit,
} from "../platform/a2a-cockpit.js";
import type { A2AFleetSummary } from "../platform/a2a-fleet.js";
import {
	type A2ATaskLedgerEntry,
	a2aTaskEvidenceGaps,
	getA2ATaskLedgerPath,
	isAuditReadyA2ADelegationTask,
	isFinalA2AState,
	loadA2ATaskLedger,
	summarizeA2ATaskLedger,
} from "../platform/a2a-task-ledger.js";
import {
	formatA2AWorkGraphCodexSubagents,
	formatA2AWorkGraphSummary,
} from "../platform/a2a-work-graph.js";
import { type RuntimeEnv, defaultRuntimeEnv } from "../runtime/env.js";
import {
	buildSessionFileInfo,
	safeReadSessionEntries,
} from "../session/session-context.js";
import type { SessionEntry } from "../session/types.js";
import { type TodoStore, loadStore } from "../tools/todo.js";
import {
	type UsageEntry,
	type UsageFilterOptions,
	getUsageEntries,
} from "../tracking/cost-tracker.js";
import { writeTextFileAtomic } from "../utils/fs.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE_ACTIVITY_GRACE_MS = 5 * 60 * 1000;
const CUSTOMER_VALUE_MANIFEST_VERSION = "maestro.customer-value.manifest.v1";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function ambientLearnerPresenceCommand(learnerPath: string): string {
	return `test -s ${shellQuote(learnerPath)}`;
}

export interface CustomerValueRange {
	label: string;
	since?: number;
	until?: number;
}

export interface CustomerValueOptions {
	period?: string;
	sessionDir?: string;
	telemetryPath?: string;
	a2aTasksPath?: string;
	ambientLearnerPath?: string;
	env?: RuntimeEnv;
	flushAmbientLearner?: boolean;
	ambientLearnerFlush?: (env: RuntimeEnv) => Promise<AmbientLearnerFlushResult>;
	sessionLimit?: number;
	workspaceDir?: string;
	now?: number;
	missionManifests?: readonly MissionManifest[];
	todoStore?: TodoStore;
	githubTasks?: readonly GitHubAgentWorkProjection[];
}

export interface AmbientLearnerFlushResult {
	flushed: boolean;
	learnerPath?: string;
	collectionGap?: string;
}

export interface CustomerValueArtifactManifest {
	protocolVersion: typeof CUSTOMER_VALUE_MANIFEST_VERSION;
	generatedAt: string;
	range: CustomerValueRange;
	artifacts: {
		reportJsonPath: string;
		reportMarkdownPath: string;
	};
	hashes: {
		reportJsonSha256: string;
		reportMarkdownSha256: string;
	};
	sources: CustomerValueReport["sources"] & {
		sessionPaths: string[];
	};
	summary: CustomerValueReport["summary"];
	coverage: {
		trustCardCount: number;
		memoryProvenanceCount: number;
		multiAgentTaskCount: number;
		multiAgentWorkGraphTaskCount: number;
		policyApprovalAuditEvents: number;
		collectionGapCount: number;
		handoffCount: number;
		openWorkCount: number;
		ambientAutomationOpportunityCount: number;
		playbookLearningOpportunityCount: number;
		agentWorkItemCount: number;
	};
	controls: Array<{
		id: string;
		status: "available" | "gap";
	}>;
}

export interface CustomerValueArtifactWriteOptions {
	outputDir?: string;
}

export interface CustomerValueArtifactWriteResult {
	outputDir: string;
	reportJsonPath: string;
	reportMarkdownPath: string;
	manifestPath: string;
	reportJsonSha256: string;
	reportMarkdownSha256: string;
	manifestSha256: string;
	manifest: CustomerValueArtifactManifest;
}

export interface TrustCard {
	sessionId: string;
	title: string;
	cwd?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	assistantTurnCount: number;
	toolCallCount: number;
	failedToolResultCount: number;
	topTools: Array<{ name: string; count: number }>;
	summary?: string;
	task?: string;
	usage: {
		requests: number;
		tokens: number;
		costUsd: number;
	};
	evidence: {
		sessionPath: string;
		hasSummary: boolean;
		hasMemoryProvenance: boolean;
		memoryExtractionHash?: string;
	};
	customerSignals: string[];
	riskSignals: string[];
}

type WorkflowOpportunityId =
	| "fix-failing-ci"
	| "review-pr"
	| "coordinate-agent-swarm"
	| "ambient-nightly-watchdog"
	| "playbook-learning-review"
	| "cut-release"
	| "triage-dependabot"
	| "refactor-with-tests";

export interface WorkflowOpportunity {
	id: WorkflowOpportunityId;
	name: string;
	customerOutcome: string;
	evidenceSignal: string;
	recommendedSurface: string;
	workflowTemplate: {
		path: string;
		yaml: string;
	};
}

export interface CustomerValueHandoff {
	sessionId: string;
	title: string;
	status: "delivered" | "needs-followup" | "blocked";
	delivered: string;
	unfinished?: string;
	blockers: string[];
	nextAction: string;
	evidence: {
		sessionPath: string;
		updatedAt: string;
		summaryStored: boolean;
		memoryBacked: boolean;
	};
}

export interface CustomerValueOpenWorkItem {
	goal: string;
	id: string;
	content: string;
	status: "pending" | "in_progress";
	priority: "high" | "medium" | "low";
	updatedAt: string;
	blockers: string[];
}

export interface CustomerValueReport {
	generatedAt: string;
	range: CustomerValueRange;
	sources: {
		sessionDir: string;
		telemetryPath: string;
		usagePath: string;
		a2aTasksPath: string;
		ambientLearnerPath: string;
	};
	summary: {
		sessionCount: number;
		trustCardCount: number;
		messageCount: number;
		assistantTurnCount: number;
		toolCallCount: number;
		failedToolResultCount: number;
		usageRequests: number;
		totalTokens: number;
		totalCostUsd: number;
		estimatedHoursSaved: number;
		estimatedValueUsd: number;
		valueMultiple: number | null;
		memoryBackedSessionCount: number;
		multiAgentEstimatedHoursSaved: number;
		multiAgentEstimatedValueUsd: number;
		multiAgentTaskCount: number;
		multiAgentPeerCount: number;
		multiAgentWorkGraphTaskCount: number;
		multiAgentChildRunCount: number;
		ambientAutomationOpportunityCount: number;
		playbookLearningOpportunityCount: number;
		ambientLearnerOutcomeCount: number;
		ambientProtectedTransientFailureCount: number;
	};
	trustCards: TrustCard[];
	multiAgent: MultiAgentValue;
	ambient: AmbientCustomerValue;
	workflows: WorkflowOpportunity[];
	memory: {
		provenanceCount: number;
		items: Array<{
			sessionId: string;
			title: string;
			cwd?: string;
			memoryExtractionHash: string;
			sessionPath: string;
		}>;
	};
	handoffs: {
		deliveredCount: number;
		followupCount: number;
		blockedCount: number;
		openWorkCount: number;
		sessions: CustomerValueHandoff[];
		openWork: CustomerValueOpenWorkItem[];
	};
	agentWorkBoard: AgentWorkBoard;
	admin: {
		controls: Array<{
			id: string;
			name: string;
			status: "available" | "gap";
			evidence: string;
		}>;
	};
	telemetry: {
		parsedEventCount: number;
		malformedLineCount: number;
		toolExecutionEvents: number;
		evaluationEvents: number;
		canonicalTurnEvents: number;
		policyApprovalAuditEvents: number;
		collectionGaps: string[];
	};
	collectionGaps: string[];
	referenceLearnings: string[];
}

export interface AmbientCustomerValue {
	learnerPath: string;
	outcomeCount: number;
	successCount: number;
	failureCount: number;
	successRate: number | null;
	totalCostUsd: number;
	patternCount: number;
	actionablePatternCount: number;
	protectedTransientFailureCount: number;
	automationOpportunities: AmbientAutomationOpportunity[];
	playbookLearningOpportunities: PlaybookLearningOpportunity[];
	collectionGaps: string[];
}

export interface AmbientAutomationOpportunity {
	id:
		| "a2a-followup-watchdog"
		| "failed-tool-digest"
		| "memory-gap-digest"
		| "ambient-learner-review";
	customerOutcome: string;
	triggerEvidence: string;
	recommendedCadence: "hourly" | "daily" | "weekly";
	scriptGate: string;
	delivery: string;
}

export interface PlaybookLearningOpportunity {
	id:
		| "protect-transient-failures"
		| "capture-successful-pattern"
		| "repair-low-success-pattern"
		| "multi-agent-verification-playbook"
		| "handoff-memory-playbook";
	customerOutcome: string;
	evidenceSignal: string;
	guardrail: string;
	recommendedArtifact: string;
}

export interface MultiAgentValue {
	tasksPath: string;
	taskCount: number;
	delegatedTaskCount: number;
	peerCount: number;
	completedTaskCount: number;
	failedTaskCount: number;
	actionRequiredTaskCount: number;
	workGraphTaskCount: number;
	workGraphChildRunCount: number;
	workGraphBlockedItemCount: number;
	workGraphWaitingItemCount: number;
	workGraphPendingToolCallCount: number;
	codexSubagentEdgeCount: number;
	transcriptMessageCount: number;
	realizedHoursSaved: number;
	realizedValueUsd: number;
	pendingTaskCount: number;
	auditReadyTaskCount: number;
	evidenceGapCount: number;
	delegatedFailedTaskCount: number;
	delegatedPendingTaskCount: number;
	delegatedEvidenceGapCount: number;
	nextActions: Array<{
		id: string;
		label: string;
		command: string;
		severity: A2ACockpitNextAction["severity"];
		peer: string;
		taskId?: string;
		reason: string;
	}>;
	topPeers: Array<{
		peer: string;
		displayName?: string;
		taskCount: number;
		completedTaskCount: number;
		failedTaskCount: number;
		actionRequiredTaskCount: number;
	}>;
	recentTasks: Array<{
		id: string;
		peer: string;
		peerDisplayName?: string;
		state: string;
		status: "waiting" | "running" | "completed" | "failed" | "unknown";
		text: string;
		updatedAt: string;
		completedAt?: string;
		workGraph: boolean;
		workGraphSummary?: string;
		codexSubagents?: string;
		responseText?: string;
	}>;
	collectionGaps: string[];
}

interface SessionAnalysis {
	card: TrustCard;
	timestamp: number;
}

interface TelemetrySummary {
	parsedEventCount: number;
	malformedLineCount: number;
	toolExecutionEvents: number;
	evaluationEvents: number;
	canonicalTurnEvents: number;
	policyApprovalAuditEvents: number;
	collectionGaps: string[];
}

interface AmbientLearningSummary {
	learnerPath: string;
	outcomes: AmbientLearnerOutcome[];
	patterns: AmbientLearnerPattern[];
	collectionGaps: string[];
}

interface AmbientLearnerOutcome {
	success: boolean;
	failureReason?: string;
	labels: string[];
	repo?: string;
	taskType?: string;
	eventType?: string;
	costUsd: number;
	timestamp?: number;
}

interface AmbientLearnerPattern {
	patternType: string;
	key: string;
	successRate: number;
	sampleCount: number;
	successCount: number;
	transientFailureCount: number;
	nonTransientFailureCount: number;
	nonTransientSampleCount: number;
	nonTransientSuccessRate: number | null;
}

export function resolveCustomerValueRange(
	period: string | undefined,
	now = Date.now(),
): CustomerValueRange {
	switch (period ?? "30d") {
		case "today":
			return {
				label: "Today",
				since: new Date(now).setHours(0, 0, 0, 0),
			};
		case "yesterday": {
			const start = new Date(now);
			start.setDate(start.getDate() - 1);
			const end = new Date(now);
			return {
				label: "Yesterday",
				since: start.setHours(0, 0, 0, 0),
				until: end.setHours(0, 0, 0, 0),
			};
		}
		case "week":
		case "7d":
			return { label: "Last 7 Days", since: now - 7 * DAY_MS };
		case "all":
			return { label: "All Time" };
		case "month":
		case "30d":
			return { label: "Last 30 Days", since: now - 30 * DAY_MS };
		default:
			return { label: "Last 30 Days", since: now - 30 * DAY_MS };
	}
}

export async function buildCustomerValueReport(
	options: CustomerValueOptions = {},
): Promise<CustomerValueReport> {
	const now = options.now ?? Date.now();
	const range = resolveCustomerValueRange(options.period, now);
	const sessionDir = options.sessionDir ?? SESSION_CONFIG.DEFAULT_DIR;
	const telemetryPath = options.telemetryPath ?? PATHS.TELEMETRY_LOG;
	const a2aTasksPath = getA2ATaskLedgerPath(options.a2aTasksPath);
	const env = options.env ?? defaultRuntimeEnv();
	const requestedAmbientLearnerPath =
		options.ambientLearnerPath ??
		env.ambientLearnerFile ??
		env.ambientLearnerDefaultFile;
	const workspaceDir = options.workspaceDir ?? process.cwd();
	const usageEntries = getUsageEntries(usageFilters(range));
	const usageEntriesBySession = groupUsageEntriesBySession(usageEntries);
	const trustCards = collectTrustCards({
		sessionDir,
		range,
		limit: options.sessionLimit,
		usageEntriesBySession,
	});
	const ambientLearningPromise = (async () => {
		const flushResult =
			options.flushAmbientLearner === false
				? undefined
				: await flushAmbientLearnerForReport(
						env,
						requestedAmbientLearnerPath,
						options.ambientLearnerFlush ?? flushAmbientLearnerBeforeRead,
					);
		return summarizeAmbientLearning(
			flushResult?.learnerPath ?? requestedAmbientLearnerPath,
			range,
			flushResult,
			requestedAmbientLearnerPath,
		);
	})();
	const [telemetry, multiAgent, ambientLearning] = await Promise.all([
		summarizeTelemetry(telemetryPath, range),
		summarizeMultiAgentValue(a2aTasksPath, range),
		ambientLearningPromise,
	]);
	const memoryItems = trustCards
		.filter((card) => card.evidence.memoryExtractionHash)
		.map((card) => ({
			sessionId: card.sessionId,
			title: card.title,
			...(card.cwd ? { cwd: card.cwd } : {}),
			memoryExtractionHash: card.evidence.memoryExtractionHash!,
			sessionPath: card.evidence.sessionPath,
		}));
	const todoStore = options.todoStore
		? sanitizeCustomerValueTodoStore(options.todoStore)
		: await loadCustomerValueTodoStore();
	const handoffs = buildCustomerValueHandoffs(trustCards, todoStore);
	const ambient = buildAmbientCustomerValue({
		learning: ambientLearning,
		multiAgent,
		trustCards,
		handoffs,
	});
	const agentWorkBoard = await buildCustomerValueWorkBoard({
		tasksPath: a2aTasksPath,
		range,
		workspaceDir,
		missions: options.missionManifests,
		todos: todoStore,
		handoffs: handoffs.sessions,
		openWork: handoffs.openWork,
		githubTasks: options.githubTasks,
		missionStoreDir: env.missionStoreDir,
		now,
	});
	const summary = summarizeCustomerValue({
		ambient,
		multiAgent,
		trustCards,
	});
	const workflows = buildWorkflowOpportunities(trustCards, multiAgent, ambient);
	const admin = buildAdminControls({
		ambient,
		multiAgent,
		trustCards,
		telemetry,
		sessionDir,
	});
	const collectionGaps = buildCollectionGaps({
		multiAgent,
		trustCards,
		telemetry,
		usageEntries,
		ambient,
	});

	return {
		generatedAt: new Date(now).toISOString(),
		range,
		sources: {
			sessionDir,
			telemetryPath,
			usagePath: PATHS.USAGE_FILE,
			a2aTasksPath,
			ambientLearnerPath: ambientLearning.learnerPath,
		},
		summary,
		trustCards,
		multiAgent,
		ambient,
		workflows,
		memory: {
			provenanceCount: memoryItems.length,
			items: memoryItems,
		},
		handoffs,
		agentWorkBoard,
		admin,
		telemetry,
		collectionGaps,
		referenceLearnings: [
			"Effectiveness reports should be generated from persisted evidence, not self-assessment.",
			"Customer metrics need stable names and operator-facing rollups close to tool execution.",
			"Session artifacts should be named, durable, and replayable enough for another human to audit.",
			"Workflow templates are most useful when they state the customer outcome and required evidence.",
			"Multi-agent value is clearest when delegated task ledgers show owner, peer, state, transcript, and work graph evidence.",
			"Durable customer value comes from structured handoffs: delivered work, unfinished work, blockers, and next action.",
			"Ambient automation should wake the agent only when local evidence says there is customer-visible work to deliver.",
			"Learning loops should persist durable playbooks and explicitly quarantine transient environment failures.",
		],
	};
}

export function formatCustomerValueReport(report: CustomerValueReport): string {
	const lines = [
		`Customer Value Report (${report.range.label})`,
		"=====================",
		"",
		`Generated: ${report.generatedAt}`,
		`Sessions: ${report.summary.sessionCount}`,
		`Trust cards: ${report.summary.trustCardCount}`,
		`Messages: ${report.summary.messageCount}`,
		`Tool calls: ${report.summary.toolCallCount}`,
		`Failed tool results: ${report.summary.failedToolResultCount}`,
		`Usage: ${report.summary.usageRequests} requests, ${formatNumber(report.summary.totalTokens)} tokens, $${report.summary.totalCostUsd.toFixed(4)}`,
		`Estimated value: ${report.summary.estimatedHoursSaved.toFixed(1)} hours / $${report.summary.estimatedValueUsd.toFixed(2)}${report.summary.valueMultiple === null ? "" : ` (${report.summary.valueMultiple.toFixed(1)}x spend)`}`,
		`Multi-agent realized value: ${report.summary.multiAgentEstimatedHoursSaved.toFixed(1)} hours / $${report.summary.multiAgentEstimatedValueUsd.toFixed(2)}`,
		`Memory-backed sessions: ${report.summary.memoryBackedSessionCount}`,
		`Multi-agent tasks: ${report.summary.multiAgentTaskCount} across ${report.summary.multiAgentPeerCount} peer(s), ${report.summary.multiAgentWorkGraphTaskCount} with work graphs, ${report.summary.multiAgentChildRunCount} child run(s)`,
		`Ambient opportunities: ${report.summary.ambientAutomationOpportunityCount} automation(s), ${report.summary.playbookLearningOpportunityCount} playbook update(s), ${report.summary.ambientLearnerOutcomeCount} learner outcome(s)`,
		`Agent work board: ${report.agentWorkBoard.counts.total} item(s), ${report.agentWorkBoard.counts.blocked} blocked, ${report.agentWorkBoard.counts.waiting} waiting`,
		"",
		"Top Trust Cards",
		"---------------",
	];

	if (report.trustCards.length === 0) {
		lines.push("No sessions found for this range.", "");
	} else {
		for (const card of report.trustCards.slice(0, 5)) {
			lines.push(
				`- ${card.title} (${card.sessionId})`,
				`  ${card.messageCount} messages, ${card.toolCallCount} tool calls, $${card.usage.costUsd.toFixed(4)} spend`,
				`  Evidence: ${card.evidence.sessionPath}`,
			);
			if (card.summary) {
				lines.push(`  Summary: ${card.summary}`);
			}
			if (card.riskSignals.length > 0) {
				lines.push(`  Risk: ${card.riskSignals.join("; ")}`);
			}
		}
		lines.push("");
	}

	lines.push("Multi-Agent Coordination", "------------------------");
	if (report.multiAgent.taskCount === 0) {
		lines.push(
			...(report.multiAgent.collectionGaps.length > 0
				? report.multiAgent.collectionGaps.map((gap) => `- ${gap}`)
				: ["No A2A delegated tasks found for this range."]),
			"",
		);
	} else {
		lines.push(
			`Decision: ${multiAgentDecisionLine(report.multiAgent)}`,
			`Realized value: ${report.multiAgent.realizedHoursSaved.toFixed(1)} hours / $${report.multiAgent.realizedValueUsd.toFixed(2)} from completed delegated work`,
			`Pending work: ${report.multiAgent.delegatedPendingTaskCount} task(s), ${report.multiAgent.delegatedEvidenceGapCount} evidence gap(s), ${report.multiAgent.auditReadyTaskCount} audit-ready task(s)`,
			`Tasks: ${report.multiAgent.taskCount} total, ${report.multiAgent.completedTaskCount} completed, ${report.multiAgent.failedTaskCount} failed, ${report.multiAgent.actionRequiredTaskCount} waiting on input`,
			`Peers: ${report.multiAgent.peerCount}; workGraph-backed tasks: ${report.multiAgent.workGraphTaskCount}`,
			`Work graph pressure: ${report.multiAgent.workGraphBlockedItemCount} blocked item(s), ${report.multiAgent.workGraphWaitingItemCount} waiting item(s), ${report.multiAgent.workGraphPendingToolCallCount} pending tool call(s), ${report.multiAgent.workGraphChildRunCount} child run(s)`,
			`Evidence: ${report.multiAgent.tasksPath}`,
		);
		if (report.multiAgent.topPeers.length > 0) {
			lines.push("Peer rollup:");
			for (const peer of report.multiAgent.topPeers) {
				lines.push(
					`- ${peer.displayName ?? peer.peer}: ${peer.taskCount} task(s), ${peer.completedTaskCount} completed, ${peer.failedTaskCount} failed, ${peer.actionRequiredTaskCount} waiting`,
				);
			}
		}
		if (report.multiAgent.nextActions.length > 0) {
			lines.push("Next actions:");
			for (const action of report.multiAgent.nextActions) {
				lines.push(
					`- [${action.severity}] ${action.label}`,
					`  Command: ${action.command}`,
					`  Reason: ${action.reason}`,
				);
			}
		}
		for (const task of report.multiAgent.recentTasks) {
			lines.push(
				`- ${task.peerDisplayName ?? task.peer}: ${task.status} (${task.state})`,
				`  ${task.text}`,
			);
			if (task.responseText) {
				lines.push(`  Response: ${task.responseText}`);
			}
			if (task.workGraphSummary) {
				lines.push(`  ${task.workGraphSummary}`);
			}
			if (task.codexSubagents) {
				lines.push(`  ${task.codexSubagents}`);
			}
		}
		lines.push("");
	}

	lines.push(
		"Durable Handoffs",
		"-----------------",
		`Delivered: ${report.handoffs.deliveredCount}, follow-up: ${report.handoffs.followupCount}, blocked: ${report.handoffs.blockedCount}, open work: ${report.handoffs.openWorkCount}`,
	);
	for (const handoff of report.handoffs.sessions.slice(0, 5)) {
		lines.push(
			`- ${handoff.title} (${handoff.status})`,
			`  Delivered: ${handoff.delivered}`,
			`  Next: ${handoff.nextAction}`,
			`  Evidence: ${handoff.evidence.sessionPath}`,
		);
		if (handoff.unfinished) {
			lines.push(`  Unfinished: ${handoff.unfinished}`);
		}
	}
	if (report.handoffs.openWork.length > 0) {
		lines.push("  Open work:");
		for (const item of report.handoffs.openWork.slice(0, 5)) {
			const blockers =
				item.blockers.length > 0
					? ` blocked by ${item.blockers.join(", ")}`
					: "";
			lines.push(
				`  - [${item.status}] ${item.content} (${item.goal}, ${item.priority})${blockers}`,
			);
		}
	}
	lines.push("");

	lines.push(
		"Ambient Automation",
		"-------------------",
		`Learner outcomes: ${report.ambient.outcomeCount}, success rate: ${report.ambient.successRate === null ? "n/a" : `${(report.ambient.successRate * 100).toFixed(1)}%`}, protected transient failures: ${report.ambient.protectedTransientFailureCount}`,
		`Learner evidence: ${report.ambient.learnerPath}`,
	);
	if (report.ambient.automationOpportunities.length === 0) {
		lines.push("No ambient automation opportunities found for this range.");
	} else {
		for (const opportunity of report.ambient.automationOpportunities) {
			lines.push(
				`- ${opportunity.id}: ${opportunity.customerOutcome}`,
				`  Trigger: ${opportunity.triggerEvidence}`,
				`  Cadence: ${opportunity.recommendedCadence}; gate: ${opportunity.scriptGate}`,
				`  Delivery: ${opportunity.delivery}`,
			);
		}
	}
	lines.push("");

	lines.push("Playbook Learning", "-----------------");
	if (report.ambient.playbookLearningOpportunities.length === 0) {
		lines.push("No playbook learning opportunities found for this range.");
	} else {
		for (const opportunity of report.ambient.playbookLearningOpportunities) {
			lines.push(
				`- ${opportunity.id}: ${opportunity.customerOutcome}`,
				`  Evidence: ${opportunity.evidenceSignal}`,
				`  Guardrail: ${opportunity.guardrail}`,
				`  Artifact: ${opportunity.recommendedArtifact}`,
			);
		}
	}
	lines.push("");

	lines.push(
		"Agent Work Board",
		"----------------",
		`Items: ${report.agentWorkBoard.counts.total}; blocked: ${report.agentWorkBoard.counts.blocked}; waiting: ${report.agentWorkBoard.counts.waiting}; running: ${report.agentWorkBoard.counts.running}`,
	);
	for (const item of report.agentWorkBoard.items.slice(0, 8)) {
		lines.push(`- [${item.source}/${item.status}] ${item.title}`);
		if (item.owner) {
			lines.push(`  Owner: ${item.owner}`);
		}
		if (item.nextAction) {
			lines.push(
				`  Next: ${item.nextAction.label}${item.nextAction.command ? ` (${item.nextAction.command})` : ""}`,
			);
		}
	}
	lines.push("");

	lines.push("Workflow Opportunities", "----------------------");
	for (const workflow of report.workflows) {
		lines.push(
			`- ${workflow.name}: ${workflow.customerOutcome}`,
			`  Evidence: ${workflow.evidenceSignal}`,
			`  Surface: ${workflow.recommendedSurface}`,
			`  Template: ${workflow.workflowTemplate.path}`,
		);
	}
	lines.push("");

	lines.push("Admin Controls", "--------------");
	for (const control of report.admin.controls) {
		lines.push(
			`- ${control.name}: ${control.status}`,
			`  Evidence: ${control.evidence}`,
		);
	}
	lines.push("");

	if (report.collectionGaps.length > 0) {
		lines.push("Collection Gaps", "---------------");
		for (const gap of report.collectionGaps) {
			lines.push(`- ${gap}`);
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

export function formatCustomerValueMarkdown(
	report: CustomerValueReport,
): string {
	const lines = [
		`# Customer Value Report (${report.range.label})`,
		"",
		`Generated: ${report.generatedAt}`,
		"",
		"## Summary",
		"",
		`- Sessions: ${report.summary.sessionCount}`,
		`- Trust cards: ${report.summary.trustCardCount}`,
		`- Tool calls: ${report.summary.toolCallCount}`,
		`- Failed tool results: ${report.summary.failedToolResultCount}`,
		`- Usage: ${report.summary.usageRequests} requests, ${formatNumber(report.summary.totalTokens)} tokens, $${report.summary.totalCostUsd.toFixed(4)}`,
		`- Estimated value: ${report.summary.estimatedHoursSaved.toFixed(1)} hours / $${report.summary.estimatedValueUsd.toFixed(2)}`,
		`- Multi-agent realized value: ${report.summary.multiAgentEstimatedHoursSaved.toFixed(1)} hours / $${report.summary.multiAgentEstimatedValueUsd.toFixed(2)}`,
		`- Multi-agent tasks: ${report.summary.multiAgentTaskCount} across ${report.summary.multiAgentPeerCount} peer(s), ${report.summary.multiAgentWorkGraphTaskCount} with work graphs, ${report.summary.multiAgentChildRunCount} child run(s)`,
		`- Ambient opportunities: ${report.summary.ambientAutomationOpportunityCount} automation(s), ${report.summary.playbookLearningOpportunityCount} playbook update(s)`,
		`- Ambient learner outcomes: ${report.summary.ambientLearnerOutcomeCount}`,
		"",
		"## Trust Cards",
		"",
	];

	for (const card of report.trustCards) {
		lines.push(
			`### ${card.title}`,
			"",
			`- Session: \`${card.sessionId}\``,
			`- Evidence: \`${card.evidence.sessionPath}\``,
			`- Messages/tool calls: ${card.messageCount}/${card.toolCallCount}`,
			`- Usage: ${card.usage.requests} requests, ${formatNumber(card.usage.tokens)} tokens, $${card.usage.costUsd.toFixed(4)}`,
		);
		if (card.summary) lines.push(`- Summary: ${card.summary}`);
		if (card.customerSignals.length > 0) {
			lines.push(`- Customer signals: ${card.customerSignals.join("; ")}`);
		}
		if (card.riskSignals.length > 0) {
			lines.push(`- Risk signals: ${card.riskSignals.join("; ")}`);
		}
		lines.push("");
	}

	lines.push("## Multi-Agent Coordination", "");
	if (report.multiAgent.taskCount === 0) {
		lines.push(
			...(report.multiAgent.collectionGaps.length > 0
				? report.multiAgent.collectionGaps.map((gap) => `- ${gap}`)
				: ["- No A2A delegated tasks found for this range."]),
			"",
		);
	} else {
		lines.push(
			`- Decision: ${multiAgentDecisionLine(report.multiAgent)}`,
			`- Realized value: ${report.multiAgent.realizedHoursSaved.toFixed(1)} hours / $${report.multiAgent.realizedValueUsd.toFixed(2)} from completed delegated work`,
			`- Pending work: ${report.multiAgent.delegatedPendingTaskCount} task(s)`,
			`- Audit-ready tasks: ${report.multiAgent.auditReadyTaskCount}`,
			`- Evidence gaps: ${report.multiAgent.delegatedEvidenceGapCount}`,
			`- Evidence: \`${report.multiAgent.tasksPath}\``,
			`- Tasks: ${report.multiAgent.taskCount} total, ${report.multiAgent.completedTaskCount} completed, ${report.multiAgent.failedTaskCount} failed, ${report.multiAgent.actionRequiredTaskCount} waiting on input`,
			`- Peers: ${report.multiAgent.peerCount}`,
			`- WorkGraph-backed tasks: ${report.multiAgent.workGraphTaskCount}`,
			`- Child runs: ${report.multiAgent.workGraphChildRunCount}`,
			`- Blocked/waiting work graph items: ${report.multiAgent.workGraphBlockedItemCount}/${report.multiAgent.workGraphWaitingItemCount}`,
			`- Pending tool calls: ${report.multiAgent.workGraphPendingToolCallCount}`,
			`- Codex subagent lifecycle edges: ${report.multiAgent.codexSubagentEdgeCount}`,
			`- Transcript messages: ${report.multiAgent.transcriptMessageCount}`,
			"",
		);
		if (report.multiAgent.topPeers.length > 0) {
			lines.push("### Peer Rollup", "");
			for (const peer of report.multiAgent.topPeers) {
				lines.push(
					`- ${peer.displayName ?? peer.peer}: ${peer.taskCount} task(s), ${peer.completedTaskCount} completed, ${peer.failedTaskCount} failed, ${peer.actionRequiredTaskCount} waiting`,
				);
			}
			lines.push("");
		}
		if (report.multiAgent.nextActions.length > 0) {
			lines.push("### Next Actions", "");
			for (const action of report.multiAgent.nextActions) {
				lines.push(
					`- **${action.severity}** ${action.label}`,
					`  - Command: \`${action.command}\``,
					`  - Reason: ${action.reason}`,
				);
			}
			lines.push("");
		}
		for (const task of report.multiAgent.recentTasks) {
			lines.push(
				`### ${task.peerDisplayName ?? task.peer}: ${task.status}`,
				"",
				`- Task: \`${task.id}\``,
				`- State: ${task.state}`,
				`- Updated: ${task.updatedAt}`,
				`- Work graph: ${task.workGraph ? "yes" : "no"}`,
				`- Request: ${task.text}`,
			);
			if (task.responseText) lines.push(`- Response: ${task.responseText}`);
			if (task.workGraphSummary) lines.push(`- ${task.workGraphSummary}`);
			if (task.codexSubagents) lines.push(`- ${task.codexSubagents}`);
			lines.push("");
		}
	}

	lines.push("## Durable Handoffs", "");
	lines.push(
		`- Delivered: ${report.handoffs.deliveredCount}`,
		`- Needs follow-up: ${report.handoffs.followupCount}`,
		`- Blocked: ${report.handoffs.blockedCount}`,
		`- Open work items: ${report.handoffs.openWorkCount}`,
		"",
	);
	for (const handoff of report.handoffs.sessions) {
		lines.push(
			`### ${handoff.title}`,
			"",
			`- Status: ${handoff.status}`,
			`- Delivered: ${handoff.delivered}`,
			`- Next action: ${handoff.nextAction}`,
			`- Evidence: \`${handoff.evidence.sessionPath}\``,
		);
		if (handoff.unfinished) {
			lines.push(`- Unfinished: ${handoff.unfinished}`);
		}
		if (handoff.blockers.length > 0) {
			lines.push(`- Blockers: ${handoff.blockers.join("; ")}`);
		}
		lines.push("");
	}
	if (report.handoffs.openWork.length > 0) {
		lines.push("### Open Work", "");
		for (const item of report.handoffs.openWork) {
			const blockers =
				item.blockers.length > 0
					? `; blocked by ${item.blockers.join(", ")}`
					: "";
			lines.push(
				`- [${item.status}] ${item.content} (${item.goal}; ${item.priority}${blockers})`,
			);
		}
		lines.push("");
	}

	lines.push("## Ambient Automation", "");
	lines.push(
		`- Learner evidence: \`${report.ambient.learnerPath}\``,
		`- Outcomes: ${report.ambient.outcomeCount}`,
		`- Success rate: ${report.ambient.successRate === null ? "n/a" : `${(report.ambient.successRate * 100).toFixed(1)}%`}`,
		`- Patterns: ${report.ambient.patternCount}`,
		`- Protected transient failures: ${report.ambient.protectedTransientFailureCount}`,
		"",
	);
	if (report.ambient.automationOpportunities.length === 0) {
		lines.push(
			"- No ambient automation opportunities found for this range.",
			"",
		);
	} else {
		for (const opportunity of report.ambient.automationOpportunities) {
			lines.push(
				`### ${opportunity.id}`,
				"",
				`- Outcome: ${opportunity.customerOutcome}`,
				`- Trigger: ${opportunity.triggerEvidence}`,
				`- Cadence: ${opportunity.recommendedCadence}`,
				`- Script gate: \`${opportunity.scriptGate}\``,
				`- Delivery: ${opportunity.delivery}`,
				"",
			);
		}
	}

	lines.push("## Playbook Learning", "");
	if (report.ambient.playbookLearningOpportunities.length === 0) {
		lines.push(
			"- No playbook learning opportunities found for this range.",
			"",
		);
	} else {
		for (const opportunity of report.ambient.playbookLearningOpportunities) {
			lines.push(
				`### ${opportunity.id}`,
				"",
				`- Outcome: ${opportunity.customerOutcome}`,
				`- Evidence: ${opportunity.evidenceSignal}`,
				`- Guardrail: ${opportunity.guardrail}`,
				`- Artifact: \`${opportunity.recommendedArtifact}\``,
				"",
			);
		}
	}

	lines.push("## Agent Work Board", "");
	lines.push(
		`- Items: ${report.agentWorkBoard.counts.total}`,
		`- Blocked: ${report.agentWorkBoard.counts.blocked}`,
		`- Waiting: ${report.agentWorkBoard.counts.waiting}`,
		`- Running: ${report.agentWorkBoard.counts.running}`,
		"",
	);
	for (const item of report.agentWorkBoard.items.slice(0, 8)) {
		lines.push(`- **${item.source}/${item.status}** ${item.title}`);
		if (item.owner) {
			lines.push(`  - Owner: ${item.owner}`);
		}
		if (item.nextAction) {
			lines.push(`  - Next: ${item.nextAction.label}`);
			if (item.nextAction.command) {
				lines.push(`  - Command: \`${item.nextAction.command}\``);
			}
		}
	}
	lines.push("");

	lines.push("## Workflows", "");
	for (const workflow of report.workflows) {
		lines.push(
			`### ${workflow.name}`,
			"",
			workflow.customerOutcome,
			"",
			`- Evidence: ${workflow.evidenceSignal}`,
			`- Surface: ${workflow.recommendedSurface}`,
			`- Template: \`${workflow.workflowTemplate.path}\``,
			"",
			"```yaml",
			workflow.workflowTemplate.yaml.trimEnd(),
			"```",
			"",
		);
	}
	lines.push("## Memory Provenance", "");
	if (report.memory.items.length === 0) {
		lines.push("- No memory-backed sessions found.");
	} else {
		for (const item of report.memory.items) {
			lines.push(
				`- ${item.title}: \`${item.memoryExtractionHash}\` from \`${item.sessionPath}\``,
			);
		}
	}
	lines.push("", "## Admin Controls", "");
	for (const control of report.admin.controls) {
		lines.push(
			`- **${control.name}** (${control.status}): ${control.evidence}`,
		);
	}
	if (report.collectionGaps.length > 0) {
		lines.push("", "## Collection Gaps", "");
		for (const gap of report.collectionGaps) {
			lines.push(`- ${gap}`);
		}
	}
	return lines.join("\n").trimEnd();
}

export async function writeCustomerValueArtifacts(
	report: CustomerValueReport,
	options: CustomerValueArtifactWriteOptions = {},
): Promise<CustomerValueArtifactWriteResult> {
	const outputDir =
		options.outputDir ?? join(PATHS.MAESTRO_HOME, "value-reports");
	const baseName = nextCustomerValueArtifactBaseName(
		outputDir,
		customerValueArtifactBaseName(report),
	);
	const reportJsonPath = join(outputDir, `${baseName}.json`);
	const reportMarkdownPath = join(outputDir, `${baseName}.md`);
	const manifestPath = join(outputDir, `${baseName}.manifest.json`);
	const reportJson = `${JSON.stringify(report, null, 2)}\n`;
	const reportMarkdown = `${formatCustomerValueMarkdown(report)}\n`;
	const reportJsonSha256 = sha256(reportJson);
	const reportMarkdownSha256 = sha256(reportMarkdown);
	const manifest: CustomerValueArtifactManifest = {
		protocolVersion: CUSTOMER_VALUE_MANIFEST_VERSION,
		generatedAt: report.generatedAt,
		range: report.range,
		artifacts: {
			reportJsonPath,
			reportMarkdownPath,
		},
		hashes: {
			reportJsonSha256,
			reportMarkdownSha256,
		},
		sources: {
			...report.sources,
			sessionPaths: report.trustCards.map((card) => card.evidence.sessionPath),
		},
		summary: report.summary,
		coverage: {
			trustCardCount: report.trustCards.length,
			memoryProvenanceCount: report.memory.provenanceCount,
			multiAgentTaskCount: report.multiAgent.taskCount,
			multiAgentWorkGraphTaskCount: report.multiAgent.workGraphTaskCount,
			policyApprovalAuditEvents: report.telemetry.policyApprovalAuditEvents,
			collectionGapCount: report.collectionGaps.length,
			handoffCount: report.handoffs.sessions.length,
			openWorkCount: report.handoffs.openWorkCount,
			ambientAutomationOpportunityCount:
				report.ambient.automationOpportunities.length,
			playbookLearningOpportunityCount:
				report.ambient.playbookLearningOpportunities.length,
			agentWorkItemCount: report.agentWorkBoard.counts.total,
		},
		controls: report.admin.controls.map((control) => ({
			id: control.id,
			status: control.status,
		})),
	};
	const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

	writeTextFileAtomic(reportJsonPath, reportJson, { encoding: "utf-8" });
	writeTextFileAtomic(reportMarkdownPath, reportMarkdown, {
		encoding: "utf-8",
	});
	writeTextFileAtomic(manifestPath, manifestJson, { encoding: "utf-8" });

	return {
		outputDir,
		reportJsonPath,
		reportMarkdownPath,
		manifestPath,
		reportJsonSha256,
		reportMarkdownSha256,
		manifestSha256: sha256(manifestJson),
		manifest,
	};
}

function customerValueArtifactBaseName(report: CustomerValueReport): string {
	const timestamp = report.generatedAt
		.replace(/[^0-9A-Za-z]+/g, "-")
		.replace(/^-|-$/g, "");
	const range = report.range.label
		.toLowerCase()
		.replace(/[^0-9a-z]+/g, "-")
		.replace(/^-|-$/g, "");
	return `customer-value-${range || "report"}-${timestamp}`;
}

function nextCustomerValueArtifactBaseName(
	outputDir: string,
	baseName: string,
): string {
	for (let attempt = 0; attempt < 1000; attempt += 1) {
		const candidate = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
		if (
			!existsSync(join(outputDir, `${candidate}.json`)) &&
			!existsSync(join(outputDir, `${candidate}.md`)) &&
			!existsSync(join(outputDir, `${candidate}.manifest.json`))
		) {
			return candidate;
		}
	}
	throw new Error(
		`Could not allocate a unique customer value artifact filename for ${baseName}`,
	);
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function usageFilters(range: CustomerValueRange): UsageFilterOptions {
	return {
		since: range.since,
		// Customer-value ranges treat `until` as exclusive, while usage filters
		// treat it as inclusive.
		until: range.until === undefined ? undefined : Math.max(range.until - 1, 0),
	};
}

function collectTrustCards(params: {
	sessionDir: string;
	range: CustomerValueRange;
	limit?: number;
	usageEntriesBySession: Map<string, UsageEntry[]>;
}): TrustCard[] {
	const cards = findSessionFiles(params.sessionDir)
		.map((sessionPath) =>
			analyzeSession(sessionPath, params.range, params.usageEntriesBySession),
		)
		.filter((analysis): analysis is SessionAnalysis => analysis !== null)
		.sort((left, right) => right.timestamp - left.timestamp)
		.map((analysis) => analysis.card);
	return typeof params.limit === "number"
		? cards.slice(0, params.limit)
		: cards;
}

function analyzeSession(
	sessionPath: string,
	range: CustomerValueRange,
	usageEntriesBySession: Map<string, UsageEntry[]>,
): SessionAnalysis | null {
	let stats: Stats;
	try {
		stats = statSync(sessionPath);
	} catch {
		return null;
	}

	const entries = safeReadSessionEntries(sessionPath);
	const info = buildSessionFileInfo(entries, stats, { messagesView: "full" });
	if (!info || info.id === "unknown") return null;
	const scopedEntries = scopedSessionEntries(entries, range);
	if (scopedEntries.length === 0) return null;
	const toolStats = collectToolStats(scopedEntries);
	const activityRange = sessionActivityRange(scopedEntries);
	const usage = summarizeUsageEntries(
		scopeUsageEntriesToActivity(
			usageEntriesBySession.get(info.id) ?? [],
			range,
			activityRange,
		),
	);
	const scopedMetadata = collectScopedMetadata(scopedEntries);
	const scopedTask = redactLine(firstUserMessageText(scopedEntries) ?? "");
	const bounded = isBoundedRange(range);
	const titleSource =
		(bounded
			? scopedMetadata.title || scopedTask
			: info.title?.trim() || info.subject?.trim() || info.firstMessage) ||
		basename(sessionPath);
	const title = truncate(redactLine(titleSource), 80) || basename(sessionPath);
	const summary = redactLine(
		bounded
			? (scopedMetadata.resumeSummary ?? scopedMetadata.summary ?? "")
			: (info.resumeSummary ?? info.summary ?? ""),
	);
	const task = bounded ? scopedTask : redactLine(info.firstMessage);
	const memoryExtractionHash = bounded
		? scopedMetadata.memoryExtractionHash
		: info.memoryExtractionHash;
	const riskSignals = buildRiskSignals(toolStats, memoryExtractionHash);
	const customerSignals = buildCustomerSignals({
		toolStats,
		summary,
		usage,
		hasMemory: Boolean(memoryExtractionHash),
	});

	return {
		timestamp: latestEntryTimestamp(scopedEntries) ?? stats.mtimeMs,
		card: {
			sessionId: info.id,
			title,
			...(info.cwd ? { cwd: info.cwd } : {}),
			createdAt: info.created.toISOString(),
			updatedAt: stats.mtime.toISOString(),
			messageCount: scopedEntries.filter((entry) => entry.type === "message")
				.length,
			assistantTurnCount: scopedEntries.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant",
			).length,
			toolCallCount: toolStats.toolCallCount,
			failedToolResultCount: toolStats.failedToolResultCount,
			topTools: toolStats.topTools,
			...(summary ? { summary } : {}),
			...(task ? { task } : {}),
			usage,
			evidence: {
				sessionPath,
				hasSummary: Boolean(summary),
				hasMemoryProvenance: Boolean(memoryExtractionHash),
				...(memoryExtractionHash ? { memoryExtractionHash } : {}),
			},
			customerSignals,
			riskSignals,
		},
	};
}

function collectToolStats(entries: SessionEntry[]): {
	toolCallCount: number;
	failedToolResultCount: number;
	topTools: Array<{ name: string; count: number }>;
} {
	const tools = new Map<string, number>();
	let toolCallCount = 0;
	let failedToolResultCount = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type === "toolCall") {
					toolCallCount += 1;
					tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
				}
			}
		}
		if (message.role === "toolResult") {
			tools.set(message.toolName, (tools.get(message.toolName) ?? 0) + 1);
			if (message.isError) failedToolResultCount += 1;
		}
	}
	return {
		toolCallCount,
		failedToolResultCount,
		topTools: [...tools.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((left, right) => right.count - left.count)
			.slice(0, 5),
	};
}

function scopedSessionEntries(
	entries: SessionEntry[],
	range: CustomerValueRange,
): SessionEntry[] {
	if (range.since === undefined && range.until === undefined) return entries;
	return entries.filter((entry) =>
		isTimestampInRange(entryTimestampMs(entry), range),
	);
}

function latestEntryTimestamp(entries: SessionEntry[]): number | undefined {
	let latest: number | undefined;
	for (const entry of entries) {
		const timestamp = entryTimestampMs(entry);
		if (timestamp === undefined) continue;
		latest = latest === undefined ? timestamp : Math.max(latest, timestamp);
	}
	return latest;
}

function sessionActivityRange(entries: SessionEntry[]): {
	since?: number;
	untilExclusive?: number;
} {
	let since: number | undefined;
	let latest: number | undefined;
	for (const entry of entries) {
		const timestamp = entryTimestampMs(entry);
		if (timestamp === undefined) continue;
		since = since === undefined ? timestamp : Math.min(since, timestamp);
		latest = latest === undefined ? timestamp : Math.max(latest, timestamp);
	}
	return {
		...(since === undefined ? {} : { since }),
		// Usage records are often written just after the final assistant entry.
		...(latest === undefined
			? {}
			: { untilExclusive: latest + USAGE_ACTIVITY_GRACE_MS }),
	};
}

function entryTimestampMs(entry: SessionEntry): number | undefined {
	const timestamp = parseTimestampMs(entry.timestamp);
	if (timestamp !== undefined) return timestamp;
	if (entry.type !== "message") return undefined;
	return parseTimestampMs(entry.message.timestamp);
}

function collectScopedMetadata(entries: SessionEntry[]): {
	title?: string;
	summary?: string;
	resumeSummary?: string;
	memoryExtractionHash?: string;
} {
	const metadata: {
		title?: string;
		summary?: string;
		resumeSummary?: string;
		memoryExtractionHash?: string;
	} = {};
	for (const entry of entries) {
		if (entry.type !== "session_meta") continue;
		if (typeof entry.title === "string" && entry.title.trim()) {
			metadata.title = entry.title.trim();
		}
		if (typeof entry.summary === "string" && entry.summary.trim()) {
			metadata.summary = entry.summary;
		}
		if (typeof entry.resumeSummary === "string" && entry.resumeSummary.trim()) {
			metadata.resumeSummary = entry.resumeSummary;
		}
		if (
			typeof entry.memoryExtractionHash === "string" &&
			entry.memoryExtractionHash.trim()
		) {
			metadata.memoryExtractionHash = entry.memoryExtractionHash;
		}
	}
	return metadata;
}

function firstUserMessageText(entries: SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message.content);
		if (text) return text;
	}
	return undefined;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				return block.text;
			}
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function isBoundedRange(range: CustomerValueRange): boolean {
	return range.since !== undefined || range.until !== undefined;
}

interface SessionUsage {
	requests: number;
	tokens: number;
	costUsd: number;
}

function emptySessionUsage(): SessionUsage {
	return { requests: 0, tokens: 0, costUsd: 0 };
}

function groupUsageEntriesBySession(
	entries: UsageEntry[],
): Map<string, UsageEntry[]> {
	const grouped = new Map<string, UsageEntry[]>();
	for (const entry of entries) {
		if (!entry.sessionId) continue;
		const current = grouped.get(entry.sessionId) ?? [];
		current.push(entry);
		grouped.set(entry.sessionId, current);
	}
	return grouped;
}

function scopeUsageEntriesToActivity(
	entries: UsageEntry[],
	range: CustomerValueRange,
	activityRange: { since?: number; untilExclusive?: number },
): UsageEntry[] {
	if (!isBoundedRange(range)) return entries;
	return entries.filter((entry) => {
		if (
			activityRange.since !== undefined &&
			entry.timestamp < activityRange.since
		) {
			return false;
		}
		if (
			activityRange.untilExclusive !== undefined &&
			entry.timestamp >= activityRange.untilExclusive
		) {
			return false;
		}
		return true;
	});
}

function summarizeUsageEntries(entries: UsageEntry[]): SessionUsage {
	const usage = emptySessionUsage();
	for (const entry of entries) {
		usage.requests += 1;
		usage.tokens +=
			entry.tokensInput +
			entry.tokensOutput +
			(entry.tokensCacheRead ?? 0) +
			(entry.tokensCacheWrite ?? 0);
		usage.costUsd += entry.cost;
	}
	return usage;
}

async function flushAmbientLearnerForReport(
	env: RuntimeEnv,
	_learnerPath: string,
	flush: (env: RuntimeEnv) => Promise<AmbientLearnerFlushResult>,
): Promise<AmbientLearnerFlushResult> {
	return flush(env);
}

async function flushAmbientLearnerBeforeRead(
	env: RuntimeEnv,
): Promise<AmbientLearnerFlushResult> {
	return new Promise((resolve) => {
		const child = spawn("ambient", ["flush"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: AmbientLearnerFlushResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};
		const timeout = setTimeout(() => {
			child.kill();
			finish({
				flushed: false,
				collectionGap:
					"Ambient learner flush timed out before report generation.",
			});
		}, 40000);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" &&
				!existsSync(env.ambientSocketFile)
			) {
				finish({ flushed: false });
				return;
			}
			finish({
				flushed: false,
				collectionGap: `Ambient learner flush could not start: ${sanitizeWithStaticMask(error.message)}.`,
			});
		});
		child.on("close", (code) => {
			if (code === 0) {
				finish({
					flushed: true,
					learnerPath: parseAmbientFlushLearnerPath(
						stdout,
						env.ambientLearnerDefaultFile,
					),
				});
				return;
			}
			const failureMessage =
				stderr.trim() || stdout.trim() || `exit ${code ?? "unknown"}`;
			if (isAmbientDaemonNotRunningFlushFailure(failureMessage, env)) {
				finish({ flushed: false });
				return;
			}
			finish({
				flushed: false,
				collectionGap: `Ambient learner flush failed before report generation: ${sanitizeWithStaticMask(failureMessage)}.`,
			});
		});
	});
}

function isAmbientDaemonNotRunningFlushFailure(
	failureMessage: string,
	env: RuntimeEnv,
): boolean {
	const normalized = failureMessage.toLowerCase();
	return (
		normalized.includes("daemon is not running") ||
		normalized.includes("daemon not running") ||
		(normalized.includes("socket not found") &&
			!existsSync(env.ambientSocketFile))
	);
}

function parseAmbientFlushLearnerPath(
	stdout: string,
	fallbackPath: string,
): string {
	const prefix = "Learner state flushed:";
	const lines = stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.reverse();
	for (const line of lines) {
		if (!line.startsWith(prefix)) continue;
		const learnerPath = line.slice(prefix.length).trim();
		if (learnerPath) return learnerPath;
	}
	return fallbackPath;
}

async function summarizeAmbientLearning(
	learnerPath: string,
	range: CustomerValueRange,
	flushResult?: AmbientLearnerFlushResult,
	requestedLearnerPath = learnerPath,
): Promise<AmbientLearningSummary> {
	const summary: AmbientLearningSummary = {
		learnerPath,
		outcomes: [],
		patterns: [],
		collectionGaps: [],
	};
	if (flushResult?.collectionGap) {
		summary.collectionGaps.push(flushResult.collectionGap);
	}
	if (
		flushResult?.learnerPath &&
		requestedLearnerPath !== flushResult.learnerPath
	) {
		summary.collectionGaps.push(
			`Ambient learner override at ${requestedLearnerPath} did not match the running daemon; report used flushed learner state from ${flushResult.learnerPath}.`,
		);
	}
	if (!existsSync(learnerPath)) {
		summary.collectionGaps.push(
			`Ambient learner file not found at ${learnerPath}. Run ambient work before claiming learned automation patterns.`,
		);
		return summary;
	}
	let raw = "";
	try {
		raw = await readFile(learnerPath, "utf8");
	} catch (error) {
		summary.collectionGaps.push(
			`Ambient learner file could not be read: ${sanitizeWithStaticMask(error instanceof Error ? error.message : String(error))}.`,
		);
		return summary;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		summary.collectionGaps.push(
			`Ambient learner file at ${learnerPath} is not valid JSON.`,
		);
		return summary;
	}
	if (!parsed || typeof parsed !== "object") {
		summary.collectionGaps.push(
			`Ambient learner file at ${learnerPath} did not contain an object.`,
		);
		return summary;
	}
	const record = parsed as Record<string, unknown>;
	const outcomes = Array.isArray(record.outcomes) ? record.outcomes : [];
	summary.outcomes = outcomes
		.map(parseAmbientLearnerOutcome)
		.filter((outcome): outcome is AmbientLearnerOutcome => Boolean(outcome))
		.filter((outcome) =>
			isTimestampInRangeOrUnbounded(outcome.timestamp, range),
		);
	summary.patterns = deriveAmbientLearnerPatterns(summary.outcomes);
	if (summary.outcomes.length === 0) {
		summary.collectionGaps.push(
			range.since === undefined && range.until === undefined
				? `Ambient learner file at ${learnerPath} has no outcome evidence.`
				: `Ambient learner file at ${learnerPath} has no outcome evidence for the selected range.`,
		);
	}
	return summary;
}

function parseAmbientLearnerOutcome(
	value: unknown,
): AmbientLearnerOutcome | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const success = record.success;
	if (typeof success !== "boolean") return undefined;
	const labels = Array.isArray(record.labels)
		? record.labels
				.filter((label): label is string => typeof label === "string")
				.map((label) => sanitizeA2ALabel(label, 80))
		: [];
	return {
		success,
		...(typeof record.failure_reason === "string" &&
		record.failure_reason.trim()
			? { failureReason: redactLine(record.failure_reason) }
			: {}),
		labels,
		...(typeof record.repo === "string"
			? { repo: sanitizeA2ALabel(record.repo, 120) }
			: {}),
		...(typeof record.task_type === "string"
			? { taskType: sanitizeA2ALabel(record.task_type, 80) }
			: {}),
		...(typeof record.event_type === "string"
			? { eventType: sanitizeA2ALabel(record.event_type, 80) }
			: {}),
		costUsd: numberOrZero(record.cost_usd),
		...(parseTimestampMs(record.timestamp) !== undefined
			? { timestamp: parseTimestampMs(record.timestamp)! }
			: {}),
	};
}

function deriveAmbientLearnerPatterns(
	outcomes: AmbientLearnerOutcome[],
): AmbientLearnerPattern[] {
	const groups = new Map<
		string,
		{
			patternType: string;
			key: string;
			successCount: number;
			sampleCount: number;
			transientFailureCount: number;
			nonTransientFailureCount: number;
		}
	>();
	const add = (
		patternType: string,
		key: string | undefined,
		outcome: AmbientLearnerOutcome,
	) => {
		if (!key) return;
		const groupKey = `${patternType}\u0000${key}`;
		const group = groups.get(groupKey) ?? {
			patternType,
			key,
			successCount: 0,
			sampleCount: 0,
			transientFailureCount: 0,
			nonTransientFailureCount: 0,
		};
		group.sampleCount += 1;
		if (outcome.success) {
			group.successCount += 1;
		} else if (isTransientAmbientFailureOutcome(outcome)) {
			group.transientFailureCount += 1;
		} else {
			group.nonTransientFailureCount += 1;
		}
		groups.set(groupKey, group);
	};
	for (const outcome of outcomes) {
		for (const label of outcome.labels) add("Label", label, outcome);
		add("Repo", outcome.repo, outcome);
		add("TaskType", outcome.taskType, outcome);
		add("EventType", outcome.eventType, outcome);
	}
	return [...groups.values()]
		.map((group) => ({
			patternType: group.patternType,
			key: group.key,
			successRate: group.successCount / group.sampleCount,
			sampleCount: group.sampleCount,
			successCount: group.successCount,
			transientFailureCount: group.transientFailureCount,
			nonTransientFailureCount: group.nonTransientFailureCount,
			nonTransientSampleCount:
				group.successCount + group.nonTransientFailureCount,
			nonTransientSuccessRate:
				group.successCount + group.nonTransientFailureCount > 0
					? group.successCount /
						(group.successCount + group.nonTransientFailureCount)
					: null,
		}))
		.sort(
			(left, right) =>
				right.sampleCount - left.sampleCount ||
				right.successRate - left.successRate ||
				left.patternType.localeCompare(right.patternType) ||
				left.key.localeCompare(right.key),
		);
}

function buildAmbientCustomerValue(input: {
	learning: AmbientLearningSummary;
	multiAgent: MultiAgentValue;
	trustCards: TrustCard[];
	handoffs: CustomerValueReport["handoffs"];
}): AmbientCustomerValue {
	const successCount = input.learning.outcomes.filter(
		(outcome) => outcome.success,
	).length;
	const failureCount = input.learning.outcomes.length - successCount;
	const protectedTransientFailureCount = input.learning.outcomes.filter(
		isTransientAmbientFailureOutcome,
	).length;
	const actionablePatternCount = input.learning.patterns.filter(
		(pattern) => pattern.nonTransientSampleCount >= 3,
	).length;
	const base: Omit<
		AmbientCustomerValue,
		"automationOpportunities" | "playbookLearningOpportunities"
	> = {
		learnerPath: input.learning.learnerPath,
		outcomeCount: input.learning.outcomes.length,
		successCount,
		failureCount,
		successRate:
			input.learning.outcomes.length > 0
				? successCount / input.learning.outcomes.length
				: null,
		totalCostUsd: sum(input.learning.outcomes, (outcome) => outcome.costUsd),
		patternCount: input.learning.patterns.length,
		actionablePatternCount,
		protectedTransientFailureCount,
		collectionGaps: input.learning.collectionGaps,
	};
	const automationOpportunities = buildAmbientAutomationOpportunities({
		ambient: base,
		multiAgent: input.multiAgent,
		trustCards: input.trustCards,
		handoffs: input.handoffs,
	});
	const playbookLearningOpportunities = buildPlaybookLearningOpportunities({
		ambient: base,
		learning: input.learning,
		multiAgent: input.multiAgent,
		trustCards: input.trustCards,
		handoffs: input.handoffs,
	});
	return {
		...base,
		automationOpportunities,
		playbookLearningOpportunities,
	};
}

function buildAmbientAutomationOpportunities(input: {
	ambient: Omit<
		AmbientCustomerValue,
		"automationOpportunities" | "playbookLearningOpportunities"
	>;
	multiAgent: MultiAgentValue;
	trustCards: TrustCard[];
	handoffs: CustomerValueReport["handoffs"];
}): AmbientAutomationOpportunity[] {
	const opportunities: AmbientAutomationOpportunity[] = [];
	if (
		input.multiAgent.delegatedPendingTaskCount > 0 ||
		input.multiAgent.nextActions.length > 0
	) {
		opportunities.push({
			id: "a2a-followup-watchdog",
			customerOutcome:
				"Wake operators only when delegated work needs a reply, wait, refresh, or evidence check.",
			triggerEvidence: `${input.multiAgent.delegatedPendingTaskCount} pending delegated task(s) and ${input.multiAgent.nextActions.length} cockpit next action(s).`,
			recommendedCadence: "hourly",
			scriptGate:
				"maestro a2a cockpit --json | jq -e '.nextActions | length > 0'",
			delivery:
				"Slack or CLI notification with the first cockpit next action and value-report link.",
		});
	}
	const failedToolResults = sum(
		input.trustCards,
		(card) => card.failedToolResultCount,
	);
	if (failedToolResults > 0 || input.handoffs.blockedCount > 0) {
		opportunities.push({
			id: "failed-tool-digest",
			customerOutcome:
				"Convert failed tool evidence into a daily repair queue instead of losing it in chat history.",
			triggerEvidence: `${failedToolResults} failed tool result(s) and ${input.handoffs.blockedCount} blocked handoff(s).`,
			recommendedCadence: "daily",
			scriptGate:
				"maestro value yesterday --format json | jq -e '.handoffs.blockedCount > 0 or .summary.failedToolResultCount > 0'",
			delivery:
				"Daily digest with blocked handoffs, failed tool counts, and replayable session paths.",
		});
	}
	const memoryGapCount = input.trustCards.filter(
		(card) => !card.evidence.hasMemoryProvenance,
	).length;
	if (memoryGapCount > 0) {
		opportunities.push({
			id: "memory-gap-digest",
			customerOutcome:
				"Turn valuable one-off sessions into reusable customer context before the lessons go stale.",
			triggerEvidence: `${memoryGapCount} trust card(s) lack durable memory provenance.`,
			recommendedCadence: "weekly",
			scriptGate:
				"maestro value week --format json | jq -e 'any(.trustCards[]?; .evidence.hasMemoryProvenance | not)'",
			delivery:
				"Weekly report of sessions that need memory or playbook capture.",
		});
	}
	if (input.ambient.outcomeCount > 0) {
		opportunities.push({
			id: "ambient-learner-review",
			customerOutcome:
				"Review ambient outcomes on a schedule and promote only durable patterns into team playbooks.",
			triggerEvidence: `${input.ambient.outcomeCount} learner outcome(s), ${input.ambient.actionablePatternCount} actionable pattern(s), ${input.ambient.protectedTransientFailureCount} protected transient failure(s).`,
			recommendedCadence: "weekly",
			scriptGate: ambientLearnerPresenceCommand(input.ambient.learnerPath),
			delivery:
				"Weekly playbook review with successes, low-success patterns, and quarantined transient failures.",
		});
	}
	return opportunities.slice(0, 5);
}

function buildPlaybookLearningOpportunities(input: {
	ambient: Omit<
		AmbientCustomerValue,
		"automationOpportunities" | "playbookLearningOpportunities"
	>;
	learning: AmbientLearningSummary;
	multiAgent: MultiAgentValue;
	trustCards: TrustCard[];
	handoffs: CustomerValueReport["handoffs"];
}): PlaybookLearningOpportunity[] {
	const opportunities: PlaybookLearningOpportunity[] = [];
	if (input.ambient.protectedTransientFailureCount > 0) {
		opportunities.push({
			id: "protect-transient-failures",
			customerOutcome:
				"Prevent temporary setup failures from becoming permanent agent refusals or bad playbooks.",
			evidenceSignal: `${input.ambient.protectedTransientFailureCount} learner failure(s) matched transient setup or environment patterns.`,
			guardrail:
				"Capture the recovery command or setup prerequisite, not a durable claim that the tool is broken.",
			recommendedArtifact:
				".maestro/playbooks/ambient-transient-failure-guardrail.md",
		});
	}
	const topSuccess = input.learning.patterns
		.filter(
			(pattern) =>
				pattern.nonTransientSampleCount >= 3 &&
				pattern.nonTransientSuccessRate !== null &&
				pattern.nonTransientSuccessRate >= 0.75,
		)
		.sort(
			(left, right) =>
				(right.nonTransientSuccessRate ?? 0) -
				(left.nonTransientSuccessRate ?? 0),
		)[0];
	if (topSuccess) {
		opportunities.push({
			id: "capture-successful-pattern",
			customerOutcome:
				"Turn repeated ambient success into a reusable team playbook for similar work.",
			evidenceSignal: `${topSuccess.patternType}=${topSuccess.key} succeeded ${((topSuccess.nonTransientSuccessRate ?? 0) * 100).toFixed(1)}% across ${topSuccess.nonTransientSampleCount} non-transient sample(s).`,
			guardrail:
				"Promote the durable task shape, required evidence, and verification steps; do not copy one-off task details.",
			recommendedArtifact: `.maestro/playbooks/ambient-${slugify(topSuccess.patternType)}-${slugify(topSuccess.key)}.md`,
		});
	}
	const lowSuccess = input.learning.patterns
		.filter(
			(pattern) =>
				pattern.nonTransientSampleCount >= 3 &&
				pattern.nonTransientSuccessRate !== null &&
				pattern.nonTransientSuccessRate < 0.45 &&
				pattern.nonTransientFailureCount > 0,
		)
		.sort(
			(left, right) =>
				(left.nonTransientSuccessRate ?? 1) -
				(right.nonTransientSuccessRate ?? 1),
		)[0];
	if (lowSuccess) {
		opportunities.push({
			id: "repair-low-success-pattern",
			customerOutcome:
				"Reduce repeated ambient failures by tightening routing, approval, or verification for a known weak pattern.",
			evidenceSignal: `${lowSuccess.patternType}=${lowSuccess.key} succeeded only ${((lowSuccess.nonTransientSuccessRate ?? 0) * 100).toFixed(1)}% across ${lowSuccess.nonTransientSampleCount} non-transient sample(s).`,
			guardrail:
				"Prefer threshold/routing changes or added checks over broad bans on the task class.",
			recommendedArtifact: `.maestro/playbooks/ambient-${slugify(lowSuccess.patternType)}-${slugify(lowSuccess.key)}-repair.md`,
		});
	}
	if (
		input.multiAgent.delegatedEvidenceGapCount > 0 ||
		input.multiAgent.nextActions.length > 0
	) {
		opportunities.push({
			id: "multi-agent-verification-playbook",
			customerOutcome:
				"Make subagent work customer-trustworthy by requiring parent-side verification before value is claimed.",
			evidenceSignal: `${input.multiAgent.delegatedEvidenceGapCount} delegated evidence gap(s) and ${input.multiAgent.nextActions.length} A2A next action(s).`,
			guardrail:
				"Treat subagent summaries as self-reports until a URL, file path, task id, work graph, transcript, or test result is read back.",
			recommendedArtifact: ".maestro/playbooks/multi-agent-verification.md",
		});
	}
	if (
		input.handoffs.followupCount > 0 ||
		input.handoffs.openWorkCount > 0 ||
		input.trustCards.some((card) => card.riskSignals.length > 0)
	) {
		opportunities.push({
			id: "handoff-memory-playbook",
			customerOutcome:
				"Convert unfinished work, blockers, and user corrections into durable next-session behavior.",
			evidenceSignal: `${input.handoffs.followupCount} follow-up handoff(s), ${input.handoffs.openWorkCount} open work item(s).`,
			guardrail:
				"Store user/workflow preferences as playbook steps, while keeping secrets and transient errors out of durable memory.",
			recommendedArtifact: ".maestro/playbooks/customer-handoff-learning.md",
		});
	}
	return opportunities.slice(0, 6);
}

function isTimestampInRangeOrUnbounded(
	timestamp: number | undefined,
	range: CustomerValueRange,
): boolean {
	if (range.since === undefined && range.until === undefined) return true;
	if (timestamp === undefined) return false;
	return isTimestampInRange(timestamp, range);
}

function isTransientAmbientFailureOutcome(
	outcome: AmbientLearnerOutcome,
): boolean {
	if (outcome.success || !outcome.failureReason) return false;
	return isTransientFailureText(outcome.failureReason);
}

function isTransientFailureText(text: string): boolean {
	const normalized = text.toLowerCase();
	return (
		[
			"command not found",
			"no such file or directory",
			"missing binary",
			"missing credential",
			"unconfigured",
			"not configured",
			"authentication required",
			"connection refused",
			"temporary failure in name resolution",
		].some((needle) => normalized.includes(needle)) ||
		isTransientRateLimitFailureText(normalized) ||
		isTransientTransportFailureText(normalized)
	);
}

function isTransientRateLimitFailureText(normalized: string): boolean {
	return (
		["429 too many requests", "http 429", "status 429"].some((needle) =>
			normalized.includes(needle),
		) ||
		(normalized.includes("rate limit") &&
			hasTransientEnvironmentContext(normalized))
	);
}

function isTransientTransportFailureText(normalized: string): boolean {
	return (
		[
			"etimedout",
			"econnreset",
			"enotfound",
			"eai_again",
			"connection timed out",
			"socket timed out",
			"network unreachable",
			"network unavailable",
			"network reset",
			"temporary network",
		].some((needle) => normalized.includes(needle)) ||
		([
			"request timed out",
			"connect timed out",
			"fetch timed out",
			"timed out",
			"network error",
			"network failure",
			"dns lookup",
			"name resolution",
		].some((needle) => normalized.includes(needle)) &&
			hasTransientEnvironmentContext(normalized))
	);
}

function hasTransientEnvironmentContext(normalized: string): boolean {
	return [
		"while bootstrapping",
		"while fetching",
		"while downloading",
		"while installing",
		"while authenticating",
		"while connecting",
		"while calling",
		"fetching dependencies",
		"downloading dependencies",
		"installing dependencies",
		"dependency install",
		"fresh runner",
		"github api",
		"npm registry",
		"package registry",
	].some((needle) => normalized.includes(needle));
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function numberOrZero(value: unknown): number {
	return numberField(value) ?? 0;
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
}

async function summarizeMultiAgentValue(
	tasksPath: string,
	range: CustomerValueRange,
): Promise<MultiAgentValue> {
	let tasks: A2ATaskLedgerEntry[] = [];
	const collectionGaps: string[] = [];
	try {
		const ledger = await loadA2ATaskLedger({ path: tasksPath });
		tasks = ledger.tasks.filter((task) => isA2ATaskInRange(task, range));
	} catch (error) {
		collectionGaps.push(
			`A2A task ledger could not be read: ${sanitizeWithStaticMask(error instanceof Error ? error.message : String(error))}.`,
		);
	}

	const peerSummaries = summarizeMultiAgentPeers(tasks);
	const rollup = summarizeA2ATaskLedger(tasks);
	const delegatedTasks = tasks.filter((task) => task.kind === "delegation");
	const delegatedRollup = summarizeA2ATaskLedger(delegatedTasks);
	const workGraphs = tasks
		.map((task) => task.workGraph)
		.filter((graph): graph is NonNullable<typeof graph> => Boolean(graph));
	const completedDelegations = delegatedTasks.filter(
		isAuditReadyA2ADelegationTask,
	);
	const realizedHoursSaved = Number(
		(
			completedDelegations.length * 0.25 +
			completedDelegations.filter((task) => Boolean(task.workGraph)).length *
				0.1
		).toFixed(2),
	);
	if (tasks.length === 0 && collectionGaps.length === 0) {
		collectionGaps.push(
			range.since === undefined && range.until === undefined
				? `No A2A delegated task evidence found in ${tasksPath}.`
				: `No A2A delegated task evidence found in ${tasksPath} for the selected range.`,
		);
	}

	return {
		tasksPath,
		taskCount: rollup.taskCount,
		delegatedTaskCount: rollup.delegatedTaskCount,
		peerCount: new Set(tasks.map((task) => task.peer)).size,
		completedTaskCount: rollup.completedTaskCount,
		failedTaskCount: rollup.failedTaskCount,
		actionRequiredTaskCount: rollup.actionRequiredTaskCount,
		workGraphTaskCount: rollup.workGraphTaskCount,
		workGraphChildRunCount: sum(workGraphs, (graph) =>
			workGraphChildRunCount(graph),
		),
		workGraphBlockedItemCount: sum(
			workGraphs,
			(graph) => graph.blockedItemCount ?? 0,
		),
		workGraphWaitingItemCount: sum(
			workGraphs,
			(graph) => graph.waitingItemCount ?? 0,
		),
		workGraphPendingToolCallCount: sum(
			workGraphs,
			(graph) => graph.pendingToolCallCount ?? 0,
		),
		codexSubagentEdgeCount: sum(
			workGraphs,
			(graph) =>
				graph.codexSubagents?.edgeCount ??
				graph.codexSubagents?.edges?.length ??
				0,
		),
		transcriptMessageCount: rollup.transcriptMessageCount,
		realizedHoursSaved,
		realizedValueUsd: realizedHoursSaved * 150,
		pendingTaskCount: rollup.actionRequiredTaskCount + rollup.runningTaskCount,
		auditReadyTaskCount: rollup.auditReadyTaskCount,
		evidenceGapCount: rollup.evidenceGapCount,
		delegatedFailedTaskCount: delegatedRollup.failedTaskCount,
		delegatedPendingTaskCount:
			delegatedRollup.actionRequiredTaskCount +
			delegatedRollup.runningTaskCount,
		delegatedEvidenceGapCount: delegatedRollup.evidenceGapCount,
		nextActions: summarizeMultiAgentNextActions(delegatedTasks, tasksPath),
		topPeers: peerSummaries,
		recentTasks: tasks
			.slice()
			.sort((left, right) => taskSortTimestamp(right) - taskSortTimestamp(left))
			.slice(0, 5)
			.map((task) => ({
				id: sanitizeA2ALabel(task.taskId, 120),
				peer: sanitizeA2ALabel(task.peer, 80),
				...(task.peerDisplayName
					? { peerDisplayName: sanitizeA2ALabel(task.peerDisplayName, 100) }
					: {}),
				state: sanitizeA2ALabel(task.state, 80),
				status: a2aTaskStatus(task),
				text: truncate(redactLine(task.text), 140),
				updatedAt: task.updatedAt,
				...(task.completedAt ? { completedAt: task.completedAt } : {}),
				workGraph: Boolean(task.workGraph),
				...(taskWorkGraphSummary(task)
					? { workGraphSummary: taskWorkGraphSummary(task)! }
					: {}),
				...(taskCodexSubagentsSummary(task)
					? {
							codexSubagents: taskCodexSubagentsSummary(task)!,
						}
					: {}),
				...(task.responseText
					? { responseText: truncate(redactLine(task.responseText), 180) }
					: {}),
			})),
		collectionGaps,
	};
}

function workGraphChildRunCount(
	graph: NonNullable<A2ATaskLedgerEntry["workGraph"]>,
): number {
	return Math.max(
		graph.childRunCount ?? 0,
		graph.childRunIds.length,
		graph.codexSubagents?.childRunIds.length ?? 0,
	);
}

function taskWorkGraphSummary(task: A2ATaskLedgerEntry): string | undefined {
	const summary = formatA2AWorkGraphSummary(task.workGraph);
	return summary ? sanitizeA2ALabel(summary, 320) : undefined;
}

function taskCodexSubagentsSummary(
	task: A2ATaskLedgerEntry,
): string | undefined {
	const summary = formatA2AWorkGraphCodexSubagents(task.workGraph);
	return summary ? sanitizeA2ALabel(summary, 420) : undefined;
}

function summarizeMultiAgentPeers(
	tasks: A2ATaskLedgerEntry[],
): MultiAgentValue["topPeers"] {
	const peers = new Map<string, MultiAgentValue["topPeers"][number]>();
	for (const task of tasks) {
		const peer = sanitizeA2ALabel(task.peer, 80);
		const displayName = task.peerDisplayName
			? sanitizeA2ALabel(task.peerDisplayName, 100)
			: undefined;
		const current = peers.get(task.peer) ?? {
			peer,
			...(displayName ? { displayName } : {}),
			taskCount: 0,
			completedTaskCount: 0,
			failedTaskCount: 0,
			actionRequiredTaskCount: 0,
		};
		if (displayName && !current.displayName) {
			current.displayName = displayName;
		}
		current.taskCount += 1;
		const status = a2aTaskStatus(task);
		if (status === "completed") current.completedTaskCount += 1;
		if (status === "failed") current.failedTaskCount += 1;
		if (status === "waiting") current.actionRequiredTaskCount += 1;
		peers.set(task.peer, current);
	}
	return [...peers.values()]
		.sort(
			(left, right) =>
				right.taskCount - left.taskCount || left.peer.localeCompare(right.peer),
		)
		.slice(0, 5);
}

function summarizeMultiAgentNextActions(
	tasks: A2ATaskLedgerEntry[],
	tasksPath: string,
): MultiAgentValue["nextActions"] {
	if (tasks.length === 0) {
		return [];
	}
	const cockpit = summarizeA2ACockpit({
		fleet: syntheticA2AFleetSummary(tasks, tasksPath),
		ledger: { tasks },
		limit: 5,
		generatedAt: new Date(0).toISOString(),
	});
	return cockpit.nextActions
		.filter((action): action is A2ACockpitNextAction & { taskId: string } =>
			Boolean(action.taskId),
		)
		.map((action) => ({
			id: sanitizeA2ALabel(action.id, 160),
			label: sanitizeA2ALabel(action.label, 180),
			command: sanitizeA2ALabel(
				exportableMultiAgentCommand(action.command),
				240,
			),
			severity: action.severity,
			peer: sanitizeA2ALabel(action.peer, 80),
			taskId: sanitizeA2ALabel(action.taskId, 120),
			reason: sanitizeA2ALabel(action.reason, 240),
		}));
}

function exportableMultiAgentCommand(command: string): string {
	return command.replace(/<response>/gu, "'RESPONSE_TEXT'");
}

async function buildCustomerValueWorkBoard(input: {
	tasksPath: string;
	range: CustomerValueRange;
	workspaceDir: string;
	missions?: readonly MissionManifest[];
	todos?: TodoStore;
	handoffs: CustomerValueHandoff[];
	openWork: CustomerValueOpenWorkItem[];
	githubTasks?: readonly GitHubAgentWorkProjection[];
	missionStoreDir?: string | null;
	now: number;
}): Promise<AgentWorkBoard> {
	let tasks: A2ATaskLedgerEntry[] = [];
	try {
		const ledger = await loadA2ATaskLedger({ path: input.tasksPath });
		tasks = ledger.tasks.filter(
			(task) =>
				task.kind === "delegation" && isA2ATaskInRange(task, input.range),
		);
	} catch {
		tasks = [];
	}
	const a2a =
		tasks.length > 0
			? summarizeA2ACockpit({
					fleet: syntheticA2AFleetSummary(tasks, input.tasksPath),
					ledger: { tasks },
					limit: 25,
					generatedAt: new Date(input.now).toISOString(),
				})
			: undefined;
	const todos = sanitizeTodoStoreForWorkBoard(input.todos);
	const [missions, githubTasks] = await Promise.all([
		input.missions
			? Promise.resolve(input.missions)
			: collectMissionManifests(input.workspaceDir),
		input.githubTasks
			? Promise.resolve(input.githubTasks)
			: collectGitHubAgentWork(input.workspaceDir),
	]);
	return redactAgentWorkBoard(
		buildAgentWorkBoard(
			{
				missions,
				missionSnapshots: missionStoreSnapshotsForWorkspace(
					listMissionStoreSnapshots(input.missionStoreDir ?? undefined),
					missions,
					input.workspaceDir,
					input.missionStoreDir ?? undefined,
				),
				a2a,
				todos,
				handoffs: input.handoffs,
				openWork: hasOpenTodoItems(todos) ? [] : input.openWork,
				githubTasks,
			},
			new Date(input.now),
		),
	);
}

function missionStoreSnapshotsForWorkspace(
	snapshots: readonly MissionStoreSnapshot[],
	missions: readonly MissionManifest[],
	workspaceDir: string,
	missionStoreDir?: string,
): MissionStoreSnapshot[] {
	const workspaceMissionIds = new Set<string>();
	for (const mission of missions) {
		workspaceMissionIds.add(mission.missionId);
		try {
			workspaceMissionIds.add(sanitizeMissionId(mission.missionId));
		} catch {
			// Ignore malformed mission ids from workspace manifests.
		}
	}
	if (workspaceMissionIds.size > 0) {
		return snapshots.filter((snapshot) => {
			const isWorkspaceOwned = isMissionStoreSnapshotOwnedByWorkspace(
				snapshot,
				workspaceDir,
				missionStoreDir,
			);
			return (
				(isWorkspaceOwned || !missionStoreDir) &&
				(workspaceMissionIds.has(snapshot.missionId) ||
					(snapshot.sourceMissionId
						? workspaceMissionIds.has(snapshot.sourceMissionId)
						: false))
			);
		});
	}
	const workspaceOwnedSnapshots = snapshots.filter((snapshot) =>
		isMissionStoreSnapshotOwnedByWorkspace(
			snapshot,
			workspaceDir,
			missionStoreDir,
		),
	);
	if (workspaceOwnedSnapshots.length > 0) return workspaceOwnedSnapshots;
	return missionStoreDir ? [] : [...snapshots];
}

function isMissionStoreSnapshotOwnedByWorkspace(
	snapshot: MissionStoreSnapshot,
	workspaceDir: string,
	missionStoreDir?: string,
): boolean {
	const workspaceRoot = realPathIfExists(workspaceDir);
	const missionDir = realPathIfExists(
		getMissionDir(snapshot.missionId, missionStoreDir),
	);
	const rel = relative(workspaceRoot, missionDir);
	return Boolean(rel) && !isParentDirectoryRelPath(rel) && !isAbsolute(rel);
}

function realPathIfExists(path: string): string {
	const absolute = resolve(path);
	return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isParentDirectoryRelPath(relPath: string): boolean {
	return relPath === ".." || relPath.startsWith(`..${sep}`);
}

function sanitizeTodoStoreForWorkBoard(
	store: TodoStore | undefined,
): TodoStore | undefined {
	const sanitized: TodoStore = {};
	for (const [key, goal] of Object.entries(store ?? {})) {
		if (
			!goal ||
			typeof goal !== "object" ||
			typeof goal.goal !== "string" ||
			typeof goal.updatedAt !== "string" ||
			!Array.isArray(goal.items)
		) {
			continue;
		}
		const items = goal.items
			.filter(
				(item) =>
					item &&
					typeof item === "object" &&
					typeof item.id === "string" &&
					typeof item.content === "string" &&
					typeof item.status === "string" &&
					isTodoStoreStatus(item.status) &&
					typeof item.priority === "string" &&
					isOpenTodoPriority(item.priority),
			)
			.map((item) => ({
				id: item.id,
				content: compactHandoffText(item.content),
				status: item.status,
				priority: item.priority,
				...(Array.isArray(item.blockedBy)
					? {
							blockedBy: item.blockedBy
								.filter(
									(blockedBy): blockedBy is string =>
										typeof blockedBy === "string",
								)
								.map(compactHandoffText),
						}
					: {}),
			}));
		if (items.length > 0) {
			sanitized[key] = {
				goal: compactHandoffText(goal.goal),
				updatedAt: goal.updatedAt,
				items,
			};
		}
	}
	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function hasOpenTodoItems(todos: TodoStore | undefined): boolean {
	return Object.values(todos ?? {}).some((goal) =>
		Array.isArray(goal?.items)
			? goal.items.some((item) => item.status !== "completed")
			: false,
	);
}

function redactAgentWorkBoard(board: AgentWorkBoard): AgentWorkBoard {
	return {
		...board,
		items: board.items.map((item) => ({
			...item,
			id: redactLine(item.id),
			title: redactLine(item.title),
			...(item.owner ? { owner: redactLine(item.owner) } : {}),
			blockers: item.blockers.map(redactLine),
			nextAction: item.nextAction
				? {
						label: redactLine(item.nextAction.label),
						...(item.nextAction.command
							? { command: redactLine(item.nextAction.command) }
							: {}),
					}
				: undefined,
			evidence: item.evidence.map((evidence) => ({
				...evidence,
				label: redactLine(evidence.label),
				...(evidence.path ? { path: redactLine(evidence.path) } : {}),
				...(evidence.url ? { url: redactLine(evidence.url) } : {}),
			})),
		})),
	};
}

function syntheticA2AFleetSummary(
	tasks: A2ATaskLedgerEntry[],
	tasksPath: string,
): A2AFleetSummary {
	const peers = [...new Map(tasks.map((task) => [task.peer, task])).values()]
		.sort((left, right) => left.peer.localeCompare(right.peer))
		.map((task) => ({
			name: task.peer,
			...(task.peerDisplayName ? { displayName: task.peerDisplayName } : {}),
			url: `ledger://${task.peer}`,
			status: "online" as const,
		}));
	return {
		generatedAt: new Date(0).toISOString(),
		registryPath: "local A2A task ledger",
		tasksPath,
		peers,
	};
}

function isA2ATaskInRange(
	task: A2ATaskLedgerEntry,
	range: CustomerValueRange,
): boolean {
	if (["failed", "waiting", "running"].includes(a2aTaskStatus(task))) {
		return true;
	}
	if (range.since === undefined && range.until === undefined) return true;
	const activeRange = getA2ATaskActiveRange(task);
	if (!activeRange) {
		return false;
	}
	if (range.until !== undefined && activeRange.start >= range.until) {
		return false;
	}
	if (range.since !== undefined && activeRange.end < range.since) {
		return false;
	}
	return true;
}

function getA2ATaskActiveRange(
	task: A2ATaskLedgerEntry,
): { start: number; end: number } | undefined {
	const timestamps = [
		parseTimestampMs(task.createdAt),
		parseTimestampMs(task.updatedAt),
		parseTimestampMs(task.completedAt),
	].filter((timestamp): timestamp is number => timestamp !== undefined);
	if (timestamps.length === 0) {
		return undefined;
	}
	const start = Math.min(...timestamps);
	if (!isFinalA2AState(task.state)) {
		return { start, end: Number.POSITIVE_INFINITY };
	}
	return { start, end: Math.max(...timestamps) };
}

function taskSortTimestamp(task: A2ATaskLedgerEntry): number {
	return (
		parseTimestampMs(task.completedAt) ??
		parseTimestampMs(task.updatedAt) ??
		parseTimestampMs(task.createdAt) ??
		0
	);
}

function a2aTaskStatus(
	task: Pick<A2ATaskLedgerEntry, "state">,
): MultiAgentValue["recentTasks"][number]["status"] {
	return classifyTaskState(task.state);
}

function sanitizeA2ALabel(text: string, maxLength: number): string {
	return truncate(redactLine(text), maxLength);
}

function multiAgentDecisionLine(multiAgent: MultiAgentValue): string {
	const nextAction = multiAgent.nextActions[0];
	if (nextAction) {
		return `${nextAction.label} (${nextAction.command})`;
	}
	if (multiAgent.delegatedFailedTaskCount > 0) {
		return "Refresh or inspect failed delegated work before claiming value.";
	}
	if (multiAgent.delegatedPendingTaskCount > 0) {
		return "Wait for running delegated work before counting realized value.";
	}
	if (multiAgent.delegatedEvidenceGapCount > 0) {
		return multiAgent.auditReadyTaskCount > 0
			? "Some delegated work is audit-ready, but evidence gaps remain to close."
			: "Completed delegated work is missing audit evidence; collect work graphs, responses, or transcripts before claiming value.";
	}
	if (multiAgent.realizedHoursSaved <= 0) {
		return "No completed delegated work found; delegate and complete A2A work before claiming realized multi-agent value.";
	}
	return "No action required; completed delegated work is ready for audit.";
}

function summarizeCustomerValue(params: {
	ambient: AmbientCustomerValue;
	multiAgent: MultiAgentValue;
	trustCards: TrustCard[];
}): CustomerValueReport["summary"] {
	const messageCount = sum(params.trustCards, (card) => card.messageCount);
	const assistantTurnCount = sum(
		params.trustCards,
		(card) => card.assistantTurnCount,
	);
	const toolCallCount = sum(params.trustCards, (card) => card.toolCallCount);
	const failedToolResultCount = sum(
		params.trustCards,
		(card) => card.failedToolResultCount,
	);
	const estimatedHoursSaved = estimateHoursSaved({
		assistantTurnCount,
		toolCallCount,
	});
	const usageRequests = sum(params.trustCards, (card) => card.usage.requests);
	const totalTokens = sum(params.trustCards, (card) => card.usage.tokens);
	const totalCostUsd = sum(params.trustCards, (card) => card.usage.costUsd);
	const multiAgentEstimatedHoursSaved = params.multiAgent.realizedHoursSaved;
	const totalEstimatedHoursSaved =
		estimatedHoursSaved + multiAgentEstimatedHoursSaved;
	const totalEstimatedValueUsd = totalEstimatedHoursSaved * 150;
	return {
		sessionCount: params.trustCards.length,
		trustCardCount: params.trustCards.length,
		messageCount,
		assistantTurnCount,
		toolCallCount,
		failedToolResultCount,
		usageRequests,
		totalTokens,
		totalCostUsd,
		estimatedHoursSaved: totalEstimatedHoursSaved,
		estimatedValueUsd: totalEstimatedValueUsd,
		valueMultiple:
			totalCostUsd > 0 ? totalEstimatedValueUsd / totalCostUsd : null,
		memoryBackedSessionCount: params.trustCards.filter(
			(card) => card.evidence.hasMemoryProvenance,
		).length,
		multiAgentEstimatedHoursSaved,
		multiAgentEstimatedValueUsd: multiAgentEstimatedHoursSaved * 150,
		multiAgentTaskCount: params.multiAgent.taskCount,
		multiAgentPeerCount: params.multiAgent.peerCount,
		multiAgentWorkGraphTaskCount: params.multiAgent.workGraphTaskCount,
		multiAgentChildRunCount: params.multiAgent.workGraphChildRunCount,
		ambientAutomationOpportunityCount:
			params.ambient.automationOpportunities.length,
		playbookLearningOpportunityCount:
			params.ambient.playbookLearningOpportunities.length,
		ambientLearnerOutcomeCount: params.ambient.outcomeCount,
		ambientProtectedTransientFailureCount:
			params.ambient.protectedTransientFailureCount,
	};
}

function buildCustomerValueHandoffs(
	trustCards: TrustCard[],
	todoStore: TodoStore,
): CustomerValueReport["handoffs"] {
	const sessions = trustCards.map(buildSessionHandoff);
	const openWork = collectOpenTodoWork(todoStore);
	return {
		deliveredCount: sessions.filter((handoff) => handoff.status === "delivered")
			.length,
		followupCount: sessions.filter(
			(handoff) => handoff.status === "needs-followup",
		).length,
		blockedCount: sessions.filter((handoff) => handoff.status === "blocked")
			.length,
		openWorkCount: openWork.length,
		sessions,
		openWork,
	};
}

async function loadCustomerValueTodoStore(): Promise<TodoStore> {
	try {
		return sanitizeCustomerValueTodoStore(await loadStore());
	} catch {
		return {};
	}
}

function buildSessionHandoff(card: TrustCard): CustomerValueHandoff {
	const blockers = card.riskSignals.filter(
		(signal) =>
			signal.includes("failed") ||
			signal.includes("no durable memory") ||
			signal.includes("no tool evidence"),
	);
	const status =
		card.failedToolResultCount > 0
			? "blocked"
			: card.riskSignals.length > 0
				? "needs-followup"
				: "delivered";
	const unfinished =
		card.riskSignals.length > 0
			? card.riskSignals.join("; ")
			: card.evidence.hasMemoryProvenance
				? undefined
				: "No durable memory provenance was captured for this session.";
	return {
		sessionId: card.sessionId,
		title: card.title,
		status,
		delivered: compactHandoffText(
			card.summary ||
				card.task ||
				card.customerSignals.join("; ") ||
				card.title,
		),
		...(unfinished ? { unfinished: compactHandoffText(unfinished) } : {}),
		blockers,
		nextAction: nextHandoffAction(card, status),
		evidence: {
			sessionPath: card.evidence.sessionPath,
			updatedAt: card.updatedAt,
			summaryStored: card.evidence.hasSummary,
			memoryBacked: card.evidence.hasMemoryProvenance,
		},
	};
}

function collectOpenTodoWork(store: TodoStore): CustomerValueOpenWorkItem[] {
	const items: CustomerValueOpenWorkItem[] = [];
	for (const goal of Object.values(store)) {
		for (const item of goal.items) {
			if (!isOpenTodoStatus(item.status)) {
				continue;
			}
			items.push({
				goal: compactHandoffText(goal.goal),
				id: item.id,
				content: compactHandoffText(item.content),
				status: item.status,
				priority: item.priority,
				updatedAt: goal.updatedAt,
				blockers: item.blockedBy?.map(compactHandoffText) ?? [],
			});
		}
	}
	return items.sort(compareOpenWorkItems);
}

function sanitizeCustomerValueTodoStore(store: TodoStore): TodoStore {
	const sanitized: TodoStore = {};
	for (const [goalKey, goal] of Object.entries(store)) {
		if (
			!goal ||
			typeof goal !== "object" ||
			typeof goal.goal !== "string" ||
			typeof goal.updatedAt !== "string" ||
			!Array.isArray(goal.items)
		) {
			continue;
		}
		sanitized[goalKey] = {
			goal: goal.goal,
			updatedAt: goal.updatedAt,
			items: goal.items.flatMap((item) => {
				if (
					!item ||
					typeof item !== "object" ||
					typeof item.id !== "string" ||
					typeof item.content !== "string" ||
					typeof item.status !== "string" ||
					!isTodoStoreStatus(item.status) ||
					typeof item.priority !== "string" ||
					!isOpenTodoPriority(item.priority)
				) {
					return [];
				}
				const blockedBy = Array.isArray(item.blockedBy)
					? item.blockedBy.filter(
							(blocker): blocker is string => typeof blocker === "string",
						)
					: undefined;
				return [
					{
						id: item.id,
						content: item.content,
						status: item.status,
						priority: item.priority,
						...(typeof item.notes === "string" ? { notes: item.notes } : {}),
						...(typeof item.due === "string" ? { due: item.due } : {}),
						...(blockedBy ? { blockedBy } : {}),
					},
				];
			}),
		};
	}
	return sanitized;
}

async function collectMissionManifests(
	workspaceDir: string,
): Promise<MissionManifest[]> {
	const parsed = await readJsonFileIfExists(
		join(workspaceDir, "features.json"),
	);
	return isMissionManifest(parsed) ? [parsed] : [];
}

function isMissionManifest(value: unknown): value is MissionManifest {
	if (!value || typeof value !== "object") {
		return false;
	}
	const manifest = value as Record<string, unknown>;
	return (
		typeof manifest.version === "number" &&
		typeof manifest.missionId === "string" &&
		Array.isArray(manifest.milestones) &&
		Array.isArray(manifest.features) &&
		typeof manifest.createdAt === "string" &&
		typeof manifest.updatedAt === "string" &&
		manifest.milestones.every(isMissionMilestone) &&
		manifest.features.every(isMissionFeature)
	);
}

function isMissionMilestone(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const milestone = value as Record<string, unknown>;
	return typeof milestone.id === "string" && typeof milestone.name === "string";
}

function isMissionFeature(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const feature = value as Record<string, unknown>;
	return (
		typeof feature.id === "string" &&
		typeof feature.description === "string" &&
		typeof feature.status === "string" &&
		isMissionFeatureStatus(feature.status) &&
		Array.isArray(feature.fulfills) &&
		feature.fulfills.every((item) => typeof item === "string") &&
		optionalString(feature.milestone) &&
		optionalString(feature.skillName) &&
		optionalString(feature.handoffSourceFeatureId) &&
		optionalMissionHandoffItemKind(feature.handoffFollowUpKind) &&
		optionalString(feature.handoffItemKey) &&
		(feature.handoff === undefined ||
			isMissionWorkerHandoff(feature.handoff)) &&
		(feature.handoffDismissals === undefined ||
			(Array.isArray(feature.handoffDismissals) &&
				feature.handoffDismissals.every(isMissionHandoffDismissal))) &&
		(feature.trackedHandoffItems === undefined ||
			(Array.isArray(feature.trackedHandoffItems) &&
				feature.trackedHandoffItems.every(isMissionTrackedHandoffItem)))
	);
}

function isMissionFeatureStatus(value: string): boolean {
	return (
		value === "pending" ||
		value === "in-progress" ||
		value === "passed" ||
		value === "failed" ||
		value === "preempted"
	);
}

function isMissionWorkerHandoff(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const handoff = value as Record<string, unknown>;
	return (
		typeof handoff.workerId === "string" &&
		typeof handoff.success === "boolean" &&
		typeof handoff.handedOffAt === "string" &&
		optionalString(handoff.repoPath) &&
		optionalString(handoff.commitId) &&
		optionalString(handoff.summary) &&
		optionalString(handoff.whatWasImplemented) &&
		optionalString(handoff.whatWasLeftUndone) &&
		(handoff.discoveredIssues === undefined ||
			(Array.isArray(handoff.discoveredIssues) &&
				handoff.discoveredIssues.every(isMissionDiscoveredIssue))) &&
		(handoff.verification === undefined ||
			isMissionVerification(handoff.verification))
	);
}

function isMissionDiscoveredIssue(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const issue = value as Record<string, unknown>;
	return (
		(issue.severity === "blocking" || issue.severity === "non_blocking") &&
		typeof issue.description === "string" &&
		optionalString(issue.suggestedFix)
	);
}

function isMissionVerification(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const verification = value as Record<string, unknown>;
	return (
		verification.commandsRun === undefined ||
		(Array.isArray(verification.commandsRun) &&
			verification.commandsRun.every(isMissionVerificationCommand))
	);
}

function isMissionVerificationCommand(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const command = value as Record<string, unknown>;
	return (
		typeof command.command === "string" &&
		(command.exitCode === undefined || typeof command.exitCode === "number") &&
		optionalString(command.observation)
	);
}

function isMissionHandoffDismissal(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const dismissal = value as Record<string, unknown>;
	return (
		isMissionHandoffItemKind(dismissal.kind) &&
		typeof dismissal.key === "string" &&
		typeof dismissal.justification === "string" &&
		typeof dismissal.dismissedAt === "string"
	);
}

function isMissionTrackedHandoffItem(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const tracked = value as Record<string, unknown>;
	return (
		typeof tracked.sourceFeatureId === "string" &&
		isMissionHandoffItemKind(tracked.kind) &&
		typeof tracked.key === "string" &&
		typeof tracked.trackedAt === "string" &&
		optionalString(tracked.note)
	);
}

function isMissionHandoffItemKind(value: unknown): boolean {
	return value === "unfinished_work" || value === "discovered_issue";
}

function optionalMissionHandoffItemKind(value: unknown): boolean {
	return value === undefined || isMissionHandoffItemKind(value);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

async function collectGitHubAgentWork(
	workspaceDir: string,
): Promise<GitHubAgentWorkProjection[]> {
	const memoryDir = join(workspaceDir, "memory");
	const [tasksJson, outcomesJson] = await Promise.all([
		readJsonFileIfExists(join(memoryDir, "tasks.json")),
		readJsonFileIfExists(join(memoryDir, "outcomes.json")),
	]);
	if (!tasksJson || typeof tasksJson !== "object") {
		return [];
	}
	const outcomes =
		outcomesJson && typeof outcomesJson === "object"
			? (outcomesJson as Record<string, unknown>)
			: {};
	return Object.entries(tasksJson as Record<string, unknown>)
		.map(([taskKey, task]) =>
			projectGitHubAgentTask(taskKey, task, outcomes[taskKey]),
		)
		.filter((task): task is GitHubAgentWorkProjection => task !== undefined)
		.sort(
			(left, right) =>
				Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "") ||
				left.id.localeCompare(right.id),
		);
}

function projectGitHubAgentTask(
	taskKey: string,
	task: unknown,
	outcome: unknown,
): GitHubAgentWorkProjection | undefined {
	if (!task || typeof task !== "object") {
		return undefined;
	}
	const taskRecord = task as Record<string, unknown>;
	if (typeof taskRecord.title !== "string" || !taskRecord.title.trim()) {
		return undefined;
	}
	const result =
		taskRecord.result && typeof taskRecord.result === "object"
			? (taskRecord.result as Record<string, unknown>)
			: undefined;
	const projectedStatus = projectGitHubAgentStatus(taskRecord, result, outcome);
	if (!projectedStatus) {
		return undefined;
	}
	const prUrl =
		typeof result?.prUrl === "string" && result.prUrl.trim()
			? result.prUrl
			: undefined;
	const branch =
		typeof result?.branch === "string" && result.branch.trim()
			? result.branch
			: undefined;
	const updatedAt = firstNonEmptyString(
		typeof (outcome as { updatedAt?: unknown })?.updatedAt === "string"
			? (outcome as { updatedAt: string }).updatedAt
			: undefined,
		typeof taskRecord.lastAttemptAt === "string"
			? taskRecord.lastAttemptAt
			: undefined,
		typeof taskRecord.createdAt === "string" ? taskRecord.createdAt : undefined,
	);
	const error =
		typeof result?.error === "string" && result.error.trim()
			? result.error
			: undefined;
	return {
		id:
			typeof taskRecord.id === "string" && taskRecord.id.trim()
				? taskRecord.id
				: taskKey,
		title: taskRecord.title,
		status: projectedStatus,
		...(branch ? { branch } : {}),
		...(prUrl ? { prUrl } : {}),
		...(updatedAt ? { updatedAt } : {}),
		...(error ? { error } : {}),
	};
}

function projectGitHubAgentStatus(
	task: Record<string, unknown>,
	result: Record<string, unknown> | undefined,
	outcome: unknown,
): GitHubAgentWorkProjection["status"] | undefined {
	const outcomeStatus =
		outcome && typeof outcome === "object" && "status" in outcome
			? (outcome as { status?: unknown }).status
			: undefined;
	if (outcomeStatus === "merged") {
		return "completed";
	}
	if (outcomeStatus === "changes_requested") {
		return "blocked";
	}
	if (outcomeStatus === "pending") {
		return "waiting";
	}
	if (outcomeStatus === "closed") {
		return "failed";
	}
	if (task.status === "pending") {
		return "pending";
	}
	if (task.status === "in_progress") {
		return "running";
	}
	if (task.status === "failed") {
		return "failed";
	}
	if (task.status === "completed") {
		if (result?.prUrl && typeof result.prUrl === "string") {
			return "waiting";
		}
		if (result?.success === false) {
			return "failed";
		}
		return "completed";
	}
	return undefined;
}

async function readJsonFileIfExists(
	path: string,
): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function firstNonEmptyString(
	...values: Array<string | undefined>
): string | undefined {
	return values.find((value) => typeof value === "string" && value.trim());
}

function isOpenTodoStatus(
	status: string,
): status is CustomerValueOpenWorkItem["status"] {
	return status === "pending" || status === "in_progress";
}

function isTodoStoreStatus(
	status: string,
): status is TodoStore[string]["items"][number]["status"] {
	return (
		status === "pending" || status === "in_progress" || status === "completed"
	);
}

function isOpenTodoPriority(
	priority: string,
): priority is CustomerValueOpenWorkItem["priority"] {
	return priority === "high" || priority === "medium" || priority === "low";
}

function compareOpenWorkItems(
	left: CustomerValueOpenWorkItem,
	right: CustomerValueOpenWorkItem,
): number {
	const statusOrder = { in_progress: 0, pending: 1 };
	const priorityOrder = { high: 0, medium: 1, low: 2 };
	return (
		statusOrder[left.status] - statusOrder[right.status] ||
		priorityOrder[left.priority] - priorityOrder[right.priority] ||
		Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
		left.content.localeCompare(right.content)
	);
}

function nextHandoffAction(
	card: TrustCard,
	status: CustomerValueHandoff["status"],
): string {
	if (status === "blocked") {
		return "Review the failed tool evidence and decide whether to rerun or split follow-up work.";
	}
	if (!card.evidence.hasMemoryProvenance) {
		return "Capture memory provenance so this work can compound into future sessions.";
	}
	if (status === "needs-followup") {
		return "Convert the risk signal into a tracked todo or workflow before moving on.";
	}
	return "Ready for customer-facing summary, reuse, or release notes.";
}

function compactHandoffText(text: string): string {
	const normalized = redactLine(text);
	return normalized.length > 240
		? `${normalized.slice(0, 237)}...`
		: normalized;
}

function estimateHoursSaved(input: {
	assistantTurnCount: number;
	toolCallCount: number;
}): number {
	return Number(
		(input.assistantTurnCount * 0.08 + input.toolCallCount * 0.03).toFixed(2),
	);
}

function buildWorkflowOpportunities(
	cards: TrustCard[],
	multiAgent: MultiAgentValue,
	ambient: AmbientCustomerValue,
): WorkflowOpportunity[] {
	const totalToolCalls = sum(cards, (card) => card.toolCallCount);
	const failedToolResults = sum(cards, (card) => card.failedToolResultCount);
	const memoryBacked = cards.filter(
		(card) => card.evidence.hasMemoryProvenance,
	).length;
	return [
		{
			id: "fix-failing-ci",
			name: "Fix failing CI",
			customerOutcome:
				"Turn failed checks into reviewed PRs with attached command/test evidence.",
			evidenceSignal:
				failedToolResults > 0
					? `${failedToolResults} failed tool result(s) are already visible in trust cards.`
					: "No failed tool results observed locally; keep this as a ready workflow.",
			recommendedSurface: "GitHub agent, CLI, and Slack handoff.",
			workflowTemplate: workflowTemplate("fix-failing-ci"),
		},
		{
			id: "review-pr",
			name: "Review this PR",
			customerOutcome:
				"Give reviewers a concise risk summary with replayable evidence.",
			evidenceSignal: `${cards.length} session(s) can already produce trust-card evidence.`,
			recommendedSurface:
				"GitHub PR comment plus `maestro value --format md` attachment.",
			workflowTemplate: workflowTemplate("review-pr"),
		},
		{
			id: "coordinate-agent-swarm",
			name: "Coordinate agent swarm",
			customerOutcome:
				"Split work across peer agents while preserving ownership, transcript, and workGraph evidence.",
			evidenceSignal:
				multiAgent.delegatedTaskCount > 0
					? `${multiAgent.delegatedTaskCount} A2A delegated task(s) across ${multiAgent.peerCount} peer(s); ${multiAgent.workGraphTaskCount} of ${multiAgent.taskCount} total ledger row(s) include workGraph metadata.`
					: multiAgent.taskCount > 0
						? `${multiAgent.taskCount} A2A ledger row(s) observed, but no delegated tasks; use this workflow to start collecting delegated multi-agent evidence.`
						: "No A2A delegated tasks observed locally; use this workflow to start collecting multi-agent evidence.",
			recommendedSurface:
				"`maestro a2a cockpit`, `maestro a2a delegate --work-graph`, and `maestro value --format md`.",
			workflowTemplate: workflowTemplate("coordinate-agent-swarm"),
		},
		{
			id: "ambient-nightly-watchdog",
			name: "Ambient nightly watchdog",
			customerOutcome:
				"Run unattended checks only when local evidence says there is customer-visible work to deliver.",
			evidenceSignal:
				ambient.automationOpportunities.length > 0
					? `${ambient.automationOpportunities.length} ambient automation opportunity/opportunities found; ${ambient.outcomeCount} learner outcome(s) available.`
					: "No ambient automation opportunities observed yet; use this as the default setup workflow.",
			recommendedSurface:
				"Ambient agent schedule, Slack/CLI delivery, and `maestro value --format md`.",
			workflowTemplate: workflowTemplate("ambient-nightly-watchdog"),
		},
		{
			id: "playbook-learning-review",
			name: "Playbook learning review",
			customerOutcome:
				"Promote repeated successes into playbooks while quarantining transient failures.",
			evidenceSignal:
				ambient.playbookLearningOpportunities.length > 0
					? `${ambient.playbookLearningOpportunities.length} playbook learning opportunity/opportunities found; ${ambient.protectedTransientFailureCount} transient failure(s) protected.`
					: "No playbook learning opportunities observed yet; keep the review path ready.",
			recommendedSurface:
				"Weekly customer-value report plus `.maestro/playbooks/` review.",
			workflowTemplate: workflowTemplate(
				"playbook-learning-review",
				ambient.learnerPath,
			),
		},
		{
			id: "cut-release",
			name: "Cut release",
			customerOutcome:
				"Verify publish readiness and produce a release audit trail.",
			evidenceSignal: `${totalToolCalls} local tool call(s) can feed release proof cards.`,
			recommendedSurface: "CLI release workflow and GitHub release automation.",
			workflowTemplate: workflowTemplate("cut-release"),
		},
		{
			id: "triage-dependabot",
			name: "Triage Dependabot",
			customerOutcome:
				"Separate safe dependency bumps from ones needing human security review.",
			evidenceSignal:
				"Use trust cards to show dependency files read, tests run, and approvals requested.",
			recommendedSurface: "Ambient GitHub agent.",
			workflowTemplate: workflowTemplate("triage-dependabot"),
		},
		{
			id: "refactor-with-tests",
			name: "Refactor with tests",
			customerOutcome:
				"Make codebase improvements repeatable with explicit verification.",
			evidenceSignal:
				memoryBacked > 0
					? `${memoryBacked} session(s) include memory provenance for follow-up context.`
					: "No memory-backed sessions observed; report flags this as a collection gap.",
			recommendedSurface: "TUI/CLI workflow template.",
			workflowTemplate: workflowTemplate("refactor-with-tests"),
		},
	];
}

function workflowTemplate(
	id: WorkflowOpportunityId,
	ambientLearnerPath = "",
): WorkflowOpportunity["workflowTemplate"] {
	return {
		path: `.maestro/workflows/${id}.yaml`,
		yaml:
			id === "playbook-learning-review"
				? WORKFLOW_TEMPLATE_YAML[id].replace(
						"__AMBIENT_LEARNER_PRESENCE_COMMAND__",
						ambientLearnerPresenceCommand(ambientLearnerPath),
					)
				: WORKFLOW_TEMPLATE_YAML[id],
	};
}

const WORKFLOW_TEMPLATE_YAML = {
	"fix-failing-ci": `name: fix-failing-ci
description: Diagnose failing checks, run focused tests, and produce evidence for a trust card.
version: "1"
default_on_error: stop
steps:
  - id: preflight
    tool: bash
    description: Capture branch and dirty files before changing anything.
    params:
      command: git status --short && git branch --show-current
  - id: likely_checks
    tool: bash
    description: List local check scripts that are likely to mirror CI.
    params:
      command: node -e "const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).filter(k=>/test|lint|check|build/.test(k)).map(k=>'npm run '+k).join('\\\\n'))"
  - id: value_report
    tool: bash
    description: Emit current customer-value evidence for handoff.
    params:
      command: maestro value week --format md`,
	"review-pr": `name: review-pr
description: Produce a concise PR risk summary with replayable local evidence.
version: "1"
default_on_error: continue
steps:
  - id: pr_context
    tool: bash
    description: Read PR metadata when GitHub CLI context is available.
    params:
      command: gh pr view --json number,title,author,headRefName,baseRefName,reviewDecision,statusCheckRollup
  - id: diff_summary
    tool: bash
    description: Capture changed files for risk review.
    params:
      command: git diff --stat origin/$(git branch --show-current)...HEAD || git diff --stat
  - id: value_report
    tool: bash
    description: Attach trust-card evidence from local sessions.
    params:
      command: maestro value week --format md`,
	"coordinate-agent-swarm": `name: coordinate-agent-swarm
description: Coordinate delegated work across A2A peers and preserve customer-visible evidence.
version: "1"
default_on_error: stop
steps:
  - id: cockpit
    tool: bash
    description: Show peer health, task ownership, and delegated work.
    params:
      command: maestro a2a cockpit
  - id: task_graphs
    tool: bash
    description: Show workGraph-backed delegated work and peer ownership from the local ledger.
    params:
      command: maestro a2a tasks --work-graph
  - id: delegate
    tool: bash
    description: Delegate one objective to the selected peer with workGraph evidence.
    params:
      command: test -n "$MAESTRO_A2A_PEER" && test -n "$MAESTRO_A2A_OBJECTIVE" && maestro a2a delegate "$MAESTRO_A2A_PEER" "$MAESTRO_A2A_OBJECTIVE" --wait --work-graph
  - id: value_report
    tool: bash
    description: Emit customer-visible multi-agent value evidence after coordination.
    params:
      command: maestro value week --format md`,
	"ambient-nightly-watchdog": `name: ambient-nightly-watchdog
description: Run unattended evidence checks and deliver only when there is customer-visible work.
version: "1"
default_on_error: continue
steps:
  - id: ambient_status
    tool: bash
    description: Check whether the ambient daemon is reachable.
    params:
      command: ambient status || true
  - id: a2a_pressure
    tool: bash
    description: Capture delegated work that needs an operator.
    params:
      command: maestro a2a cockpit || true
  - id: value_report
    tool: bash
    description: Produce the customer-visible watchdog report.
    params:
      command: maestro value week --format md`,
	"playbook-learning-review": `name: playbook-learning-review
description: Promote durable ambient lessons and quarantine transient setup failures.
version: "1"
default_on_error: continue
steps:
  - id: learner_presence
    tool: bash
    description: Check whether ambient learner evidence exists.
    params:
      command: __AMBIENT_LEARNER_PRESENCE_COMMAND__
  - id: learner_flush
    tool: bash
    description: Flush any in-memory learner outcomes before rendering the report.
    params:
      command: ambient flush || true
  - id: value_report
    tool: bash
    description: Render automation and playbook learning opportunities.
    params:
      command: maestro value week --format md
  - id: playbook_dir
    tool: bash
    description: Show current local playbooks for human review.
    params:
      command: find .maestro/playbooks -maxdepth 1 -type f 2>/dev/null || true`,
	"cut-release": `name: cut-release
description: Verify release readiness and produce an audit trail before publishing.
version: "1"
default_on_error: stop
steps:
  - id: preflight
    tool: bash
    description: Confirm branch, remote, and dirty files.
    params:
      command: git status --short && git branch --show-current && git remote -v
  - id: release_guardrails
    tool: bash
    description: Run release workflow guardrails when available.
    params:
      command: npm run check:workflow-footguns --if-present
  - id: value_report
    tool: bash
    description: Produce release proof evidence.
    params:
      command: maestro value week --format md`,
	"triage-dependabot": `name: triage-dependabot
description: Separate safe dependency bumps from updates needing human security review.
version: "1"
default_on_error: continue
steps:
  - id: dependabot_prs
    tool: bash
    description: List open Dependabot PRs when GitHub CLI context is available.
    params:
      command: gh pr list --author app/dependabot --json number,title,headRefName,labels,reviewDecision,statusCheckRollup
  - id: lockfile_changes
    tool: bash
    description: Show dependency file changes in the current branch.
    params:
      command: git diff --stat -- package.json package-lock.json bun.lockb pnpm-lock.yaml yarn.lock
  - id: value_report
    tool: bash
    description: Preserve trust-card evidence for the triage run.
    params:
      command: maestro value week --format md`,
	"refactor-with-tests": `name: refactor-with-tests
description: Make a scoped refactor repeatable with explicit verification and memory provenance.
version: "1"
default_on_error: stop
steps:
  - id: preflight
    tool: bash
    description: Capture current branch and dirty files before refactoring.
    params:
      command: git status --short && git branch --show-current
  - id: candidate_checks
    tool: bash
    description: List tests and checks available in this project.
    params:
      command: node -e "const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).filter(k=>/test|lint|check|type/.test(k)).map(k=>'npm run '+k).join('\\\\n'))"
  - id: value_report
    tool: bash
    description: Emit value, evidence, and memory provenance after the refactor.
    params:
      command: maestro value week --format md`,
} as const satisfies Record<
	WorkflowOpportunityId,
	WorkflowOpportunity["workflowTemplate"]["yaml"]
>;

function buildAdminControls(params: {
	ambient: AmbientCustomerValue;
	multiAgent: MultiAgentValue;
	trustCards: TrustCard[];
	telemetry: TelemetrySummary;
	sessionDir: string;
}): CustomerValueReport["admin"] {
	return {
		controls: [
			{
				id: "policy-and-approval-audit",
				name: "Policy and approval audit",
				status:
					params.telemetry.policyApprovalAuditEvents > 0 ? "available" : "gap",
				evidence:
					params.telemetry.policyApprovalAuditEvents > 0
						? `${params.telemetry.policyApprovalAuditEvents} policy/approval audit telemetry event(s) parsed.`
						: "No canonical-turn, policy, or approval telemetry found for policy rollups.",
			},
			{
				id: "session-evidence-retention",
				name: "Session evidence retention",
				status: params.trustCards.length > 0 ? "available" : "gap",
				evidence:
					params.trustCards.length > 0
						? `${params.trustCards.length} trust-card session(s) loaded from ${params.sessionDir}.`
						: `No session JSONL files found in ${params.sessionDir}.`,
			},
			{
				id: "spend-and-routing",
				name: "Spend and routing",
				status: params.trustCards.some((card) => card.usage.requests > 0)
					? "available"
					: "gap",
				evidence: "Uses local usage records keyed by session id.",
			},
			{
				id: "team-memory-provenance",
				name: "Team memory provenance",
				status: params.trustCards.some(
					(card) => card.evidence.hasMemoryProvenance,
				)
					? "available"
					: "gap",
				evidence: "Uses session memory extraction hashes when present.",
			},
			{
				id: "multi-agent-delegation-ledger",
				name: "Multi-agent delegation ledger",
				status: params.multiAgent.delegatedTaskCount > 0 ? "available" : "gap",
				evidence:
					params.multiAgent.taskCount > 0
						? `${params.multiAgent.delegatedTaskCount} A2A delegated task(s) and ${params.multiAgent.taskCount} total A2A ledger row(s) loaded from ${params.multiAgent.tasksPath}.`
						: (params.multiAgent.collectionGaps[0] ??
							`No A2A delegated task evidence found in ${params.multiAgent.tasksPath}.`),
			},
			{
				id: "ambient-learning-loop",
				name: "Ambient learning loop",
				status: params.ambient.outcomeCount > 0 ? "available" : "gap",
				evidence:
					params.ambient.outcomeCount > 0
						? `${params.ambient.outcomeCount} ambient learner outcome(s), ${params.ambient.actionablePatternCount} actionable pattern(s), and ${params.ambient.protectedTransientFailureCount} protected transient failure(s) loaded from ${params.ambient.learnerPath}.`
						: (params.ambient.collectionGaps[0] ??
							`No ambient learner evidence found in ${params.ambient.learnerPath}.`),
			},
		],
	};
}

async function summarizeTelemetry(
	path: string,
	range: CustomerValueRange,
): Promise<TelemetrySummary> {
	const summary: TelemetrySummary = {
		parsedEventCount: 0,
		malformedLineCount: 0,
		toolExecutionEvents: 0,
		evaluationEvents: 0,
		canonicalTurnEvents: 0,
		policyApprovalAuditEvents: 0,
		collectionGaps: [],
	};
	if (!existsSync(path)) {
		summary.collectionGaps.push(`Telemetry log not found at ${path}.`);
		return summary;
	}
	let raw = "";
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		summary.collectionGaps.push(
			`Telemetry log could not be read: ${sanitizeWithStaticMask(error instanceof Error ? error.message : String(error))}.`,
		);
		return summary;
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const event = JSON.parse(trimmed);
			if (!isTelemetryEventInRange(event, range)) continue;
			summary.parsedEventCount += 1;
			if (event.type === "tool-execution") summary.toolExecutionEvents += 1;
			if (event.type === "evaluation") summary.evaluationEvents += 1;
			if (event.type === "canonical-turn") summary.canonicalTurnEvents += 1;
			if (isPolicyApprovalAuditEvent(event)) {
				summary.policyApprovalAuditEvents += 1;
			}
		} catch {
			summary.malformedLineCount += 1;
		}
	}
	if (summary.parsedEventCount === 0) {
		summary.collectionGaps.push(
			range.since === undefined && range.until === undefined
				? "Telemetry log exists but has no parsed events."
				: "Telemetry log exists but has no parsed events in the selected range.",
		);
	} else if (summary.policyApprovalAuditEvents === 0) {
		summary.collectionGaps.push(
			"Telemetry log has parsed events but no canonical-turn, policy, or approval audit events.",
		);
	}
	return summary;
}

function isPolicyApprovalAuditEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const record = event as Record<string, unknown>;
	const candidates = [
		record.type,
		record.event,
		record.name,
		record.subject,
		record.kind,
	]
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.toLowerCase());
	return candidates.some(
		(value) =>
			value === "canonical-turn" ||
			value === "policy.decision" ||
			value === "policy-decision" ||
			value === "approval" ||
			value === "approval-request" ||
			value === "approval_hit" ||
			value === "action_approval_required" ||
			value === "action_approval_resolved" ||
			value.includes(".approval_") ||
			value.includes(".policy."),
	);
}

function isTelemetryEventInRange(
	event: unknown,
	range: CustomerValueRange,
): boolean {
	if (range.since === undefined && range.until === undefined) return true;
	if (!event || typeof event !== "object") return false;
	const record = event as Record<string, unknown>;
	const timestamp = parseTimestampMs(
		record.timestamp ?? record.time ?? record.createdAt,
	);
	return isTimestampInRange(timestamp, range);
}

function isTimestampInRange(
	timestamp: unknown,
	range: CustomerValueRange,
): boolean {
	const timestampMs = parseTimestampMs(timestamp);
	if (timestampMs === undefined) return false;
	if (range.since !== undefined && timestampMs < range.since) return false;
	if (range.until !== undefined && timestampMs >= range.until) return false;
	return true;
}

function parseTimestampMs(timestamp: unknown): number | undefined {
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
		return timestamp;
	}
	if (typeof timestamp !== "string" || timestamp.trim() === "") {
		return undefined;
	}
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function buildCollectionGaps(params: {
	ambient: AmbientCustomerValue;
	multiAgent: MultiAgentValue;
	trustCards: TrustCard[];
	telemetry: TelemetrySummary;
	usageEntries: UsageEntry[];
}): string[] {
	const gaps = [
		...params.telemetry.collectionGaps,
		...params.multiAgent.collectionGaps,
		...params.ambient.collectionGaps,
	];
	if (params.trustCards.length === 0) {
		gaps.push("No session trust cards were available for the selected range.");
	}
	if (params.usageEntries.length === 0) {
		gaps.push("No usage entries were available for the selected range.");
	}
	if (!params.trustCards.some((card) => card.evidence.hasSummary)) {
		gaps.push("No trust cards had persisted session summaries.");
	}
	if (!params.trustCards.some((card) => card.evidence.hasMemoryProvenance)) {
		gaps.push("No trust cards had memory extraction provenance.");
	}
	return [...new Set(gaps)];
}

function buildRiskSignals(
	toolStats: ReturnType<typeof collectToolStats>,
	memoryExtractionHash: string | undefined,
): string[] {
	const signals: string[] = [];
	if (toolStats.failedToolResultCount > 0) {
		signals.push(`${toolStats.failedToolResultCount} failed tool result(s)`);
	}
	if (toolStats.toolCallCount === 0) {
		signals.push("no tool evidence captured");
	}
	if (!memoryExtractionHash) {
		signals.push("no durable memory provenance");
	}
	return signals;
}

function buildCustomerSignals(input: {
	toolStats: ReturnType<typeof collectToolStats>;
	summary: string;
	usage: SessionUsage;
	hasMemory: boolean;
}): string[] {
	const signals: string[] = [];
	if (input.summary) signals.push("persisted summary");
	if (input.toolStats.toolCallCount > 0) {
		signals.push(`${input.toolStats.toolCallCount} tool-backed action(s)`);
	}
	if (input.usage.requests > 0) {
		signals.push(`${input.usage.requests} model request(s) costed`);
	}
	if (input.hasMemory) signals.push("durable memory provenance");
	return signals;
}

function findSessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.isFile() && extname(entry.name) === ".jsonl") {
				files.push(path);
			}
		}
	};
	visit(root);
	return files;
}

function normalizeLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function redactLine(text: string): string {
	return sanitizeWithStaticMask(normalizeLine(text));
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

function sum<T>(values: T[], read: (value: T) => number): number {
	return values.reduce((total, value) => total + read(value), 0);
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}
