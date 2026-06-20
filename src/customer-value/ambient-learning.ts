/**
 * Ambient learner subsystem for the customer-value report.
 *
 * Owns everything that reads/classifies the ambient learner outcome file:
 * daemon flush, JSON parsing, pattern derivation, transient-failure
 * classification, and the ambient customer-value/opportunity builders that
 * turn learner evidence into report sections.
 *
 * Extracted from report.ts to isolate the highest-churn surface (transient
 * classification + flush freshness evolve frequently) behind a stable module
 * boundary. Runtime dependencies are one-directional: this module imports
 * shared leaf helpers from ./internal-helpers.js and types from ./report.js
 * (type-only). report.ts imports the summary/build entry points back here.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { RuntimeEnv } from "../runtime/env.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import {
	isTimestampInRangeOrUnbounded,
	numberOrZero,
	parseTimestampMs,
	redactLine,
	sanitizeA2ALabel,
	slugify,
	sum,
} from "./internal-helpers.js";
import type {
	CustomerValueRange,
	CustomerValueReport,
	MultiAgentValue,
	TrustCard,
} from "./report.js";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function ambientLearnerPresenceCommand(learnerPath: string): string {
	return `test -s ${shellQuote(learnerPath)}`;
}

export interface AmbientLearnerFlushResult {
	flushed: boolean;
	learnerPath?: string;
	collectionGap?: string;
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

export async function flushAmbientLearnerForReport(
	env: RuntimeEnv,
	_learnerPath: string,
	flush: (env: RuntimeEnv) => Promise<AmbientLearnerFlushResult>,
): Promise<AmbientLearnerFlushResult> {
	return flush(env);
}

export async function flushAmbientLearnerBeforeRead(
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

export async function summarizeAmbientLearning(
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

export function buildAmbientCustomerValue(input: {
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
