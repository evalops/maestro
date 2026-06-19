import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { MissionStore } from "../../src/agent/mission-store.js";
import { handleValueCommand } from "../../src/cli/commands/value.js";
import {
	buildCustomerValueReport,
	formatCustomerValueMarkdown,
	formatCustomerValueReport,
	resolveCustomerValueRange,
	writeCustomerValueArtifacts,
} from "../../src/customer-value/report.js";
import {
	createRuntimeEnv,
	resetDefaultRuntimeEnvForTests,
} from "../../src/runtime/env.js";
import { clearUsage, trackUsage } from "../../src/tracking/cost-tracker.js";
import { validateWorkflow } from "../../src/workflows/engine.js";

describe("customer value report", () => {
	let tempDir: string;
	let sessionDir: string;
	let telemetryPath: string;
	let originalUsageFile: string | undefined;
	let originalSessionDir: string | undefined;
	let originalTelemetryFile: string | undefined;
	let originalA2ATasksFile: string | undefined;
	let originalAmbientLearnerFile: string | undefined;
	let originalHome: string | undefined;
	let originalMissionStoreDir: string | undefined;
	let originalPath: string | undefined;
	let originalTodoFile: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "maestro-value-report-"));
		sessionDir = join(tempDir, "sessions");
		telemetryPath = join(tempDir, "telemetry.log");
		mkdirSync(sessionDir, { recursive: true });
		originalUsageFile = process.env.MAESTRO_USAGE_FILE;
		originalSessionDir = process.env.MAESTRO_SESSION_DIR;
		originalTelemetryFile = process.env.MAESTRO_TELEMETRY_FILE;
		originalA2ATasksFile = process.env.MAESTRO_A2A_TASKS_FILE;
		originalAmbientLearnerFile = process.env.MAESTRO_AMBIENT_LEARNER_FILE;
		originalHome = process.env.HOME;
		originalMissionStoreDir = process.env.MAESTRO_MISSION_STORE_DIR;
		originalPath = process.env.PATH;
		originalTodoFile = process.env.MAESTRO_TODO_FILE;
		process.env.MAESTRO_USAGE_FILE = join(tempDir, "usage.json");
		process.env.MAESTRO_SESSION_DIR = sessionDir;
		process.env.MAESTRO_TELEMETRY_FILE = telemetryPath;
		process.env.MAESTRO_A2A_TASKS_FILE = join(tempDir, "a2a-tasks.json");
		process.env.MAESTRO_AMBIENT_LEARNER_FILE = join(
			tempDir,
			"ambient-learner.json",
		);
		process.env.MAESTRO_TODO_FILE = join(tempDir, "todos.json");
		clearUsage();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("MAESTRO_USAGE_FILE", originalUsageFile);
		restoreEnv("MAESTRO_SESSION_DIR", originalSessionDir);
		restoreEnv("MAESTRO_TELEMETRY_FILE", originalTelemetryFile);
		restoreEnv("MAESTRO_A2A_TASKS_FILE", originalA2ATasksFile);
		restoreEnv("MAESTRO_AMBIENT_LEARNER_FILE", originalAmbientLearnerFile);
		restoreEnv("HOME", originalHome);
		restoreEnv("MAESTRO_MISSION_STORE_DIR", originalMissionStoreDir);
		restoreEnv("PATH", originalPath);
		restoreEnv("MAESTRO_TODO_FILE", originalTodoFile);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds trust cards, value estimates, workflow opportunities, and admin controls from local evidence", async () => {
		const sessionPath = writeSessionFixture(sessionDir);
		writeA2ATasksFixture(process.env.MAESTRO_A2A_TASKS_FILE!);
		writeAmbientLearnerFixture(process.env.MAESTRO_AMBIENT_LEARNER_FILE!);
		trackUsage({
			sessionId: "session-value-1",
			provider: "openai",
			model: "gpt-5.5",
			tokensInput: 1000,
			tokensOutput: 500,
			cost: 0.05,
		});
		trackUsage({
			sessionId: "session-outside-visible-cards",
			provider: "openai",
			model: "gpt-5.5",
			tokensInput: 50_000,
			tokensOutput: 10_000,
			cost: 12,
		});
		writeFileSync(
			telemetryPath,
			[
				JSON.stringify({ type: "tool-execution", success: true }),
				JSON.stringify({ type: "canonical-turn", turnId: "turn-1" }),
			].join("\n"),
		);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			ambientLearnerPath: process.env.MAESTRO_AMBIENT_LEARNER_FILE!,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.summary.sessionCount).toBe(1);
		expect(report.summary.toolCallCount).toBe(1);
		expect(report.summary.failedToolResultCount).toBe(1);
		expect(report.summary.totalCostUsd).toBe(0.05);
		expect(report.summary.totalTokens).toBe(1500);
		expect(report.summary.estimatedHoursSaved).toBeGreaterThan(0);
		expect(report.summary.multiAgentEstimatedHoursSaved).toBe(0.35);
		expect(report.summary.multiAgentEstimatedValueUsd).toBe(52.5);
		expect(report.summary.multiAgentTaskCount).toBe(2);
		expect(report.summary.multiAgentPeerCount).toBe(2);
		expect(report.summary.multiAgentWorkGraphTaskCount).toBe(2);
		expect(report.summary.multiAgentChildRunCount).toBe(2);
		expect(report.summary.ambientAutomationOpportunityCount).toBe(3);
		expect(report.summary.playbookLearningOpportunityCount).toBe(3);
		expect(report.summary.ambientLearnerOutcomeCount).toBe(3);
		expect(report.summary.ambientProtectedTransientFailureCount).toBe(1);
		expect(report.trustCards[0]).toMatchObject({
			sessionId: "session-value-1",
			title: "Release workflow trust card",
			evidence: {
				sessionPath,
				hasSummary: true,
				hasMemoryProvenance: true,
				memoryExtractionHash: "mem_hash_123",
			},
		});
		expect(report.trustCards[0]?.topTools).toEqual([
			{ name: "bash", count: 2 },
		]);
		expect(report.memory.items[0]?.memoryExtractionHash).toBe("mem_hash_123");
		expect(report.multiAgent).toMatchObject({
			taskCount: 2,
			delegatedTaskCount: 2,
			completedTaskCount: 1,
			failedTaskCount: 0,
			actionRequiredTaskCount: 1,
			workGraphTaskCount: 2,
			workGraphChildRunCount: 2,
			workGraphBlockedItemCount: 2,
			workGraphWaitingItemCount: 2,
			workGraphPendingToolCallCount: 2,
			codexSubagentEdgeCount: 2,
			realizedHoursSaved: 0.35,
			realizedValueUsd: 52.5,
			pendingTaskCount: 1,
			auditReadyTaskCount: 1,
			evidenceGapCount: 3,
			transcriptMessageCount: 3,
		});
		expect(report.multiAgent.nextActions[0]).toMatchObject({
			id: "reply:review-agent:task-2",
			label: "Reply to review-agent task task-2",
			command:
				"maestro a2a reply review-agent task-2 'RESPONSE_TEXT' --wait --work-graph",
			severity: "critical",
			reason:
				"Peer returned an input-required or auth-required A2A state. Work graph shows 1 blocked work item, 1 waiting work item, and 1 pending tool call.",
		});
		expect(report.agentWorkBoard.counts.total).toBe(3);
		expect(report.agentWorkBoard.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "a2a",
					status: "waiting",
					owner: "Review Agent",
					nextAction: expect.objectContaining({
						command:
							"maestro a2a reply review-agent task-2 <response> --wait --work-graph",
					}),
				}),
			]),
		);
		expect(report.multiAgent.topPeers).toEqual([
			expect.objectContaining({
				peer: "mac-mini",
				displayName: "Mac Mini",
				taskCount: 1,
			}),
			expect.objectContaining({
				peer: "review-agent",
				displayName: "Review Agent",
				taskCount: 1,
			}),
		]);
		expect(report.multiAgent.recentTasks[0]).toMatchObject({
			id: "task-2",
			peer: "review-agent",
			status: "waiting",
			workGraph: true,
			workGraphSummary:
				"Work graph: waiting | blocked 1 | waiting 1 | pending tools 1",
		});
		expect(report.multiAgent.recentTasks[1]).toMatchObject({
			id: "task-1",
			peer: "mac-mini",
			status: "completed",
			workGraph: true,
			workGraphSummary:
				"Work graph: completed | items 4 | active 0 | blocked 1 | waiting 1 | child runs 2 | tools 3 | pending tools 1 | waits 1",
			codexSubagents:
				"Codex subagents: edges 2 | lifecycle spawn:completed(run-1), wait:completed(run-2) | child runs run-1, run-2 | tools spawn-1, wait-1 | threads thread-1",
		});
		expect(report.ambient).toMatchObject({
			outcomeCount: 3,
			successCount: 2,
			failureCount: 1,
			patternCount: 7,
			actionablePatternCount: 0,
			protectedTransientFailureCount: 1,
		});
		expect(
			report.ambient.automationOpportunities.map((item) => item.id),
		).toEqual([
			"a2a-followup-watchdog",
			"failed-tool-digest",
			"ambient-learner-review",
		]);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).toEqual([
			"protect-transient-failures",
			"multi-agent-verification-playbook",
			"handoff-memory-playbook",
		]);
		expect(
			report.ambient.automationOpportunities
				.filter((item) => item.scriptGate.includes("jq"))
				.every((item) => item.scriptGate.includes("jq -e")),
		).toBe(true);
		const markdown = formatCustomerValueMarkdown(report);
		expect(markdown).toContain("- Task: `task-2`");
		expect(markdown).toContain("- Task: `task-1`");
		expect(markdown).toContain("## Ambient Automation");
		expect(markdown).toContain("## Playbook Learning");
		expect(markdown).toContain("protect-transient-failures");
		expect(markdown).not.toContain("a2a-task-2");
		expect(markdown).not.toContain("a2a-task-1");
		expect(report.workflows.map((workflow) => workflow.id)).toContain(
			"fix-failing-ci",
		);
		expect(report.workflows.map((workflow) => workflow.id)).toContain(
			"coordinate-agent-swarm",
		);
		expect(report.workflows.map((workflow) => workflow.id)).toContain(
			"ambient-nightly-watchdog",
		);
		expect(report.workflows.map((workflow) => workflow.id)).toContain(
			"playbook-learning-review",
		);
		expect(report.workflows).toContainEqual(
			expect.objectContaining({
				id: "coordinate-agent-swarm",
				evidenceSignal:
					"2 A2A delegated task(s) across 2 peer(s); 2 of 2 total ledger row(s) include workGraph metadata.",
			}),
		);
		for (const workflow of report.workflows) {
			expect(workflow.workflowTemplate.path).toBe(
				`.maestro/workflows/${workflow.id}.yaml`,
			);
			expect(workflow.workflowTemplate.yaml).toContain(`name: ${workflow.id}`);
			expect(workflow.workflowTemplate.yaml).toContain(
				"maestro value week --format md",
			);
			const parsedWorkflow = parseYaml(workflow.workflowTemplate.yaml);
			expect(validateWorkflow(parsedWorkflow, new Set(["bash"]))).toEqual({
				valid: true,
				errors: [],
			});
			if (workflow.id === "coordinate-agent-swarm") {
				expect(workflow.workflowTemplate.yaml).not.toContain("<peer>");
				expect(workflow.workflowTemplate.yaml).not.toContain("<objective>");
				expect(workflow.workflowTemplate.yaml).toContain("MAESTRO_A2A_PEER");
				expect(workflow.workflowTemplate.yaml).toContain(
					"MAESTRO_A2A_OBJECTIVE",
				);
			}
		}
		expect(report.admin.controls).toContainEqual(
			expect.objectContaining({
				id: "policy-and-approval-audit",
				status: "available",
			}),
		);
		expect(report.admin.controls).toContainEqual(
			expect.objectContaining({
				id: "multi-agent-delegation-ledger",
				status: "available",
				evidence: expect.stringContaining(
					"2 A2A delegated task(s) and 2 total A2A ledger row(s)",
				),
			}),
		);
		expect(report.admin.controls).toContainEqual(
			expect.objectContaining({
				id: "ambient-learning-loop",
				status: "available",
				evidence: expect.stringContaining("3 ambient learner outcome(s)"),
			}),
		);
		expect(report.telemetry.parsedEventCount).toBe(2);
		expect(report.telemetry.policyApprovalAuditEvents).toBe(1);
	});

	it("gates memory digest automation on any trust card missing memory provenance", async () => {
		writeSessionFixture(sessionDir, {
			sessionId: "session-memory-backed",
			subject: "Memory backed session",
		});
		const missingMemorySessionPath = writeSessionFixture(sessionDir, {
			sessionId: "session-memory-missing",
			subject: "Missing memory session",
		});
		const withoutMemory = readFileSync(missingMemorySessionPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (entry.type === "session_meta") {
					Reflect.deleteProperty(entry, "memoryExtractionHash");
				}
				return JSON.stringify(entry);
			})
			.join("\n");
		writeFileSync(missingMemorySessionPath, `${withoutMemory}\n`);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			flushAmbientLearner: false,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		const memoryDigest = report.ambient.automationOpportunities.find(
			(opportunity) => opportunity.id === "memory-gap-digest",
		);
		expect(memoryDigest?.scriptGate).toBe(
			"maestro value week --format json | jq -e 'any(.trustCards[]?; .evidence.hasMemoryProvenance | not)'",
		);
		expect(report.collectionGaps).not.toContain(
			"No trust cards had memory extraction provenance.",
		);
	});

	it("loads ambient learner evidence from the daemon default data path", async () => {
		const env = createRuntimeEnv({
			HOME: tempDir,
			USERPROFILE: tempDir,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		mkdirSync(dirname(env.ambientLearnerDefaultFile), { recursive: true });
		writeAmbientLearnerFixture(env.ambientLearnerDefaultFile);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			env,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.sources.ambientLearnerPath).toBe(
			env.ambientLearnerDefaultFile,
		);
		expect(report.ambient.outcomeCount).toBe(3);
		expect(
			report.ambient.automationOpportunities.find(
				(opportunity) => opportunity.id === "ambient-learner-review",
			)?.scriptGate,
		).toBe(`test -s '${env.ambientLearnerDefaultFile}'`);
	});

	it("scopes ambient playbook patterns to the selected report range", async () => {
		const learnerPath = process.env.MAESTRO_AMBIENT_LEARNER_FILE!;
		writeFileSync(
			learnerPath,
			`${JSON.stringify(
				{
					outcomes: [
						{
							success: true,
							labels: ["bug"],
							repo: "evalops/maestro-internal",
							task_type: "fix",
							event_type: "issue",
							cost_usd: 0.01,
							timestamp: "2026-06-01T09:00:00.000Z",
						},
						{
							success: true,
							labels: ["bug"],
							repo: "evalops/maestro-internal",
							task_type: "fix",
							event_type: "issue",
							cost_usd: 0.01,
							timestamp: "2026-06-01T10:00:00.000Z",
						},
						{
							success: true,
							labels: ["bug"],
							repo: "evalops/maestro-internal",
							task_type: "fix",
							event_type: "issue",
							cost_usd: 0.01,
							timestamp: "2026-06-01T11:00:00.000Z",
						},
					],
					patterns: [
						{
							pattern_type: "Label",
							key: "bug",
							success_rate: 1,
							sample_count: 9,
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			ambientLearnerPath: learnerPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.outcomeCount).toBe(0);
		expect(report.ambient.patternCount).toBe(0);
		expect(report.ambient.playbookLearningOpportunities).not.toContainEqual(
			expect.objectContaining({ id: "capture-successful-pattern" }),
		);
		expect(report.admin.controls).toContainEqual(
			expect.objectContaining({
				id: "ambient-learning-loop",
				status: "gap",
			}),
		);
	});

	it("recomputes all-time ambient patterns from retained outcomes", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [
				{
					task_id: "ambient-1",
					event_type: "issue",
					task_type: "fix",
					success: true,
					cost_usd: 0.04,
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:00:00.000Z",
				},
				{
					task_id: "ambient-2",
					event_type: "issue",
					task_type: "fix",
					success: true,
					cost_usd: 0.04,
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:05:00.000Z",
				},
			],
			patterns: [
				{
					pattern_type: "Label",
					key: "bug",
					success_rate: 0.95,
					sample_count: 9,
					last_updated: "2026-06-18T09:05:00.000Z",
				},
				{
					pattern_type: "EventType",
					key: "Issue",
					success_rate: 0.1,
					sample_count: 8,
					last_updated: "2026-06-18T09:05:00.000Z",
				},
			],
		});

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.outcomeCount).toBe(2);
		expect(report.ambient.patternCount).toBe(4);
		expect(report.ambient.actionablePatternCount).toBe(0);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).not.toContain("capture-successful-pattern");
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).not.toContain("repair-low-success-pattern");
	});

	it("builds durable handoffs from session summaries and open todo work", async () => {
		const sessionPath = writeSessionFixture(sessionDir, {
			sessionId: "session-handoff-1",
			title: "Checkout recovery workflow",
			subject: "Make checkout recovery durable",
		});
		writeFileSync(
			process.env.MAESTRO_TODO_FILE!,
			JSON.stringify(
				{
					"checkout-recovery": {
						goal: "Ship checkout recovery",
						updatedAt: "2026-06-18T11:00:00.000Z",
						items: [
							{
								id: "qa",
								content:
									"Run hosted checkout QA with sk-abcdefghijklmnopqrstuv",
								status: "in_progress",
								priority: "high",
								blockedBy: ["staging account token sk-abcdefghijklmnopqrstuv"],
							},
							{
								id: "notes",
								content: "Publish customer notes",
								status: "pending",
								priority: "medium",
							},
							{
								id: "plan",
								content: "Draft plan",
								status: "completed",
								priority: "high",
							},
						],
					},
				},
				null,
				2,
			),
		);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.handoffs.sessions[0]).toMatchObject({
			sessionId: "session-handoff-1",
			title: "Checkout recovery workflow",
			status: "blocked",
			evidence: {
				sessionPath,
				summaryStored: true,
				memoryBacked: true,
			},
		});
		expect(report.handoffs.blockedCount).toBe(1);
		expect(report.handoffs.openWorkCount).toBe(2);
		expect(report.handoffs.openWork.map((item) => item.id)).toEqual([
			"qa",
			"notes",
		]);
		expect(report.handoffs.openWork[0]).toMatchObject({
			goal: "Ship checkout recovery",
			content: "Run hosted checkout QA with [secret]",
			status: "in_progress",
			blockers: ["staging account token [secret]"],
		});
		expect(JSON.stringify(report.handoffs.openWork)).not.toContain(
			"sk-abcdefghijklmnopqrstuv",
		);
		expect(formatCustomerValueMarkdown(report)).toContain(
			"## Durable Handoffs",
		);
		expect(formatCustomerValueReport(report)).toContain("Durable Handoffs");
	});

	it("includes mission, todo, github, handoff, and a2a work in the customer board", async () => {
		writeSessionFixture(sessionDir, {
			sessionId: "session-board-1",
			title: "Customer board handoff",
		});
		writeA2ATasksFixture(process.env.MAESTRO_A2A_TASKS_FILE!);
		writeFileSync(
			process.env.MAESTRO_TODO_FILE!,
			JSON.stringify(
				{
					"customer-board": {
						goal: "Ship customer board",
						updatedAt: "2026-06-18T11:00:00.000Z",
						items: [
							{
								id: "todo-board-1",
								content: "Publish customer notes",
								status: "pending",
								priority: "medium",
							},
						],
					},
				},
				null,
				2,
			),
		);
		writeMissionManifestFixture(join(tempDir, "features.json"));
		writeMissionManifestFixture(join(tempDir, "fixtures", "features.json"));
		writeGitHubAgentMemoryFixture(join(tempDir, "memory"));
		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir: tempDir,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.agentWorkBoard.counts.total).toBe(6);
		expect(
			report.agentWorkBoard.items.filter((item) => item.source === "mission"),
		).toHaveLength(1);
		expect(report.agentWorkBoard.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "mission",
					status: "running",
					title: "Capture durable customer report board",
				}),
				expect.objectContaining({
					source: "todo",
					status: "pending",
					title: "Publish customer notes",
				}),
				expect.objectContaining({
					source: "github",
					status: "blocked",
					owner: "codex/customer-board",
					nextAction: {
						label: "Review pull request",
						command: "https://github.com/evalops/maestro/pull/123",
					},
				}),
				expect.objectContaining({
					source: "handoff",
					status: "blocked",
					title: "Customer board handoff",
				}),
				expect.objectContaining({
					source: "a2a",
					status: "waiting",
					owner: "Review Agent",
				}),
			]),
		);
		const markdown = formatCustomerValueMarkdown(report);
		expect(markdown).toContain("## Agent Work Board");
		expect(markdown).toContain("Capture durable customer report board");
		expect(markdown).toContain("Review pull request");
	});

	it("drops malformed mission manifests before building the customer board", async () => {
		writeSessionFixture(sessionDir, {
			sessionId: "session-bad-mission",
			title: "Malformed mission artifact",
		});
		writeFileSync(
			join(tempDir, "features.json"),
			JSON.stringify(
				{
					version: 1,
					missionId: "bad-mission",
					milestones: [],
					createdAt: "2026-06-18T08:00:00.000Z",
					updatedAt: "2026-06-18T09:00:00.000Z",
					features: [null],
				},
				null,
				2,
			),
		);

		const nullFeatureReport = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir: tempDir,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(
			nullFeatureReport.agentWorkBoard.items.filter(
				(item) => item.source === "mission",
			),
		).toHaveLength(0);

		writeFileSync(
			join(tempDir, "features.json"),
			JSON.stringify(
				{
					version: 1,
					missionId: "bad-handoff",
					milestones: [],
					createdAt: "2026-06-18T08:00:00.000Z",
					updatedAt: "2026-06-18T09:00:00.000Z",
					features: [
						{
							id: "feature-bad-handoff",
							description: "Bad handoff should be ignored",
							status: "in-progress",
							fulfills: ["customer.report.board"],
							handoff: {
								workerId: "worker-1",
								success: false,
								handedOffAt: "2026-06-18T09:00:00.000Z",
								discoveredIssues: "not-an-array",
							},
						},
					],
				},
				null,
				2,
			),
		);

		const badHandoffReport = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir: tempDir,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(
			badHandoffReport.agentWorkBoard.items.filter(
				(item) => item.source === "mission",
			),
		).toHaveLength(0);
	});

	it("scopes durable mission snapshots to the workspace mission manifest", async () => {
		const missionStoreDir = join(tempDir, "global-missions");
		writeFileSync(
			join(tempDir, "features.json"),
			JSON.stringify(
				{
					version: 1,
					missionId: "Customer Report Board",
					milestones: [],
					createdAt: "2026-06-18T08:00:00.000Z",
					updatedAt: "2026-06-18T09:00:00.000Z",
					features: [
						{
							id: "feature-board",
							description: "Workspace manifest feature",
							status: "in-progress",
							fulfills: ["customer.report.board"],
						},
					],
				},
				null,
				2,
			),
		);
		const localMission = MissionStore.create({
			missionId: "Customer Report Board",
			config: { rootDir: missionStoreDir },
		});
		localMission.setFeatures([
			{
				id: "durable-local",
				description: "Durable local mission feature",
				status: "in-progress",
				fulfills: [],
			},
		]);
		const unrelatedMission = MissionStore.create({
			missionId: "unrelated-workspace",
			config: { rootDir: missionStoreDir },
		});
		unrelatedMission.setFeatures([
			{
				id: "unrelated-feature",
				description: "Unrelated global mission feature",
				status: "in-progress",
				fulfills: [],
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir: tempDir,
			env: createRuntimeEnv({
				...process.env,
				MAESTRO_MISSION_STORE_DIR: missionStoreDir,
			}),
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		const missionTitles = report.agentWorkBoard.items
			.filter((item) => item.source === "mission")
			.map((item) => item.title);
		expect(missionTitles).toContain("Durable local mission feature");
		expect(missionTitles).not.toContain("Unrelated global mission feature");
	});

	it("matches durable mission snapshots to raw workspace mission ids", async () => {
		const missionStoreDir = join(tempDir, "global-missions");
		writeFileSync(
			join(tempDir, "features.json"),
			JSON.stringify(
				{
					version: 1,
					missionId: "customer report board",
					milestones: [],
					createdAt: "2026-06-18T08:00:00.000Z",
					updatedAt: "2026-06-18T09:00:00.000Z",
					features: [
						{
							id: "feature-board",
							description: "Capture durable customer report board",
							status: "in-progress",
							fulfills: ["customer.report.board"],
						},
					],
				},
				null,
				2,
			),
		);
		const localMission = MissionStore.create({
			missionId: "customer report board",
			config: { rootDir: missionStoreDir },
		});
		localMission.setFeatures([
			{
				id: "durable-local",
				description: "Durable local mission feature",
				status: "in-progress",
				fulfills: [],
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir: tempDir,
			env: createRuntimeEnv({
				...process.env,
				MAESTRO_MISSION_STORE_DIR: missionStoreDir,
			}),
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		const missionTitles = report.agentWorkBoard.items
			.filter((item) => item.source === "mission")
			.map((item) => item.title);
		expect(missionTitles).toContain("Durable local mission feature");
	});

	it("does not match same-id durable mission snapshots outside the workspace", async () => {
		const workspaceDir = join(tempDir, "workspace");
		const missionStoreDir = join(tempDir, "global-missions");
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(
			join(workspaceDir, "features.json"),
			JSON.stringify(
				{
					version: 1,
					missionId: "launch",
					milestones: [],
					createdAt: "2026-06-18T08:00:00.000Z",
					updatedAt: "2026-06-18T09:00:00.000Z",
					features: [
						{
							id: "workspace-feature",
							description: "Workspace launch feature",
							status: "in-progress",
							fulfills: ["customer.launch"],
						},
					],
				},
				null,
				2,
			),
		);
		MissionStore.create({
			missionId: "launch",
			config: { rootDir: missionStoreDir },
		}).setFeatures([
			{
				id: "global-feature",
				description: "Global launch durable feature",
				status: "in-progress",
				fulfills: [],
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir,
			env: createRuntimeEnv({
				...process.env,
				MAESTRO_MISSION_STORE_DIR: missionStoreDir,
			}),
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		const missionTitles = report.agentWorkBoard.items
			.filter((item) => item.source === "mission")
			.map((item) => item.title);
		expect(missionTitles).toContain("Workspace launch feature");
		expect(missionTitles).not.toContain("Global launch durable feature");
	});

	it("matches same-id durable mission snapshots from the default store", async () => {
		const workspaceDir = join(tempDir, "workspace");
		process.env.HOME = join(tempDir, "home");
		restoreEnv("MAESTRO_MISSION_STORE_DIR", undefined);
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(
			join(workspaceDir, "features.json"),
			JSON.stringify(
				{
					version: 1,
					missionId: "launch",
					milestones: [],
					createdAt: "2026-06-18T08:00:00.000Z",
					updatedAt: "2026-06-18T09:00:00.000Z",
					features: [
						{
							id: "workspace-feature",
							description: "Workspace launch feature",
							status: "in-progress",
							fulfills: ["customer.launch"],
						},
					],
				},
				null,
				2,
			),
		);
		resetDefaultRuntimeEnvForTests();
		try {
			MissionStore.create({
				missionId: "launch",
			}).setFeatures([
				{
					id: "default-store-feature",
					description: "Default-store durable feature",
					status: "in-progress",
					fulfills: [],
				},
			]);

			const report = await buildCustomerValueReport({
				period: "all",
				sessionDir,
				telemetryPath,
				workspaceDir,
				now: Date.parse("2026-06-18T12:00:00.000Z"),
			});

			const missionTitles = report.agentWorkBoard.items
				.filter((item) => item.source === "mission")
				.map((item) => item.title);
			expect(missionTitles).not.toContain("Workspace launch feature");
			expect(missionTitles).toContain("Default-store durable feature");
		} finally {
			resetDefaultRuntimeEnvForTests();
		}
	});

	it("includes durable-only mission snapshots when no legacy manifest exists", async () => {
		const missionStoreDir = join(tempDir, "durable-only-missions");
		MissionStore.create({
			missionId: "durable-only",
			config: { rootDir: missionStoreDir },
		}).setFeatures([
			{
				id: "feature-durable-only",
				description: "Durable-only customer mission",
				status: "in-progress",
				fulfills: [],
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir: tempDir,
			env: createRuntimeEnv({
				...process.env,
				MAESTRO_MISSION_STORE_DIR: missionStoreDir,
			}),
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.agentWorkBoard.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "mission-store:durable-only:feature-durable-only",
					title: "Durable-only customer mission",
				}),
			]),
		);
	});

	it("does not include global durable-only mission snapshots for unrelated workspaces", async () => {
		const workspaceDir = join(tempDir, "workspace-without-missions");
		const missionStoreDir = join(tempDir, "global-mission-store");
		mkdirSync(workspaceDir, { recursive: true });
		MissionStore.create({
			missionId: "other-workspace",
			config: { rootDir: missionStoreDir },
		}).setFeatures([
			{
				id: "feature-other",
				description: "Other workspace feature",
				status: "in-progress",
				fulfills: [],
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir,
			env: createRuntimeEnv({
				...process.env,
				MAESTRO_MISSION_STORE_DIR: missionStoreDir,
			}),
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(
			report.agentWorkBoard.items.some((item) =>
				item.id.startsWith("mission-store:other-workspace:"),
			),
		).toBe(false);
	});

	it("publishes mission, todo, and GitHub projections in the agent work board", async () => {
		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
			missionManifests: [
				{
					version: 1,
					missionId: "mission-1",
					createdAt: "2026-06-18T10:00:00.000Z",
					updatedAt: "2026-06-18T10:10:00.000Z",
					milestones: [],
					features: [
						{
							id: "feature-1",
							description: "Ship resilient agent dispatch",
							status: "in-progress",
							fulfills: ["agent.dispatch"],
						},
					],
				},
			],
			todoStore: {
				"release-readiness": {
					goal: "Release readiness",
					updatedAt: "2026-06-18T10:15:00.000Z",
					items: [
						{
							id: "todo-1",
							content: "Attach release evidence",
							status: "pending",
							priority: "high",
						},
					],
				},
			},
			githubTasks: [
				{
					id: "agent-pr-1",
					title: "Review agentic coding PR",
					status: "running",
					branch: "codex/agentic",
					prUrl: "https://github.com/evalops/maestro-internal/pull/1",
				},
			],
		});

		expect(report.handoffs.openWorkCount).toBe(1);
		expect(report.agentWorkBoard.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "mission:mission-1:feature-1",
					source: "mission",
					status: "running",
				}),
				expect.objectContaining({
					id: "todo:Release readiness:todo-1",
					source: "todo",
					priority: "high",
				}),
				expect.objectContaining({
					id: "github:agent-pr-1",
					source: "github",
					nextAction: expect.objectContaining({
						command: "https://github.com/evalops/maestro-internal/pull/1",
					}),
				}),
			]),
		);
		expect(
			report.agentWorkBoard.items.some((item) =>
				item.id.startsWith("open-work:Release readiness:todo-1"),
			),
		).toBe(false);
	});

	it("scopes durable mission snapshots to the current workspace manifest", async () => {
		const missionStoreDir = join(tempDir, "mission-store");
		process.env.MAESTRO_MISSION_STORE_DIR = missionStoreDir;
		writeFileSync(
			join(tempDir, "features.json"),
			JSON.stringify(
				{
					version: 1,
					missionId: "workspace-mission",
					milestones: [],
					createdAt: "2026-06-18T08:00:00.000Z",
					updatedAt: "2026-06-18T09:00:00.000Z",
					features: [
						{
							id: "workspace-feature",
							description: "Workspace manifest feature",
							status: "pending",
							fulfills: ["customer.report.board"],
						},
					],
				},
				null,
				2,
			),
		);
		MissionStore.create({
			missionId: "workspace-mission",
			config: { rootDir: missionStoreDir },
		}).setFeatures([
			{
				id: "durable-feature",
				description: "Workspace durable feature",
				status: "in-progress",
				fulfills: ["customer.report.board"],
			},
		]);
		MissionStore.create({
			missionId: "other-workspace",
			config: { rootDir: missionStoreDir },
		}).setFeatures([
			{
				id: "other-feature",
				description: "Other workspace durable feature",
				status: "in-progress",
				fulfills: ["customer.report.board"],
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			workspaceDir: tempDir,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(
			report.agentWorkBoard.items.some((item) =>
				item.id.startsWith("mission-store:workspace-mission:"),
			),
		).toBe(true);
		expect(
			report.agentWorkBoard.items.some((item) =>
				item.id.startsWith("mission-store:other-workspace:"),
			),
		).toBe(false);
	});

	it("keeps valid open todo work when the todo store contains malformed entries", async () => {
		writeSessionFixture(sessionDir, {
			sessionId: "session-handoff-malformed",
			title: "Malformed todo handoff",
			subject: "Keep valid todo work visible",
		});
		writeFileSync(
			process.env.MAESTRO_TODO_FILE!,
			JSON.stringify(
				{
					"broken-goal": {
						goal: "Broken goal",
						updatedAt: "2026-06-18T11:00:00.000Z",
					},
					"mixed-items": {
						goal: "Ship checkout recovery",
						updatedAt: "2026-06-18T11:00:00.000Z",
						items: [
							{
								id: "qa",
								content: "Run hosted checkout QA",
								status: "in_progress",
								priority: "high",
							},
							{
								id: "broken-item",
								status: "pending",
								priority: "high",
							},
							{
								id: "notes",
								content: "Publish customer notes",
								status: "pending",
								priority: "medium",
							},
						],
					},
				},
				null,
				2,
			),
		);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.handoffs.openWorkCount).toBe(2);
		expect(report.handoffs.openWork.map((item) => item.id)).toEqual([
			"qa",
			"notes",
		]);
	});

	it("keeps multi-agent rollups aligned with cockpit status normalization", async () => {
		writeSessionFixture(sessionDir);
		writeFileSync(
			process.env.MAESTRO_A2A_TASKS_FILE!,
			`${JSON.stringify(
				{
					tasks: [
						{
							id: "a2a-task-succeeded",
							kind: "delegation",
							peer: "mac-mini",
							taskId: "task-succeeded",
							text: "Run the smoke suite",
							state: "SUCCEEDED",
							responseText: "Smoke suite passed.",
							workGraph: {
								state: "completed",
								itemCount: 1,
								activeItemCount: 0,
								blockedItemCount: 0,
								waitingItemCount: 0,
								childRunCount: 0,
								childRunIds: [],
								toolCallCount: 0,
								pendingToolCallCount: 0,
								toolExecutionIds: [],
								waitItemCount: 0,
								waitIds: [],
							},
							transcript: [
								{
									at: "2026-06-18T10:00:00.000Z",
									role: "user",
									text: "Run the smoke suite",
								},
								{
									at: "2026-06-18T10:05:00.000Z",
									role: "agent",
									text: "Smoke suite passed.",
									state: "SUCCEEDED",
								},
							],
							createdAt: "2026-06-18T10:00:00.000Z",
							updatedAt: "2026-06-18T10:05:00.000Z",
							completedAt: "2026-06-18T10:05:00.000Z",
						},
						{
							id: "a2a-task-input-required",
							kind: "delegation",
							peer: "review-agent",
							taskId: "task-input",
							text: "Need release risk review",
							state: "INPUT-REQUIRED",
							transcript: [
								{
									at: "2026-06-18T10:10:00.000Z",
									role: "user",
									text: "Need release risk review",
								},
							],
							createdAt: "2026-06-18T10:10:00.000Z",
							updatedAt: "2026-06-18T10:12:00.000Z",
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.multiAgent).toMatchObject({
			completedTaskCount: 1,
			actionRequiredTaskCount: 1,
			pendingTaskCount: 1,
			realizedHoursSaved: 0.35,
		});
		expect(report.multiAgent.nextActions.map((action) => action.id)).toEqual([
			"reply:review-agent:task-input",
		]);
		expect(report.multiAgent.recentTasks[0]).toMatchObject({
			peer: "review-agent",
			status: "waiting",
		});
		expect(report.multiAgent.recentTasks[1]).toMatchObject({
			peer: "mac-mini",
			status: "completed",
		});
	});

	it("does not mark policy audit controls available from unrelated telemetry", async () => {
		writeSessionFixture(sessionDir);
		writeFileSync(
			telemetryPath,
			[
				JSON.stringify({
					type: "loader-stage",
					timestamp: "2026-06-18T10:00:00.000Z",
				}),
				JSON.stringify({
					type: "tool-execution",
					timestamp: "2026-06-18T10:01:00.000Z",
					success: true,
				}),
			].join("\n"),
		);

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.telemetry.parsedEventCount).toBe(2);
		expect(report.telemetry.policyApprovalAuditEvents).toBe(0);
		expect(report.admin.controls).toContainEqual(
			expect.objectContaining({
				id: "policy-and-approval-audit",
				status: "gap",
			}),
		);
		expect(report.collectionGaps).toContain(
			"Telemetry log has parsed events but no canonical-turn, policy, or approval audit events.",
		);
	});

	it("does not treat missing open todo work as a collection gap", async () => {
		writeSessionFixture(sessionDir);
		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});

		expect(report.handoffs.openWorkCount).toBe(0);
		expect(report.collectionGaps).not.toContain(
			"No open work items were available from the persisted todo store.",
		);
	});

	it("surfaces A2A ledger read failures in the multi-agent section", async () => {
		writeSessionFixture(sessionDir);
		writeFileSync(process.env.MAESTRO_A2A_TASKS_FILE!, "{not-json\n");

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});

		const text = formatCustomerValueReport(report);
		const markdown = formatCustomerValueMarkdown(report);

		expect(report.multiAgent.taskCount).toBe(0);
		expect(report.multiAgent.collectionGaps).toEqual([
			expect.stringContaining("A2A task ledger could not be read:"),
		]);
		expect(report.admin.controls).toContainEqual(
			expect.objectContaining({
				id: "multi-agent-delegation-ledger",
				status: "gap",
				evidence: expect.stringContaining("A2A task ledger could not be read:"),
			}),
		);
		expect(text).toContain("A2A task ledger could not be read:");
		expect(markdown).toContain("- A2A task ledger could not be read:");
		expect(text).not.toContain("No A2A delegated tasks found for this range.");
		expect(markdown).not.toContain(
			"- No A2A delegated tasks found for this range.",
		);
	});

	it("renders text and markdown without leaking raw secrets", async () => {
		const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890SECRET";
		writeSessionFixture(sessionDir, {
			userText: `Fix deploy with token ${secret}`,
			subject: `Deploy token ${secret}`,
			title: `Release token ${secret}`,
		});
		writeSecretA2ATasksFixture(process.env.MAESTRO_A2A_TASKS_FILE!, secret);
		writeFileSync(
			process.env.MAESTRO_TODO_FILE!,
			JSON.stringify(
				{
					"deploy-followup": {
						goal: `Ship release for ${secret}`,
						updatedAt: "2026-06-18T11:00:00.000Z",
						items: [
							{
								id: "todo-secret",
								content: `Rotate leaked token ${secret}`,
								status: "in_progress",
								priority: "high",
								blockedBy: [`approval for ${secret}`],
							},
						],
					},
				},
				null,
				2,
			),
		);
		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});

		const text = formatCustomerValueReport(report);
		const markdown = formatCustomerValueMarkdown(report);

		expect(text).toContain("Customer Value Report");
		expect(markdown).toContain("# Customer Value Report");
		expect(text).toContain("Multi-Agent Coordination");
		expect(markdown).toContain("## Multi-Agent Coordination");
		expect(report.trustCards[0]?.title).not.toContain(secret);
		expect(report.handoffs.openWork[0]?.goal).not.toContain(secret);
		expect(report.handoffs.openWork[0]?.content).not.toContain(secret);
		expect(report.handoffs.openWork[0]?.blockers[0]).not.toContain(secret);
		expect(text).not.toContain(secret);
		expect(markdown).not.toContain(secret);
		expect(JSON.stringify(report)).not.toContain(secret);
	});

	it("normalizes A2A states and does not recommend work for terminal evidence", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "completed-only",
				peer: "mac-mini",
				taskId: "task-done",
				state: "TASK_STATE_COMPLETED",
				responseText: "Done with evidence.",
				workGraph: {
					state: "completed",
					childRunIds: ["run-complete"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{
						at: "2026-06-18T10:00:00.000Z",
						role: "user",
						text: "Run completed work",
					},
					{
						at: "2026-06-18T10:05:00.000Z",
						role: "agent",
						text: "Done with evidence.",
					},
				],
				createdAt: "2026-06-18T10:00:00.000Z",
				updatedAt: "2026-06-18T10:05:00.000Z",
				completedAt: "2026-06-18T10:05:00.000Z",
			},
			{
				id: "dashed-waiting",
				peer: "review-agent",
				taskId: "task-wait",
				state: "input-required",
				text: "Needs a decision",
				transcript: [
					{
						at: "2026-06-18T10:10:00.000Z",
						role: "user",
						text: "Needs a decision",
					},
				],
				createdAt: "2026-06-18T10:10:00.000Z",
				updatedAt: "2026-06-18T10:12:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});

		expect(report.multiAgent.actionRequiredTaskCount).toBe(1);
		expect(report.multiAgent.recentTasks[0]).toMatchObject({
			peer: "review-agent",
			state: "input-required",
			status: "waiting",
		});
		expect(report.multiAgent.nextActions).toEqual([
			expect.objectContaining({
				id: "reply:review-agent:task-wait",
				command:
					"maestro a2a reply review-agent task-wait 'RESPONSE_TEXT' --wait --work-graph",
			}),
		]);

		for (const state of ["TASK_STATE_COMPLETED", "SUCCEEDED", "SUCCESS"]) {
			writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
				{
					id: `terminal-${state}`,
					peer: "mac-mini",
					taskId: `task-${state.toLowerCase()}`,
					state,
					responseText: "Done with evidence.",
					workGraph: {
						state: "completed",
						childRunIds: [`run-${state.toLowerCase()}`],
						toolExecutionIds: [],
						waitIds: [],
					},
					transcript: [
						{
							at: "2026-06-18T10:00:00.000Z",
							role: "user",
							text: "Run completed work",
						},
						{
							at: "2026-06-18T10:05:00.000Z",
							role: "agent",
							text: "Done with evidence.",
						},
					],
					createdAt: "2026-06-18T10:00:00.000Z",
					updatedAt: "2026-06-18T10:05:00.000Z",
					completedAt: "2026-06-18T10:05:00.000Z",
				},
			]);
			const terminalOnly = await buildCustomerValueReport({
				period: "all",
				sessionDir,
				telemetryPath,
			});

			expect(terminalOnly.multiAgent.completedTaskCount).toBe(1);
			expect(terminalOnly.multiAgent.nextActions).toEqual([]);
			expect(formatCustomerValueReport(terminalOnly)).toContain(
				"No action required; completed delegated work is ready for audit.",
			);
		}

		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "non-terminal-unsuccessful",
				peer: "review-agent",
				taskId: "task-unsuccessful",
				state: "UNSUCCESSFUL",
				text: "Still needs follow-up",
				transcript: [
					{
						at: "2026-06-18T10:20:00.000Z",
						role: "user",
						text: "Still needs follow-up",
					},
				],
				createdAt: "2026-06-18T10:20:00.000Z",
				updatedAt: "2026-06-18T10:21:00.000Z",
			},
		]);
		const unsuccessful = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});

		expect(unsuccessful.multiAgent.completedTaskCount).toBe(0);
		expect(unsuccessful.multiAgent.pendingTaskCount).toBe(1);
		expect(unsuccessful.multiAgent.recentTasks[0]).toMatchObject({
			peer: "review-agent",
			state: "UNSUCCESSFUL",
			status: "running",
		});
		expect(unsuccessful.multiAgent.nextActions).toEqual([
			expect.objectContaining({
				id: "wait:review-agent:task-unsuccessful",
				command: "maestro a2a wait review-agent task-unsuccessful --work-graph",
			}),
		]);
	});

	it("keeps failed delegated work visible across bounded report windows", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "old-failed-delegation",
				peer: "review-agent",
				taskId: "task-failed",
				state: "TASK_STATE_FAILED",
				text: "Review failed and needs refresh",
				transcript: [
					{
						at: "2026-06-17T10:00:00.000Z",
						role: "user",
						text: "Review release risk",
					},
					{
						at: "2026-06-17T10:05:00.000Z",
						role: "agent",
						text: "Review failed and needs refresh",
					},
				],
				createdAt: "2026-06-17T10:00:00.000Z",
				updatedAt: "2026-06-17T10:05:00.000Z",
				completedAt: "2026-06-17T10:05:00.000Z",
			},
			{
				id: "old-completed-delegation",
				peer: "mac-mini",
				taskId: "task-done-yesterday",
				state: "TASK_STATE_COMPLETED",
				responseText: "Done yesterday.",
				workGraph: {
					state: "completed",
					childRunIds: ["run-yesterday"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{
						at: "2026-06-17T10:10:00.000Z",
						role: "user",
						text: "Run yesterday's smoke suite",
					},
					{
						at: "2026-06-17T10:15:00.000Z",
						role: "agent",
						text: "Done yesterday.",
					},
				],
				createdAt: "2026-06-17T10:10:00.000Z",
				updatedAt: "2026-06-17T10:15:00.000Z",
				completedAt: "2026-06-17T10:15:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.multiAgent).toMatchObject({
			taskCount: 1,
			failedTaskCount: 1,
			delegatedFailedTaskCount: 1,
			completedTaskCount: 0,
		});
		expect(report.multiAgent.recentTasks).toEqual([
			expect.objectContaining({
				id: "task-failed",
				peer: "review-agent",
				status: "failed",
			}),
		]);
		expect(report.multiAgent.nextActions).toEqual([
			expect.objectContaining({
				id: "refresh:review-agent:task-failed",
				command: "maestro a2a tasks review-agent --refresh --work-graph",
			}),
		]);
		expect(formatCustomerValueReport(report)).toContain(
			"Decision: Refresh failed review-agent task task-failed (maestro a2a tasks review-agent --refresh --work-graph)",
		);
	});

	it("keeps completed delegated work out of audit-ready when evidence is missing", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "completed-missing-evidence",
				peer: "mac-mini",
				taskId: "task-gap",
				state: "TASK_STATE_COMPLETED",
				transcript: [
					{
						at: "2026-06-18T10:10:00.000Z",
						role: "user",
						text: "Run completed work",
					},
				],
				createdAt: "2026-06-18T10:10:00.000Z",
				updatedAt: "2026-06-18T10:12:00.000Z",
				completedAt: "2026-06-18T10:12:00.000Z",
			},
			{
				id: "message-only-audit-ready",
				kind: "message",
				peer: "review-agent",
				taskId: "task-message",
				state: "TASK_STATE_COMPLETED",
				responseText: "Shared the audit evidence.",
				workGraph: {
					state: "completed",
					childRunIds: ["run-message"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{
						at: "2026-06-18T10:13:00.000Z",
						role: "user",
						text: "Share the audit evidence",
					},
					{
						at: "2026-06-18T10:14:00.000Z",
						role: "agent",
						text: "Shared the audit evidence.",
					},
				],
				createdAt: "2026-06-18T10:13:00.000Z",
				updatedAt: "2026-06-18T10:14:00.000Z",
				completedAt: "2026-06-18T10:14:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});
		const text = formatCustomerValueReport(report);

		expect(report.multiAgent.completedTaskCount).toBe(2);
		expect(report.multiAgent.pendingTaskCount).toBe(0);
		expect(report.multiAgent.auditReadyTaskCount).toBe(0);
		expect(report.multiAgent.evidenceGapCount).toBeGreaterThan(0);
		expect(report.multiAgent.realizedHoursSaved).toBe(0);
		expect(report.summary.multiAgentEstimatedHoursSaved).toBe(0);
		expect(report.multiAgent.delegatedEvidenceGapCount).toBeGreaterThan(0);
		expect(report.multiAgent.nextActions).toEqual([]);
		expect(text).toContain(
			"Completed delegated work is missing audit evidence; collect work graphs, responses, or transcripts before claiming value.",
		);
		expect(text).not.toContain(
			"No action required; completed delegated work is ready for audit.",
		);
	});

	it("does not claim delegated value from non-delegation ledger rows", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "message-only",
				kind: "message",
				peer: "review-agent",
				taskId: "message-task",
				state: "COMPLETED",
				responseText: "Message acknowledged with evidence.",
				workGraph: {
					state: "completed",
					childRunIds: ["message-run"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{
						at: "2026-06-18T10:00:00.000Z",
						role: "user",
						text: "Send status message",
					},
					{
						at: "2026-06-18T10:05:00.000Z",
						role: "agent",
						text: "Message acknowledged with evidence.",
					},
				],
				createdAt: "2026-06-18T10:00:00.000Z",
				updatedAt: "2026-06-18T10:05:00.000Z",
				completedAt: "2026-06-18T10:05:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});
		const coordinateWorkflow = report.workflows.find(
			(workflow) => workflow.id === "coordinate-agent-swarm",
		);

		expect(report.multiAgent).toMatchObject({
			taskCount: 1,
			delegatedTaskCount: 0,
			completedTaskCount: 1,
			auditReadyTaskCount: 0,
			realizedHoursSaved: 0,
		});
		expect(formatCustomerValueReport(report)).toContain(
			"No completed delegated work found; delegate and complete A2A work before claiming realized multi-agent value.",
		);
		expect(coordinateWorkflow?.evidenceSignal).toContain(
			"1 A2A ledger row(s) observed, but no delegated tasks",
		);
		expect(report.admin.controls).toContainEqual(
			expect.objectContaining({
				id: "multi-agent-delegation-ledger",
				status: "gap",
				evidence: expect.stringContaining(
					"0 A2A delegated task(s) and 1 total A2A ledger row(s)",
				),
			}),
		);
	});

	it("does not let message rows drive delegated decisions or next actions", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "message-waiting",
				kind: "message",
				peer: "review-agent",
				taskId: "message-task",
				state: "TASK_STATE_INPUT_REQUIRED",
				transcript: [
					{
						at: "2026-06-18T10:00:00.000Z",
						role: "user",
						text: "Send status message",
					},
				],
				createdAt: "2026-06-18T10:00:00.000Z",
				updatedAt: "2026-06-18T10:05:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});
		const text = formatCustomerValueReport(report);
		const markdown = formatCustomerValueMarkdown(report);

		expect(report.multiAgent).toMatchObject({
			taskCount: 1,
			delegatedTaskCount: 0,
			actionRequiredTaskCount: 1,
			pendingTaskCount: 1,
			delegatedPendingTaskCount: 0,
			delegatedEvidenceGapCount: 0,
			realizedHoursSaved: 0,
			nextActions: [],
		});
		expect(text).toContain(
			"No completed delegated work found; delegate and complete A2A work before claiming realized multi-agent value.",
		);
		expect(text).toContain(
			"Pending work: 0 task(s), 0 evidence gap(s), 0 audit-ready task(s)",
		);
		expect(markdown).toContain("- Pending work: 0 task(s)");
		expect(markdown).toContain("- Evidence gaps: 0");
		expect(text).not.toContain("Reply to review-agent task message-task");
		expect(text).not.toContain(
			"Completed delegated work is missing audit evidence",
		);
	});

	it("ignores message-only evidence gaps when no delegated work completed", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "message-gap-only",
				kind: "message",
				peer: "review-agent",
				taskId: "message-gap-task",
				state: "COMPLETED",
				responseText: "Message acknowledged with partial evidence.",
				transcript: [
					{
						at: "2026-06-18T10:00:00.000Z",
						role: "user",
						text: "Send status message",
					},
					{
						at: "2026-06-18T10:05:00.000Z",
						role: "agent",
						text: "Message acknowledged with partial evidence.",
					},
				],
				createdAt: "2026-06-18T10:00:00.000Z",
				updatedAt: "2026-06-18T10:05:00.000Z",
				completedAt: "2026-06-18T10:05:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});
		const text = formatCustomerValueReport(report);
		const markdown = formatCustomerValueMarkdown(report);

		expect(report.multiAgent).toMatchObject({
			taskCount: 1,
			delegatedTaskCount: 0,
			completedTaskCount: 1,
			auditReadyTaskCount: 0,
			evidenceGapCount: 1,
			realizedHoursSaved: 0,
		});
		expect(text).toContain(
			"No completed delegated work found; delegate and complete A2A work before claiming realized multi-agent value.",
		);
		expect(text).toContain(
			"Pending work: 0 task(s), 0 evidence gap(s), 0 audit-ready task(s)",
		);
		expect(markdown).toContain("- Evidence gaps: 0");
		expect(text).not.toContain(
			"Completed delegated work is missing audit evidence; collect work graphs, responses, or transcripts before claiming value.",
		);
	});

	it("ignores message-only evidence gaps once delegated work is audit-ready", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "delegated-audit-ready",
				peer: "build-agent",
				taskId: "delegated-ready-task",
				state: "COMPLETED",
				responseText: "Delegated work completed.",
				workGraph: {
					state: "completed",
					childRunIds: ["delegated-ready-run"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{
						at: "2026-06-18T10:00:00.000Z",
						role: "user",
						text: "Run delegated work",
					},
					{
						at: "2026-06-18T10:05:00.000Z",
						role: "agent",
						text: "Delegated work completed.",
					},
				],
				createdAt: "2026-06-18T10:00:00.000Z",
				updatedAt: "2026-06-18T10:05:00.000Z",
				completedAt: "2026-06-18T10:05:00.000Z",
			},
			{
				id: "message-gap-companion",
				kind: "message",
				peer: "review-agent",
				taskId: "message-gap-task",
				state: "COMPLETED",
				responseText: "Message acknowledged with partial evidence.",
				transcript: [
					{
						at: "2026-06-18T10:06:00.000Z",
						role: "user",
						text: "Send status message",
					},
					{
						at: "2026-06-18T10:07:00.000Z",
						role: "agent",
						text: "Message acknowledged with partial evidence.",
					},
				],
				createdAt: "2026-06-18T10:06:00.000Z",
				updatedAt: "2026-06-18T10:07:00.000Z",
				completedAt: "2026-06-18T10:07:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});
		const text = formatCustomerValueReport(report);

		expect(report.multiAgent).toMatchObject({
			taskCount: 2,
			delegatedTaskCount: 1,
			auditReadyTaskCount: 1,
			evidenceGapCount: 1,
			realizedHoursSaved: 0.35,
		});
		expect(text).toContain(
			"No action required; completed delegated work is ready for audit.",
		);
		expect(text).not.toContain(
			"Some delegated work is audit-ready, but evidence gaps remain to close.",
		);
	});

	it("requires both transcript roles before claiming delegated value", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "one-sided-transcript",
				peer: "review-agent",
				taskId: "task-one-sided",
				state: "COMPLETED",
				responseText: "Work completed.",
				workGraph: {
					state: "completed",
					childRunIds: ["one-sided-run"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{
						at: "2026-06-18T10:00:00.000Z",
						role: "user",
						text: "Run delegated work",
					},
					{
						at: "2026-06-18T10:01:00.000Z",
						role: "user",
						text: "Use the smaller smoke suite",
					},
				],
				createdAt: "2026-06-18T10:00:00.000Z",
				updatedAt: "2026-06-18T10:05:00.000Z",
				completedAt: "2026-06-18T10:05:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});

		expect(report.multiAgent.completedTaskCount).toBe(1);
		expect(report.multiAgent.auditReadyTaskCount).toBe(0);
		expect(report.multiAgent.evidenceGapCount).toBe(1);
		expect(report.multiAgent.realizedHoursSaved).toBe(0);
	});

	it("keeps open delegated tasks visible across bounded reporting windows", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "old-open-task",
				peer: "review-agent",
				taskId: "task-open",
				state: "TASK_STATE_INPUT_REQUIRED",
				transcript: [
					{
						at: "2026-06-17T08:00:00.000Z",
						role: "user",
						text: "Review yesterday's branch",
					},
				],
				createdAt: "2026-06-17T08:00:00.000Z",
				updatedAt: "2026-06-17T08:05:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "today",
			now: Date.parse("2026-06-18T12:00:00.000Z"),
			sessionDir,
			telemetryPath,
		});

		expect(report.multiAgent.taskCount).toBe(1);
		expect(report.multiAgent.pendingTaskCount).toBe(1);
		expect(report.multiAgent.nextActions[0]).toMatchObject({
			command:
				"maestro a2a reply review-agent task-open 'RESPONSE_TEXT' --wait --work-graph",
		});
		expect(report.multiAgent.nextActions[0]?.command).not.toContain("<");
	});

	it("fills peer display names from later ledger rows", async () => {
		writeSessionFixture(sessionDir);
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "peer-first",
				peer: "mac-mini",
				taskId: "task-first",
				state: "TASK_STATE_COMPLETED",
				responseText: "Done.",
				workGraph: {
					state: "completed",
					childRunIds: ["run-first"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{ at: "2026-06-18T10:00:00.000Z", role: "user", text: "Go" },
					{ at: "2026-06-18T10:01:00.000Z", role: "agent", text: "Done." },
				],
				createdAt: "2026-06-18T10:00:00.000Z",
				updatedAt: "2026-06-18T10:01:00.000Z",
				completedAt: "2026-06-18T10:01:00.000Z",
			},
			{
				id: "peer-second",
				peer: "mac-mini",
				peerDisplayName: "Mac Mini",
				taskId: "task-second",
				state: "TASK_STATE_COMPLETED",
				responseText: "Done too.",
				workGraph: {
					state: "completed",
					childRunIds: ["run-second"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{ at: "2026-06-18T10:02:00.000Z", role: "user", text: "Again" },
					{
						at: "2026-06-18T10:03:00.000Z",
						role: "agent",
						text: "Done too.",
					},
				],
				createdAt: "2026-06-18T10:02:00.000Z",
				updatedAt: "2026-06-18T10:03:00.000Z",
				completedAt: "2026-06-18T10:03:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});

		expect(report.multiAgent.topPeers[0]).toMatchObject({
			peer: "mac-mini",
			displayName: "Mac Mini",
			taskCount: 2,
		});
	});

	it("includes all matching sessions unless a caller explicitly asks for a limit", async () => {
		for (let index = 0; index < 21; index++) {
			writeSessionFixture(sessionDir, {
				sessionId: `session-value-${index}`,
				subject: `Value session ${index}`,
			});
		}

		const uncapped = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
		});
		const capped = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			sessionLimit: 5,
		});

		expect(uncapped.summary.sessionCount).toBe(21);
		expect(uncapped.trustCards).toHaveLength(21);
		expect(capped.summary.sessionCount).toBe(5);
		expect(capped.trustCards).toHaveLength(5);
	});

	it("filters session activity and telemetry to the selected period", async () => {
		writeSessionFixture(sessionDir, {
			sessionId: "session-old",
			timestamp: "2026-06-01T10:00:00.000Z",
			subject: "Old session",
		});
		writeSessionFixture(sessionDir, {
			sessionId: "session-today",
			timestamp: "2026-06-18T10:00:00.000Z",
			subject: "Today session",
		});
		writeFileSync(
			telemetryPath,
			[
				JSON.stringify({
					type: "tool-execution",
					timestamp: "2026-06-01T10:00:00.000Z",
					success: true,
				}),
				JSON.stringify({
					type: "canonical-turn",
					timestamp: "2026-06-18T10:00:00.000Z",
					turnId: "turn-today",
				}),
			].join("\n"),
		);

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.summary.sessionCount).toBe(1);
		expect(report.trustCards[0]?.sessionId).toBe("session-today");
		expect(report.telemetry.parsedEventCount).toBe(1);
		expect(report.telemetry.toolExecutionEvents).toBe(0);
		expect(report.telemetry.canonicalTurnEvents).toBe(1);
	});

	it("keeps open and refreshed A2A tasks visible in bounded ranges", async () => {
		writeSessionFixture(sessionDir, {
			sessionId: "session-weekly-a2a",
			timestamp: "2026-06-18T10:00:00.000Z",
		});
		writeA2ATaskStateFixture(process.env.MAESTRO_A2A_TASKS_FILE!, [
			{
				id: "open-before-range",
				peer: "review-agent",
				taskId: "open-a2a",
				state: "INPUT_REQUIRED",
				transcript: [
					{
						at: "2026-06-05T10:00:00.000Z",
						role: "user",
						text: "Need a release risk review",
					},
				],
				createdAt: "2026-06-05T10:00:00.000Z",
				updatedAt: "2026-06-05T10:05:00.000Z",
			},
			{
				id: "completed-refreshed-in-range",
				peer: "mac-mini",
				taskId: "done-a2a",
				state: "COMPLETED",
				responseText: "Smoke suite passed.",
				workGraph: {
					state: "completed",
					childRunIds: ["run-refreshed"],
					toolExecutionIds: [],
					waitIds: [],
				},
				transcript: [
					{
						at: "2026-06-05T10:00:00.000Z",
						role: "user",
						text: "Run the smoke suite",
					},
					{
						at: "2026-06-05T10:05:00.000Z",
						role: "agent",
						text: "Smoke suite passed.",
					},
				],
				createdAt: "2026-06-05T10:00:00.000Z",
				updatedAt: "2026-06-15T09:00:00.000Z",
				completedAt: "2026-06-05T10:05:00.000Z",
			},
		]);

		const report = await buildCustomerValueReport({
			period: "week",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.multiAgent).toMatchObject({
			taskCount: 2,
			completedTaskCount: 1,
			pendingTaskCount: 1,
			auditReadyTaskCount: 1,
			realizedHoursSaved: 0.35,
		});
		expect(report.multiAgent.nextActions).toEqual([
			expect.objectContaining({
				id: "reply:review-agent:open-a2a",
				command:
					"maestro a2a reply review-agent open-a2a 'RESPONSE_TEXT' --wait --work-graph",
			}),
		]);
		expect(report.multiAgent.recentTasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "open-a2a" }),
				expect.objectContaining({ id: "done-a2a" }),
			]),
		);
	});

	it("treats yesterday's until boundary consistently for usage and session evidence", async () => {
		const now = Date.parse("2026-06-18T12:00:00.000Z");
		const range = resolveCustomerValueRange("yesterday", now);
		writeSessionFixture(sessionDir, {
			sessionId: "session-yesterday",
			timestamp: new Date(range.until! - 1).toISOString(),
			subject: "Yesterday session",
		});
		vi.spyOn(Date, "now").mockReturnValue(range.until!);
		trackUsage({
			sessionId: "session-yesterday",
			provider: "openai",
			model: "gpt-5.5",
			tokensInput: 200,
			tokensOutput: 100,
			cost: 0.02,
		});

		const report = await buildCustomerValueReport({
			period: "yesterday",
			sessionDir,
			telemetryPath,
			now,
		});

		expect(report.summary.sessionCount).toBe(1);
		expect(report.trustCards[0]?.sessionId).toBe("session-yesterday");
		expect(report.trustCards[0]?.usage.requests).toBe(0);
		expect(report.summary.totalCostUsd).toBe(0);
	});

	it("uses nested message timestamps when legacy entries lack top-level timestamps", async () => {
		writeRawSessionEntries(sessionDir, "session-legacy-nested-timestamps", [
			{
				type: "session",
				version: 2,
				id: "session-legacy-nested-timestamps",
				timestamp: "2026-06-10T09:00:00.000Z",
				cwd: "/workspace/maestro",
				subject: "Legacy nested timestamp session",
			},
			{
				type: "message",
				id: "legacy-user",
				parentId: null,
				message: {
					role: "user",
					content: "Explain customer value today",
					timestamp: Date.parse("2026-06-18T10:00:00.000Z"),
				},
			},
			{
				type: "message",
				id: "legacy-assistant",
				parentId: "legacy-user",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the evidence." },
						{
							type: "toolCall",
							id: "tool-legacy",
							name: "bash",
							arguments: { command: "maestro value" },
						},
					],
					timestamp: Date.parse("2026-06-18T10:01:00.000Z"),
				},
			},
		]);

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.summary.sessionCount).toBe(1);
		expect(report.trustCards[0]).toMatchObject({
			sessionId: "session-legacy-nested-timestamps",
			messageCount: 2,
			toolCallCount: 1,
			task: "Explain customer value today",
		});
	});

	it("scopes trust-card usage to the bounded activity window", async () => {
		const inWindowUsage = Date.parse("2026-06-18T10:01:00.000Z");
		const outsideActivityUsage = Date.parse("2026-06-18T20:00:00.000Z");
		writeSessionFixture(sessionDir, {
			sessionId: "session-activity-usage",
			timestamp: "2026-06-18T10:00:00.000Z",
			subject: "Activity scoped usage",
		});
		writeFileSync(
			process.env.MAESTRO_USAGE_FILE!,
			JSON.stringify([
				{
					timestamp: inWindowUsage,
					sessionId: "session-activity-usage",
					provider: "openai",
					model: "gpt-5.5",
					tokensInput: 100,
					tokensOutput: 50,
					cost: 0.03,
				},
				{
					timestamp: outsideActivityUsage,
					sessionId: "session-activity-usage",
					provider: "openai",
					model: "gpt-5.5",
					tokensInput: 10_000,
					tokensOutput: 5_000,
					cost: 7,
				},
			]),
		);

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.summary.sessionCount).toBe(1);
		expect(report.trustCards[0]?.usage).toEqual({
			requests: 1,
			tokens: 150,
			costUsd: 0.03,
		});
		expect(report.summary.totalCostUsd).toBe(0.03);
	});

	it("scopes trust-card metadata to entries in the selected period", async () => {
		const recentTask = "Investigate today's deploy regression";
		writeRawSessionEntries(sessionDir, "session-mixed-periods", [
			{
				type: "session",
				version: 2,
				id: "session-mixed-periods",
				timestamp: "2026-06-10T09:00:00.000Z",
				cwd: "/workspace/maestro",
				subject: "Legacy outage investigation",
			},
			{
				type: "message",
				id: "user-old",
				parentId: null,
				timestamp: "2026-06-10T09:00:00.000Z",
				message: {
					role: "user",
					content: "Investigate the May outage",
					timestamp: Date.parse("2026-06-10T09:00:00.000Z"),
				},
			},
			{
				type: "session_meta",
				timestamp: "2026-06-10T09:05:00.000Z",
				summary: "Legacy outage summary",
				resumeSummary: "Legacy outage resume summary",
				memoryExtractionHash: "legacy_memory_hash",
				title: "Legacy outage investigation",
			},
			{
				type: "message",
				id: "user-recent",
				parentId: null,
				timestamp: "2026-06-18T10:00:00.000Z",
				message: {
					role: "user",
					content: recentTask,
					timestamp: Date.parse("2026-06-18T10:00:00.000Z"),
				},
			},
			{
				type: "message",
				id: "assistant-recent",
				parentId: "user-recent",
				timestamp: "2026-06-18T10:01:00.000Z",
				message: {
					role: "assistant",
					content: "I will check the deploy logs.",
					timestamp: Date.parse("2026-06-18T10:01:00.000Z"),
				},
			},
		]);

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.summary.sessionCount).toBe(1);
		expect(report.trustCards[0]).toMatchObject({
			sessionId: "session-mixed-periods",
			title: recentTask,
			task: recentTask,
			evidence: {
				hasSummary: false,
				hasMemoryProvenance: false,
			},
		});
		expect(report.trustCards[0]?.summary).toBeUndefined();
		expect(report.trustCards[0]?.evidence.memoryExtractionHash).toBeUndefined();
		expect(report.memory.provenanceCount).toBe(0);
	});

	it("uses an exclusive until boundary consistently for yesterday reports", async () => {
		const now = Date.parse("2026-06-18T12:00:00.000Z");
		const range = resolveCustomerValueRange("yesterday", now);
		writeSessionFixture(sessionDir, {
			sessionId: "session-boundary",
			timestamp: new Date(range.until!).toISOString(),
			subject: "Boundary session",
		});
		writeFileSync(
			process.env.MAESTRO_USAGE_FILE!,
			JSON.stringify([
				{
					timestamp: range.until,
					sessionId: "session-boundary",
					provider: "openai",
					model: "gpt-5.5",
					tokensInput: 100,
					tokensOutput: 50,
					cost: 1,
				},
			]),
		);
		writeFileSync(
			telemetryPath,
			`${JSON.stringify({
				type: "tool-execution",
				timestamp: new Date(range.until!).toISOString(),
				success: true,
			})}\n`,
		);

		const report = await buildCustomerValueReport({
			period: "yesterday",
			sessionDir,
			telemetryPath,
			now,
		});

		expect(report.summary.sessionCount).toBe(0);
		expect(report.summary.totalCostUsd).toBe(0);
		expect(report.telemetry.parsedEventCount).toBe(0);
	});

	it("prints json from the CLI command", async () => {
		writeSessionFixture(sessionDir);
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			output.push(String(message ?? ""));
		});

		await handleValueCommand("all", { format: "json" });

		const exported = JSON.parse(output.join("\n"));
		expect(exported.summary.sessionCount).toBe(1);
		expect(exported.trustCards[0].sessionId).toBe("session-value-1");
	});

	it("writes durable value artifacts with a hash manifest", async () => {
		writeSessionFixture(sessionDir);
		const report = await buildCustomerValueReport({
			period: "week",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});
		const outputDir = join(tempDir, "value-artifacts");

		const artifacts = await writeCustomerValueArtifacts(report, { outputDir });

		expect(existsSync(artifacts.reportJsonPath)).toBe(true);
		expect(existsSync(artifacts.reportMarkdownPath)).toBe(true);
		expect(existsSync(artifacts.manifestPath)).toBe(true);
		const reportJson = readFileSync(artifacts.reportJsonPath, "utf8");
		const markdown = readFileSync(artifacts.reportMarkdownPath, "utf8");
		const manifest = JSON.parse(readFileSync(artifacts.manifestPath, "utf8"));
		expect(manifest).toMatchObject({
			protocolVersion: "maestro.customer-value.manifest.v1",
			generatedAt: "2026-06-18T12:00:00.000Z",
			summary: {
				sessionCount: 1,
			},
			coverage: {
				trustCardCount: 1,
				memoryProvenanceCount: 1,
				multiAgentTaskCount: 0,
				multiAgentWorkGraphTaskCount: 0,
			},
		});
		expect(manifest.sources.sessionPaths).toEqual([
			report.trustCards[0]?.evidence.sessionPath,
		]);
		expect(manifest.hashes.reportJsonSha256).toBe(sha256(reportJson));
		expect(manifest.hashes.reportMarkdownSha256).toBe(sha256(markdown));
		expect(artifacts.manifestSha256).toBe(
			sha256(readFileSync(artifacts.manifestPath, "utf8")),
		);
	});

	it("does not replace durable artifacts from rapid reruns", async () => {
		writeSessionFixture(sessionDir);
		const report = await buildCustomerValueReport({
			period: "week",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.123Z"),
		});
		const outputDir = join(tempDir, "rerun-value-artifacts");

		const first = await writeCustomerValueArtifacts(report, { outputDir });
		const second = await writeCustomerValueArtifacts(report, { outputDir });

		expect(first.reportJsonPath).not.toBe(second.reportJsonPath);
		expect(first.reportJsonPath).toContain("12-00-00-123Z");
		expect(second.reportJsonPath).toContain("12-00-00-123Z-2");
		expect(existsSync(first.reportJsonPath)).toBe(true);
		expect(existsSync(second.reportJsonPath)).toBe(true);
		expect(existsSync(first.manifestPath)).toBe(true);
		expect(existsSync(second.manifestPath)).toBe(true);
	});

	it("prints artifact metadata from the CLI json command when writing", async () => {
		writeSessionFixture(sessionDir);
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			output.push(String(message ?? ""));
		});

		await handleValueCommand("all", {
			format: "json",
			outputDir: join(tempDir, "cli-value-artifacts"),
			writeArtifacts: true,
		});

		const exported = JSON.parse(output.join("\n"));
		expect(exported.report.summary.sessionCount).toBe(1);
		expect(exported.artifacts.manifestPath).toContain("cli-value-artifacts");
		expect(existsSync(exported.artifacts.manifestPath)).toBe(true);
	});

	it("loads ambient learner evidence from the default data directory and reuses that path in automation gates", async () => {
		process.env.HOME = tempDir;
		process.env.USERPROFILE = tempDir;
		Reflect.deleteProperty(process.env, "MAESTRO_AMBIENT_LEARNER_FILE");
		writeSessionFixture(sessionDir);
		const env = createRuntimeEnv(process.env);
		const defaultLearnerPath = env.ambientLearnerDefaultFile;
		mkdirSync(dirname(defaultLearnerPath), { recursive: true });
		writeAmbientLearnerFixture(defaultLearnerPath);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			env,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.sources.ambientLearnerPath).toBe(defaultLearnerPath);
		expect(report.ambient.outcomeCount).toBe(3);
		expect(report.ambient.automationOpportunities).toContainEqual(
			expect.objectContaining({
				id: "ambient-learner-review",
				scriptGate: `test -s '${defaultLearnerPath}'`,
			}),
		);
		const playbookWorkflow = report.workflows.find(
			(workflow) => workflow.id === "playbook-learning-review",
		);
		expect(playbookWorkflow?.workflowTemplate.yaml).toContain(
			`command: test -s '${defaultLearnerPath}'`,
		);
		expect(playbookWorkflow?.workflowTemplate.yaml).toContain(
			"command: ambient flush || true",
		);
		expect(playbookWorkflow?.workflowTemplate.yaml).not.toContain(
			"MAESTRO_AMBIENT_LEARNER_FILE",
		);
	});

	it("flushes live ambient learner state before reading the report file", async () => {
		writeSessionFixture(sessionDir);
		const env = createRuntimeEnv({
			HOME: tempDir,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		mkdirSync(dirname(env.ambientSocketFile), { recursive: true });
		writeFileSync(env.ambientSocketFile, "");

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			env,
			ambientLearnerFlush: async () => {
				mkdirSync(dirname(env.ambientLearnerDefaultFile), { recursive: true });
				writeAmbientLearnerFixture(env.ambientLearnerDefaultFile);
				return { flushed: true };
			},
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.outcomeCount).toBe(3);
		expect(report.ambient.collectionGaps).toEqual([]);
	});

	it("does not report a running daemon when ambient flush says no daemon is running", async () => {
		writeSessionFixture(sessionDir);
		const env = createRuntimeEnv({
			HOME: tempDir,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		mkdirSync(dirname(env.ambientLearnerDefaultFile), { recursive: true });
		writeAmbientLearnerFixture(env.ambientLearnerDefaultFile);
		const binDir = join(tempDir, "bin");
		mkdirSync(binDir, { recursive: true });
		const ambientPath = join(binDir, "ambient");
		writeFileSync(
			ambientPath,
			"#!/bin/sh\necho 'Error: Daemon is not running' >&2\nexit 1\n",
		);
		chmodSync(ambientPath, 0o755);
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			env,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.outcomeCount).toBe(3);
		expect(report.ambient.collectionGaps).toEqual([]);
	});

	it("flushes configured custom ambient learner files before reading", async () => {
		writeSessionFixture(sessionDir);
		const configuredLearnerPath = join(
			tempDir,
			"ambient-custom",
			"learner.json",
		);
		const env = createRuntimeEnv({
			HOME: tempDir,
			MAESTRO_AMBIENT_LEARNER_FILE: configuredLearnerPath,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		const flush = vi.fn(async () => {
			mkdirSync(dirname(configuredLearnerPath), { recursive: true });
			writeAmbientLearnerFixture(configuredLearnerPath);
			return { flushed: true, learnerPath: configuredLearnerPath };
		});

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			env,
			ambientLearnerFlush: flush,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(flush).toHaveBeenCalledOnce();
		expect(report.sources.ambientLearnerPath).toBe(configuredLearnerPath);
		expect(report.ambient.outcomeCount).toBe(3);
		expect(report.ambient.collectionGaps).toEqual([]);
	});

	it("reads the flushed daemon learner path when an override points at a stale copy", async () => {
		writeSessionFixture(sessionDir);
		const env = createRuntimeEnv({
			...process.env,
			HOME: tempDir,
			USERPROFILE: tempDir,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		const staleLearnerPath = join(tempDir, "stale-ambient-learner.json");
		writeAmbientLearnerData(staleLearnerPath, {
			outcomes: [],
			patterns: [],
		});
		mkdirSync(dirname(env.ambientLearnerDefaultFile), { recursive: true });
		writeAmbientLearnerFixture(env.ambientLearnerDefaultFile);

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			env,
			ambientLearnerPath: staleLearnerPath,
			ambientLearnerFlush: async () => ({
				flushed: true,
				learnerPath: env.ambientLearnerDefaultFile,
			}),
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.sources.ambientLearnerPath).toBe(
			env.ambientLearnerDefaultFile,
		);
		expect(report.ambient.outcomeCount).toBe(3);
		expect(report.ambient.collectionGaps).toContain(
			`Ambient learner override at ${staleLearnerPath} did not match the running daemon; report used flushed learner state from ${env.ambientLearnerDefaultFile}.`,
		);
	});

	it("reports ambient flush failures without assuming the daemon is running", async () => {
		writeSessionFixture(sessionDir);
		const env = createRuntimeEnv({
			HOME: tempDir,
			PATH: process.env.PATH,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		const fakeBinDir = join(tempDir, "bin");
		const fakeAmbientPath = join(fakeBinDir, "ambient");
		mkdirSync(fakeBinDir, { recursive: true });
		writeFileSync(
			fakeAmbientPath,
			'#!/bin/sh\nif [ "$1" = "flush" ]; then\n  echo \'flush storage locked\' >&2\n  exit 1\nfi\nexit 0\n',
		);
		chmodSync(fakeAmbientPath, 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ""}`;
		try {
			const report = await buildCustomerValueReport({
				period: "all",
				sessionDir,
				telemetryPath,
				env,
				now: Date.parse("2026-06-18T12:00:00.000Z"),
			});

			expect(report.ambient.collectionGaps).toContain(
				"Ambient learner flush failed before report generation: flush storage locked.",
			);
			expect(report.ambient.collectionGaps).not.toContain(
				expect.stringContaining("Ambient daemon is running"),
			);
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("filters ambient patterns to the selected range before suggesting playbook promotions", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [
				{
					task_id: "ambient-yesterday",
					event_type: "issue",
					task_type: "fix",
					success: true,
					cost_usd: 0.04,
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-17T09:00:00.000Z",
				},
			],
			patterns: [
				{
					pattern_type: "Label",
					key: "bug",
					success_rate: 0.82,
					sample_count: 5,
					last_updated: "2026-06-17T09:00:00.000Z",
				},
				{
					pattern_type: "EventType",
					key: "Issue",
					success_rate: 0.2,
					sample_count: 4,
					last_updated: "2026-06-17T09:00:00.000Z",
				},
			],
		});

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			flushAmbientLearner: false,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.outcomeCount).toBe(0);
		expect(report.ambient.patternCount).toBe(0);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).not.toContain("capture-successful-pattern");
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).not.toContain("repair-low-success-pattern");
	});

	it("ignores stale persisted ambient patterns for all-time reports", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [],
			patterns: [
				{
					pattern_type: "Label",
					key: "bug",
					success_rate: 0.9,
					sample_count: 20,
					last_updated: "2026-06-18T09:00:00.000Z",
				},
				{
					pattern_type: "EventType",
					key: "Issue",
					success_rate: 0.1,
					sample_count: 20,
					last_updated: "2026-06-18T09:00:00.000Z",
				},
			],
		});

		const report = await buildCustomerValueReport({
			period: "all",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.outcomeCount).toBe(0);
		expect(report.ambient.patternCount).toBe(0);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).not.toContain("capture-successful-pattern");
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).not.toContain("repair-low-success-pattern");
	});

	it("keeps the ambient admin control gapped when no in-range learner outcomes exist", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [
				{
					task_id: "ambient-yesterday",
					event_type: "issue",
					task_type: "fix",
					success: true,
					cost_usd: 0.04,
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-17T09:00:00.000Z",
				},
			],
			patterns: [
				{
					pattern_type: "Label",
					key: "bug",
					success_rate: 0.82,
					sample_count: 5,
					last_updated: "2026-06-17T09:00:00.000Z",
				},
			],
		});

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			flushAmbientLearner: false,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).toContain("handoff-memory-playbook");
		expect(report.admin.controls).toContainEqual(
			expect.objectContaining({
				id: "ambient-learning-loop",
				status: "gap",
				evidence: expect.stringContaining(
					"no outcome evidence for the selected range",
				),
			}),
		);
	});

	it("does not suggest repair playbooks for transient-only learner failures", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [
				{
					task_id: "ambient-transient-1",
					event_type: "scheduled_task",
					task_type: "test",
					success: false,
					cost_usd: 0.01,
					failure_reason: "command not found: gh",
					labels: ["nightly"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:00:00.000Z",
				},
				{
					task_id: "ambient-transient-2",
					event_type: "scheduled_task",
					task_type: "test",
					success: false,
					cost_usd: 0.01,
					failure_reason: "missing credential for GitHub",
					labels: ["nightly"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:10:00.000Z",
				},
				{
					task_id: "ambient-transient-3",
					event_type: "scheduled_task",
					task_type: "test",
					success: false,
					cost_usd: 0.01,
					failure_reason: "rate limit while bootstrapping",
					labels: ["nightly"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:20:00.000Z",
				},
				{
					task_id: "ambient-transient-4",
					event_type: "scheduled_task",
					task_type: "test",
					success: false,
					cost_usd: 0.01,
					failure_reason: "request timed out while fetching dependencies",
					labels: ["nightly"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:30:00.000Z",
				},
				{
					task_id: "ambient-transient-5",
					event_type: "scheduled_task",
					task_type: "test",
					success: false,
					cost_usd: 0.01,
					failure_reason: "network error while bootstrapping",
					labels: ["nightly"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:40:00.000Z",
				},
			],
			patterns: [],
		});

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.protectedTransientFailureCount).toBe(5);
		expect(report.ambient.actionablePatternCount).toBe(0);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).toContain("protect-transient-failures");
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).not.toContain("repair-low-success-pattern");
	});

	it("does not let transient failures drive repair playbook thresholds", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [
				...Array.from({ length: 2 }, (_, index) => ({
					task_id: `ambient-success-${index}`,
					event_type: "issue",
					task_type: "fix",
					success: true,
					cost_usd: 0.01,
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: `2026-06-18T09:0${index}:00.000Z`,
				})),
				...Array.from({ length: 8 }, (_, index) => ({
					task_id: `ambient-transient-${index}`,
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "command not found: gh",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: `2026-06-18T09:1${index}:00.000Z`,
				})),
				{
					task_id: "ambient-durable-failure",
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "review rejected incomplete fix",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:30:00.000Z",
				},
			],
			patterns: [],
		});

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			flushAmbientLearner: false,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.protectedTransientFailureCount).toBe(8);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).toContain("protect-transient-failures");
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).not.toContain("repair-low-success-pattern");
	});

	it("promotes successful patterns using non-transient learner evidence", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [
				...Array.from({ length: 3 }, (_, index) => ({
					task_id: `ambient-success-${index}`,
					event_type: "issue",
					task_type: "fix",
					success: true,
					cost_usd: 0.01,
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: `2026-06-18T09:0${index}:00.000Z`,
				})),
				...Array.from({ length: 5 }, (_, index) => ({
					task_id: `ambient-transient-${index}`,
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "command not found: gh",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: `2026-06-18T09:1${index}:00.000Z`,
				})),
			],
			patterns: [],
		});

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			flushAmbientLearner: false,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.protectedTransientFailureCount).toBe(5);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).toContain("capture-successful-pattern");
	});

	it("still suggests repair playbooks for durable learner failures", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [
				{
					task_id: "ambient-durable-1",
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "checkout timeout budget regressed in product flow",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:00:00.000Z",
				},
				{
					task_id: "ambient-durable-2",
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "network graph planner returned invalid route",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:10:00.000Z",
				},
				{
					task_id: "ambient-durable-3",
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "review rejected incomplete fix",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:20:00.000Z",
				},
			],
			patterns: [],
		});

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.protectedTransientFailureCount).toBe(0);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).toContain("repair-low-success-pattern");
	});

	it("keeps product failures with transport words as durable learner evidence", async () => {
		writeSessionFixture(sessionDir);
		writeAmbientLearnerData(process.env.MAESTRO_AMBIENT_LEARNER_FILE!, {
			outcomes: [
				{
					task_id: "ambient-durable-name-resolution",
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "name resolution rule emitted the wrong symbol",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:00:00.000Z",
				},
				{
					task_id: "ambient-durable-network-error",
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "network error UI failed to show retry guidance",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:10:00.000Z",
				},
				{
					task_id: "ambient-durable-rate-limit",
					event_type: "issue",
					task_type: "fix",
					success: false,
					cost_usd: 0.01,
					failure_reason: "rate limit policy resolver failed closed",
					labels: ["bug"],
					repo: "evalops/maestro-internal",
					timestamp: "2026-06-18T09:20:00.000Z",
				},
			],
			patterns: [],
		});

		const report = await buildCustomerValueReport({
			period: "today",
			sessionDir,
			telemetryPath,
			flushAmbientLearner: false,
			now: Date.parse("2026-06-18T12:00:00.000Z"),
		});

		expect(report.ambient.protectedTransientFailureCount).toBe(0);
		expect(
			report.ambient.playbookLearningOpportunities.map((item) => item.id),
		).toContain("repair-low-success-pattern");
	});
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, name);
	} else {
		process.env[name] = value;
	}
}

function writeA2ATasksFixture(path: string): void {
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				tasks: [
					{
						id: "a2a-task-1",
						kind: "delegation",
						peer: "mac-mini",
						peerDisplayName: "Mac Mini",
						taskId: "task-1",
						contextId: "ctx-1",
						messageId: "msg-1",
						text: "Run the smoke suite and report failures",
						state: "COMPLETED",
						responseText: "Smoke suite passed with artifact bundle.",
						workGraph: {
							state: "completed",
							itemCount: 4,
							activeItemCount: 0,
							blockedItemCount: 1,
							waitingItemCount: 1,
							childRunCount: 2,
							childRunIds: ["run-1", "run-2"],
							toolCallCount: 3,
							pendingToolCallCount: 1,
							toolExecutionIds: ["tool-exec-1"],
							waitItemCount: 1,
							waitIds: ["wait-1"],
							codexSubagents: {
								toolCallIds: ["spawn-1", "wait-1"],
								childRunIds: ["run-1", "run-2"],
								threadIds: ["thread-1"],
								edgeCount: 2,
								edges: [
									{
										spawnToolCallId: "spawn-1",
										childRunId: "run-1",
										threadId: "thread-1",
										operation: "spawn",
										status: "completed",
									},
									{
										waitToolCallId: "wait-1",
										childRunId: "run-2",
										operation: "wait",
										status: "completed",
									},
								],
							},
						},
						transcript: [
							{
								at: "2026-06-18T10:00:00.000Z",
								role: "user",
								text: "Run the smoke suite",
							},
							{
								at: "2026-06-18T10:05:00.000Z",
								role: "agent",
								text: "Smoke suite passed",
								state: "COMPLETED",
							},
						],
						createdAt: "2026-06-18T10:00:00.000Z",
						updatedAt: "2026-06-18T10:05:00.000Z",
						completedAt: "2026-06-18T10:05:00.000Z",
					},
					{
						id: "a2a-task-2",
						kind: "delegation",
						peer: "review-agent",
						peerDisplayName: "Review Agent",
						taskId: "task-2",
						text: "Review risk before release",
						state: "INPUT_REQUIRED",
						workGraph: {
							state: "waiting",
							blockedItemCount: 1,
							waitingItemCount: 1,
							pendingToolCallCount: 1,
							childRunIds: [],
							toolExecutionIds: [],
							waitIds: [],
						},
						transcript: [
							{
								at: "2026-06-18T10:10:00.000Z",
								role: "user",
								text: "Need release risk review",
							},
						],
						createdAt: "2026-06-18T10:10:00.000Z",
						updatedAt: "2026-06-18T10:12:00.000Z",
					},
				],
			},
			null,
			2,
		)}\n`,
	);
}

function writeAmbientLearnerFixture(path: string): void {
	writeAmbientLearnerData(path, {
		outcomes: [
			{
				task_id: "ambient-1",
				event_type: "issue",
				task_type: "fix",
				complexity: "simple",
				model_used: "gpt-5.5",
				success: true,
				confidence_predicted: 0.88,
				tokens_used: 1200,
				estimated_cost_usd: 0.04,
				cost_usd: 0.05,
				duration_secs: 90,
				failure_reason: null,
				labels: ["bug"],
				repo: "evalops/maestro-internal",
				timestamp: "2026-06-18T09:00:00.000Z",
			},
			{
				task_id: "ambient-2",
				event_type: "issue",
				task_type: "fix",
				complexity: "simple",
				model_used: "gpt-5.5",
				success: true,
				confidence_predicted: 0.82,
				tokens_used: 900,
				estimated_cost_usd: 0.03,
				cost_usd: 0.04,
				duration_secs: 70,
				failure_reason: null,
				labels: ["bug"],
				repo: "evalops/maestro-internal",
				timestamp: "2026-06-18T09:30:00.000Z",
			},
			{
				task_id: "ambient-3",
				event_type: "scheduled_task",
				task_type: "test",
				complexity: "medium",
				model_used: "gpt-5.5",
				success: false,
				confidence_predicted: 0.73,
				tokens_used: 700,
				estimated_cost_usd: 0.02,
				cost_usd: 0.02,
				duration_secs: 30,
				failure_reason: "command not found: gh in fresh runner setup",
				labels: ["nightly"],
				repo: "evalops/maestro-internal",
				timestamp: "2026-06-18T10:00:00.000Z",
			},
		],
		patterns: [
			{
				pattern_type: "Label",
				key: "bug",
				success_rate: 0.82,
				sample_count: 5,
				last_updated: "2026-06-18T09:30:00.000Z",
			},
			{
				pattern_type: "EventType",
				key: "ScheduledTask",
				success_rate: 0.32,
				sample_count: 4,
				last_updated: "2026-06-18T10:00:00.000Z",
			},
		],
	});
}

function writeAmbientLearnerData(
	path: string,
	data: Record<string, unknown>,
): void {
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function writeSecretA2ATasksFixture(path: string, secret: string): void {
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				tasks: [
					{
						id: "secret-a2a-task",
						kind: "delegation",
						peer: `peer-${secret}`,
						peerDisplayName: `Display ${secret}`,
						taskId: "secret-task",
						text: `Review deployment with token ${secret}`,
						state: "INPUT_REQUIRED",
						responseText: `Need approval for ${secret}`,
						workGraph: {
							state: "waiting",
							childRunIds: [`run-${secret}`],
							toolExecutionIds: [`tool-${secret}`],
							waitIds: [`wait-${secret}`],
							codexSubagents: {
								toolCallIds: [`spawn-${secret}`],
								childRunIds: [`child-${secret}`],
								threadIds: [`thread-${secret}`],
								edgeCount: 1,
								edges: [
									{
										spawnToolCallId: `spawn-${secret}`,
										childRunId: `child-${secret}`,
										threadId: `thread-${secret}`,
										operation: "spawn",
										status: "waiting",
									},
								],
							},
						},
						transcript: [
							{
								at: "2026-06-18T10:00:00.000Z",
								role: "user",
								text: `Review deployment with token ${secret}`,
							},
						],
						createdAt: "2026-06-18T10:00:00.000Z",
						updatedAt: "2026-06-18T10:01:00.000Z",
					},
				],
			},
			null,
			2,
		)}\n`,
	);
}

function writeMissionManifestFixture(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify(
			{
				version: 1,
				missionId: "customer-report-board",
				milestones: [],
				createdAt: "2026-06-18T08:00:00.000Z",
				updatedAt: "2026-06-18T09:00:00.000Z",
				features: [
					{
						id: "feature-board",
						description: "Capture durable customer report board",
						status: "in-progress",
						fulfills: ["customer.report.board"],
					},
				],
			},
			null,
			2,
		),
	);
}

function writeGitHubAgentMemoryFixture(memoryDir: string): void {
	mkdirSync(memoryDir, { recursive: true });
	writeFileSync(
		join(memoryDir, "tasks.json"),
		JSON.stringify(
			{
				"gh-task-1": {
					id: "gh-task-1",
					type: "pr-review",
					title: "Open customer board PR",
					description: "Prepare the PR for customer board work.",
					priority: 90,
					createdAt: "2026-06-18T09:00:00.000Z",
					status: "completed",
					attempts: 1,
					lastAttemptAt: "2026-06-18T09:30:00.000Z",
					result: {
						success: true,
						prUrl: "https://github.com/evalops/maestro/pull/123",
						branch: "codex/customer-board",
						duration: 120,
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(memoryDir, "outcomes.json"),
		JSON.stringify(
			{
				"gh-task-1": {
					taskId: "gh-task-1",
					prNumber: 123,
					status: "changes_requested",
					reviewFeedback: [],
					updatedAt: "2026-06-18T10:00:00.000Z",
				},
			},
			null,
			2,
		),
	);
}

function writeA2ATaskStateFixture(
	path: string,
	tasks: Array<Record<string, unknown>>,
): void {
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				tasks: tasks.map((task) => ({
					kind: "delegation",
					text: "Run delegated work",
					...task,
				})),
			},
			null,
			2,
		)}\n`,
	);
}

function writeSessionFixture(
	sessionDir: string,
	options: {
		sessionId?: string;
		timestamp?: string;
		userText?: string;
		subject?: string;
		title?: string;
	} = {},
): string {
	const timestamp = options.timestamp ?? "2026-06-18T10:00:00.000Z";
	const sessionId = options.sessionId ?? "session-value-1";
	const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
	const userText =
		options.userText ?? "Fix the release workflow and explain customer value";
	const entries = [
		{
			type: "session",
			version: 2,
			id: sessionId,
			timestamp,
			cwd: "/workspace/maestro",
			subject: options.subject ?? "Release workflow trust card",
		},
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: userText,
				timestamp: Date.parse(timestamp),
			},
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp,
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "I will run the tests.",
					},
					{
						type: "toolCall",
						id: "tool-1",
						name: "bash",
						arguments: { command: "npm test" },
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.5",
				stopReason: "tool_calls",
				timestamp: Date.parse(timestamp),
			},
		},
		{
			type: "message",
			id: "tool-result-1",
			parentId: "assistant-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "bash",
				content: [{ type: "text", text: "tests failed" }],
				isError: true,
				timestamp: Date.parse(timestamp),
			},
		},
		{
			type: "session_meta",
			timestamp,
			summary:
				"Release workflow hardened with retry and confirmation evidence.",
			resumeSummary:
				"Release workflow hardened; checks passed and public mirror followed.",
			memoryExtractionHash: "mem_hash_123",
			...(options.title ? { title: options.title } : {}),
		},
	];
	writeFileSync(
		sessionPath,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return sessionPath;
}

function writeRawSessionEntries(
	sessionDir: string,
	sessionId: string,
	entries: Array<Record<string, unknown>>,
): string {
	const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
	writeFileSync(
		sessionPath,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return sessionPath;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
