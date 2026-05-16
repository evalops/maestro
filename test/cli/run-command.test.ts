import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { handleRunCommand, testing } from "../../src/cli/commands/run.js";
import type { AgentTrajectoryEvent } from "../../src/server/agent-trajectory.js";
import { buildAgentRuntimeLedgerReport } from "../../src/server/agent-runtime-ledger.js";
import { SessionManager } from "../../src/session/manager.js";

describe("run command", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeSessionDir(): { sessionDir: string; sessionId: string } {
		const sessionDir = mkdtempSync(join(tmpdir(), "maestro-run-command-"));
		tempDirs.push(sessionDir);
		const sessionId = "session-reconstruct-1";
		const manager = new SessionManager(false, undefined, { sessionDir });
		const scopedSessionDir = manager
			.getSessionFile()
			.replace(/\/[^/]+\.jsonl$/u, "");
		const filePath = join(scopedSessionDir, "session-reconstruct-1.jsonl");
		const entries = [
			{
				type: "session",
				version: 2,
				id: sessionId,
				timestamp: "2026-05-09T10:00:00.000Z",
				cwd: "/workspace/app",
				model: "openai/gpt-5.5",
				promptContextManifest: {
					entries: [
						{
							path: "/workspace/app/AGENTS.md",
							sourceKind: "project",
							scopeDir: "/workspace/app",
							candidateName: "AGENTS.md",
							bytesRead: 11,
							truncated: false,
							contentHash: "sha256:prompt-doc",
							precedenceIndex: 0,
							content: "root rules",
						},
					],
				},
				unifiedContextManifest: {
					protocolVersion: "maestro.unified-context-manifest.v1",
					version: 1,
					cwd: "/workspace/app",
					projectDocs: {
						cwd: "/workspace/app",
						candidates: ["AGENTS.md"],
						bytesRead: 11,
						entries: [
							{
								path: "/workspace/app/AGENTS.md",
								sourceKind: "project",
								scopeDir: "/workspace/app",
								candidateName: "AGENTS.md",
								bytesRead: 11,
								truncated: false,
								contentHash: "sha256:prompt-doc",
								precedenceIndex: 0,
								content: "root rules",
							},
						],
						diagnostics: [],
					},
					entries: [
						{
							id: "project_doc:project:AGENTS.md",
							kind: "project_doc",
							source: "filesystem",
							status: "loaded",
							label: "AGENTS.md",
							path: "/workspace/app/AGENTS.md",
							scopeDir: "/workspace/app",
							bytesRead: 11,
							contentHash: "prompt-doc",
						},
						{
							id: "mcp_server:platform",
							kind: "mcp_server",
							source: "mcp_runtime",
							status: "connected",
							label: "platform",
							serverName: "platform",
						},
						{
							id: "mcp_resource:platform:docs",
							kind: "mcp_resource",
							source: "mcp_runtime",
							status: "available",
							label: "docs",
							serverName: "platform",
							uri: "mcp://platform/docs",
						},
						{
							id: "mcp_prompt:platform:triage",
							kind: "mcp_prompt",
							source: "mcp_runtime",
							status: "available",
							label: "triage",
							serverName: "platform",
							promptName: "triage",
						},
					],
					diagnostics: [
						{
							code: "mcp_config_loaded",
							severity: "info",
							message: "Loaded MCP config",
							entryId: "mcp_server:platform",
						},
					],
				},
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-05-09T10:00:01.000Z",
				message: {
					role: "user",
					content: "Update the run reconstruction docs",
					timestamp: 1778320801000,
				},
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-05-09T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I will edit the docs." },
						{
							type: "toolCall",
							id: "call-edit",
							name: "edit",
							arguments: { path: "docs/run.md" },
						},
						{
							type: "toolCall",
							id: "call-mcp-search",
							name: "mcp__platform__search",
							arguments: { query: "run reconstruction" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.5",
					stopReason: "toolUse",
					timestamp: 1778320802000,
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: "2026-05-09T10:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-edit",
					toolName: "edit",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 1778320803000,
					details: {
						previousExists: true,
						editsApplied: 1,
						bytesWritten: 42,
					},
				},
			},
			{
				type: "message",
				id: "tool-2",
				parentId: "assistant-1",
				timestamp: "2026-05-09T10:00:03.500Z",
				message: {
					role: "toolResult",
					toolCallId: "call-mcp-search",
					toolName: "mcp__platform__search",
					content: [{ type: "text", text: "search failed" }],
					isError: true,
					timestamp: 1778320803500,
				},
			},
			{
				type: "compaction",
				id: "compact-1",
				parentId: "tool-1",
				timestamp: "2026-05-09T10:00:04.000Z",
				summary: "Kept the run reconstruction docs context.",
				firstKeptEntryId: "user-1",
				tokensBefore: 1200,
			},
		];
		mkdirSync(scopedSessionDir, { recursive: true });
		writeFileSync(
			filePath,
			entries.map((entry) => JSON.stringify(entry)).join("\n"),
		);
		return { sessionDir, sessionId };
	}

	function buildLedgerForEvents(
		sessionId: string,
		events: AgentTrajectoryEvent[],
	) {
		return buildAgentRuntimeLedgerReport({
			session: { id: sessionId },
			timeline: {
				source: "local",
				generatedAt: "2026-05-09T10:00:03.000Z",
				items: [],
			},
			trajectory: {
				schemaVersion: "evalops.maestro.agent-trajectory.v1",
				run: {
					id: sessionId,
					sessionId,
					source: "local",
					generatedAt: "2026-05-09T10:00:03.000Z",
					platformBacked: false,
				},
				counts: {
					events: events.length,
					evidenceAnchors: 0,
					byKind: {},
					byPhase: {},
					byStatus: {},
				},
				events,
			},
			replay: {
				schemaVersion: "evalops.maestro.agent-trajectory-replay.v1",
				trajectorySchemaVersion: "evalops.maestro.agent-trajectory.v1",
				counts: { events: events.length, deltas: 0, errors: 0, warnings: 0 },
				deltas: [],
			},
		});
	}

	function makeLegacySessionDir(): { sessionDir: string; sessionId: string } {
		const sessionDir = mkdtempSync(join(tmpdir(), "maestro-run-legacy-"));
		tempDirs.push(sessionDir);
		const sessionId = "session-legacy-1";
		const manager = new SessionManager(false, undefined, { sessionDir });
		const scopedSessionDir = manager
			.getSessionFile()
			.replace(/\/[^/]+\.jsonl$/u, "");
		const filePath = join(scopedSessionDir, "session-legacy-1.jsonl");
		const entries = [
			{
				type: "session",
				id: sessionId,
				timestamp: "2026-05-09T10:00:00.000Z",
				cwd: "/workspace/legacy",
				model: "openai/gpt-5.5",
			},
			{
				type: "message",
				timestamp: "2026-05-09T10:00:01.000Z",
				message: {
					role: "user",
					content: "Inspect this old run",
					timestamp: 1778320801000,
				},
			},
			{
				type: "message",
				timestamp: "2026-05-09T10:00:02.000Z",
				message: {
					role: "assistant",
					content: "I can reconstruct it.",
					timestamp: 1778320802000,
				},
			},
			{
				type: "compaction",
				timestamp: "2026-05-09T10:00:03.000Z",
				summary: "Legacy compacted context.",
				firstKeptEntryIndex: 0,
				tokensBefore: 300,
			},
		];
		mkdirSync(scopedSessionDir, { recursive: true });
		writeFileSync(
			filePath,
			entries.map((entry) => JSON.stringify(entry)).join("\n"),
		);
		return { sessionDir, sessionId };
	}

	it("parses run inspect as a subcommand", () => {
		const parsed = parseArgs(["run", "inspect", "session-1", "--json"]);

		expect(parsed.command).toBe("run");
		expect(parsed.subcommand).toBe("inspect");
		expect(parsed.messages).toEqual(["session-1"]);
		expect(parsed.execJson).toBe(true);
	});

	it("parses run ledger as a subcommand", () => {
		const parsed = parseArgs(["run", "ledger", "session-1"]);

		expect(parsed.command).toBe("run");
		expect(parsed.subcommand).toBe("ledger");
		expect(parsed.messages).toEqual(["session-1"]);
	});

	it("parses run subcommands when flags appear before the subcommand", () => {
		const parsed = parseArgs(["run", "--json", "ledger", "session-1"]);

		expect(parsed.command).toBe("run");
		expect(parsed.subcommand).toBe("ledger");
		expect(parsed.messages).toEqual(["session-1"]);
		expect(parsed.execJson).toBe(true);
	});

	it("builds a JSON reconstruction report from a saved session", async () => {
		const { sessionDir, sessionId } = makeSessionDir();

		const report = await testing.buildRunReconstructionReport(sessionId, {
			sessionDir,
		});

		expect(report).toMatchObject({
			schemaVersion: "evalops.maestro.run-reconstruction.v1",
			session: {
				id: sessionId,
				cwd: "/workspace/app",
				model: "openai/gpt-5.5",
				messageCount: 4,
			},
			promptContext: {
				entries: 1,
				projectDocs: 1,
				mcpServers: 1,
			},
			coverage: {
				promptInputs: true,
				assistantResponses: true,
				toolRequests: true,
				toolResults: true,
				contextManifest: true,
				contextDiagnostics: true,
				fileChanges: true,
				compactions: true,
				mcpContext: true,
			},
			contextManifest: {
				protocolVersion: "maestro.unified-context-manifest.v1",
				entries: 4,
				projectDocs: 1,
				mcpServers: 1,
				mcpResources: 1,
				mcpPrompts: 1,
				diagnostics: 1,
			},
		});
		expect(report?.contextManifest.byKind).toMatchObject({
			project_doc: 1,
			mcp_server: 1,
			mcp_resource: 1,
			mcp_prompt: 1,
		});
		expect(report?.counts.byType).toMatchObject({
			"message.user": 1,
			"message.assistant": 1,
			"tool.requested": 2,
			"tool.completed": 1,
			"tool.failed": 1,
			"file.changed": 1,
			"compaction.created": 1,
		});
		expect(report?.trajectory).toMatchObject({
			schemaVersion: "evalops.maestro.agent-trajectory.v1",
			run: {
				id: sessionId,
				sessionId,
				source: "local",
				platformBacked: false,
			},
			counts: {
				events: report?.counts.timelineItems,
				byKind: {
					message: 2,
					tool: 4,
					evidence: 1,
					context: 1,
				},
				byPhase: {
					observe: 1,
					think: 1,
					act: 2,
					verify: 3,
				},
			},
		});
		const failedToolResult = report?.trajectory.events.find(
			(event) =>
				event.type === "tool.failed" &&
				event.toolName === "mcp__platform__search",
		);
		expect(failedToolResult).toMatchObject({
			actor: "tool",
			phase: "verify",
			relatedIds: ["call-mcp-search"],
			evidence: [
				{ kind: "timeline_item", id: "tool-result:tool-2:call-mcp-search" },
				{ kind: "tool_call", id: "call-mcp-search" },
			],
		});
		expect(report?.trajectoryReplay).toMatchObject({
			schemaVersion: "evalops.maestro.agent-trajectory-replay.v1",
			counts: {
				events: report?.trajectory.counts.events,
				deltas: 0,
			},
		});
		expect(report?.trajectoryScore).toMatchObject({
			schemaVersion: "evalops.maestro.agent-trajectory-score.v1",
			counts: {
				rules: 1,
				failed: 0,
			},
		});
		expect(report?.trajectoryInspection).toMatchObject({
			schemaVersion: "evalops.maestro.agent-trajectory-inspection.v1",
			redaction: {
				default: "redacted",
			},
			counts: {
				timelineItems: report?.counts.timelineItems,
				events: report?.trajectory.counts.events,
			},
		});
		expect(report?.agentRuntimeLedger).toMatchObject({
			schemaVersion: "evalops.maestro.agent-runtime-ledger.v1",
			run: {
				id: sessionId,
				sessionId,
				source: "local",
				platformBacked: false,
				cwd: "/workspace/app",
				model: "openai/gpt-5.5",
			},
			replay: {
				schemaVersion: "evalops.maestro.agent-runtime-replay-summary.v1",
				deterministic: true,
				deltas: 0,
				errors: 0,
			},
			promotion: {
				schemaVersion: "evalops.maestro.agent-runtime-promotion-plan.v1",
				sessionId,
				warnings: [
					"Promotion plan is dry-run only; no Platform AgentRuntime writes were performed.",
				],
			},
		});
		expect(report?.agentRuntimeLedger.counts.byKind).toMatchObject({
			model_call: 1,
			tool_call: 2,
			tool_result: 2,
			evidence: 1,
			checkpoint: 1,
		});
		expect(report?.agentRuntimeLedger.counts.byState).toMatchObject({
			running: 2,
			failed: 1,
		});
		expect(
			report?.agentRuntimeLedger.entries.find(
				(entry) => entry.type === "tool.completed",
			),
		).toMatchObject({
			kind: "tool_result",
			state: "succeeded",
			platformShape: {
				stepKind: "AGENT_RUN_STEP_KIND_TOOL_RESULT",
				workItemKind: "AGENT_WORK_ITEM_KIND_TOOL_CALL",
			},
		});
		expect(
			report?.agentRuntimeLedger.entries.find(
				(entry) =>
					entry.type === "tool.requested" &&
					entry.toolName === "mcp__platform__search",
			),
		).toMatchObject({
			kind: "tool_call",
			state: "running",
			platformShape: {
				stepKind: "AGENT_RUN_STEP_KIND_TOOL_CALL_INTENT",
				workItemKind: "AGENT_WORK_ITEM_KIND_TOOL_CALL",
			},
		});
		expect(
			report?.agentRuntimeLedger.entries.find(
				(entry) => entry.type === "tool.failed",
			),
		).toMatchObject({
			kind: "tool_result",
			state: "failed",
			platformShape: {
				stepKind: "AGENT_RUN_STEP_KIND_TOOL_RESULT",
				workItemKind: "AGENT_WORK_ITEM_KIND_TOOL_CALL",
			},
		});
		expect(
			report?.agentRuntimeLedger.promotion.operations.at(-1),
		).toMatchObject({
			operation: "complete_run",
			payload: { state: "succeeded" },
		});
		expect(
			report?.trajectoryInspection.scoreFindings[0]?.timelineItemIds,
		).toEqual(["compaction:compact-1"]);
	});

	it("migrates legacy entries before reconstructing the timeline", async () => {
		const { sessionDir, sessionId } = makeLegacySessionDir();

		const report = await testing.buildRunReconstructionReport(sessionId, {
			sessionDir,
		});

		expect(report?.counts.byType).toMatchObject({
			"message.user": 1,
			"message.assistant": 1,
			"compaction.created": 1,
		});
		expect(report?.timeline.items.every((item) => item.id)).toBe(true);
		expect(
			report?.timeline.items.some((item) => item.id.includes("undefined")),
		).toBe(false);
	});

	it("prints human-readable reconstruction output", async () => {
		const { sessionDir, sessionId } = makeSessionDir();
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleRunCommand("inspect", [sessionId], { sessionDir });

		const output = String(log.mock.calls[0]?.[0]);
		expect(output).toContain(`Run reconstruction: ${sessionId}`);
		expect(output).toContain("Timeline preview");
		expect(output).toContain("Trajectory events:");
		expect(output).toContain("Replay deltas:");
		expect(output).toContain("Trajectory score:");
		expect(output).toContain("Replay lab:");
		expect(output).toContain("yes prompt inputs");
		expect(output).toContain("yes context manifest");
		expect(output).toContain("yes MCP context");
		expect(output).toContain("Context manifest: 4 entries");
		expect(output).toContain("file.changed");
	});

	it("prints JSON reconstruction output", async () => {
		const { sessionDir, sessionId } = makeSessionDir();
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleRunCommand("inspect", [sessionId, "--json"], { sessionDir });

		const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
		expect(payload.schemaVersion).toBe("evalops.maestro.run-reconstruction.v1");
		expect(payload.trajectory.schemaVersion).toBe(
			"evalops.maestro.agent-trajectory.v1",
		);
		expect(payload.trajectoryReplay.schemaVersion).toBe(
			"evalops.maestro.agent-trajectory-replay.v1",
		);
		expect(payload.trajectoryScore.schemaVersion).toBe(
			"evalops.maestro.agent-trajectory-score.v1",
		);
		expect(payload.trajectoryInspection.schemaVersion).toBe(
			"evalops.maestro.agent-trajectory-inspection.v1",
		);
		expect(payload.trajectory.events[0]).toMatchObject({
			sequence: 1,
			kind: "session",
			phase: "setup",
		});
		expect(payload.trajectoryInspection.redaction.omitted).toContain(
			"raw tool outputs",
		);
		expect(payload.agentRuntimeLedger.schemaVersion).toBe(
			"evalops.maestro.agent-runtime-ledger.v1",
		);
		expect(payload.agentRuntimeLedger.replay.schemaVersion).toBe(
			"evalops.maestro.agent-runtime-replay-summary.v1",
		);
		expect(payload.agentRuntimeLedger.promotion.operations[0]).toMatchObject({
			operation: "handle_trigger",
			payload: {
				sourceEventType: "maestro.local_ledger_promote",
				sessionId,
			},
		});
		expect(payload.trajectoryInspection.events[0]).toMatchObject({
			timelineItemIds: ["session-started:session-reconstruct-1"],
			evidence: [
				{
					kind: "timeline_item",
					id: "session-started:session-reconstruct-1",
					redacted: true,
				},
			],
		});
		expect(payload.contextManifest).toMatchObject({
			protocolVersion: "maestro.unified-context-manifest.v1",
			mcpResources: 1,
			mcpPrompts: 1,
		});
		expect(
			payload.timeline.items.some(
				(item: { type: string }) => item.type === "tool.completed",
			),
		).toBe(true);
	});

	it("prints JSON AgentRuntime ledger, replay, and promotion projections", async () => {
		const { sessionDir, sessionId } = makeSessionDir();
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleRunCommand("ledger", [sessionId], { sessionDir });
		await handleRunCommand("replay", [sessionId], { sessionDir });
		await handleRunCommand("promote", [sessionId], { sessionDir });

		const ledger = JSON.parse(String(log.mock.calls[0]?.[0]));
		const replay = JSON.parse(String(log.mock.calls[1]?.[0]));
		const promote = JSON.parse(String(log.mock.calls[2]?.[0]));

		expect(ledger.schemaVersion).toBe(
			"evalops.maestro.agent-runtime-ledger.v1",
		);
		expect(ledger.counts.promotionOperations).toBeGreaterThan(
			ledger.counts.entries,
		);
		expect(replay).toMatchObject({
			schemaVersion: "evalops.maestro.agent-runtime-replay-summary.v1",
			deterministic: true,
			deltas: 0,
		});
		expect(promote).toMatchObject({
			schemaVersion: "evalops.maestro.agent-runtime-promotion-plan.v1",
			runId: sessionId,
			sessionId,
		});
		expect(
			promote.operations.some(
				(operation: { operation: string }) =>
					operation.operation === "record_run_step",
			),
		).toBe(true);
	});

	it("uses the final ledger entry for dry-run terminal promotion state", () => {
		const ledger = buildAgentRuntimeLedgerReport({
			session: { id: "session-recovered" },
			timeline: {
				source: "local",
				generatedAt: "2026-05-09T10:00:03.000Z",
				items: [],
			},
			trajectory: {
				schemaVersion: "evalops.maestro.agent-trajectory.v1",
				run: {
					id: "session-recovered",
					sessionId: "session-recovered",
					source: "local",
					generatedAt: "2026-05-09T10:00:03.000Z",
					platformBacked: false,
				},
				counts: {
					events: 2,
					evidenceAnchors: 0,
					byKind: {},
					byPhase: {},
					byStatus: {},
				},
				events: [
					{
						id: "event-failed-tool",
						sequence: 1,
						timestamp: "2026-05-09T10:00:01.000Z",
						kind: "tool",
						phase: "verify",
						actor: "tool",
						type: "tool.completed",
						status: "failed",
						visibility: "user",
						source: "local",
						title: "Tool failed",
						evidence: [],
					},
					{
						id: "event-final-message",
						sequence: 2,
						timestamp: "2026-05-09T10:00:02.000Z",
						kind: "message",
						phase: "think",
						actor: "assistant",
						type: "message.assistant",
						status: "completed",
						visibility: "user",
						source: "local",
						title: "Assistant response",
						evidence: [],
					},
				],
			},
			replay: {
				schemaVersion: "evalops.maestro.agent-trajectory-replay.v1",
				trajectorySchemaVersion: "evalops.maestro.agent-trajectory.v1",
				counts: { events: 2, deltas: 0, errors: 0, warnings: 0 },
				deltas: [],
			},
		});

		expect(ledger.counts.byState).toMatchObject({
			failed: 1,
			succeeded: 1,
		});
		expect(ledger.promotion.operations.at(-1)).toMatchObject({
			operation: "complete_run",
			payload: { state: "succeeded" },
		});
	});

	it("omits dry-run terminal promotion operations for non-terminal final state", () => {
		const ledger = buildAgentRuntimeLedgerReport({
			session: { id: "session-running" },
			timeline: {
				source: "local",
				generatedAt: "2026-05-09T10:00:02.000Z",
				items: [],
			},
			trajectory: {
				schemaVersion: "evalops.maestro.agent-trajectory.v1",
				run: {
					id: "session-running",
					sessionId: "session-running",
					source: "local",
					generatedAt: "2026-05-09T10:00:02.000Z",
					platformBacked: false,
				},
				counts: {
					events: 1,
					evidenceAnchors: 0,
					byKind: {},
					byPhase: {},
					byStatus: {},
				},
				events: [
					{
						id: "event-running-tool",
						sequence: 1,
						timestamp: "2026-05-09T10:00:01.000Z",
						kind: "tool",
						phase: "act",
						actor: "tool",
						type: "tool.requested",
						status: "running",
						visibility: "user",
						source: "local",
						title: "Tool running",
						evidence: [],
					},
				],
			},
			replay: {
				schemaVersion: "evalops.maestro.agent-trajectory-replay.v1",
				trajectorySchemaVersion: "evalops.maestro.agent-trajectory.v1",
				counts: { events: 1, deltas: 0, errors: 0, warnings: 0 },
				deltas: [],
			},
		});

		expect(
			ledger.promotion.operations.some(
				(operation) =>
					operation.operation === "complete_run" ||
					operation.operation === "fail_run",
			),
		).toBe(false);
		expect(ledger.promotion.warnings).toContain(
			"Terminal operation omitted because final ledger entry ended in running state.",
		);
	});

	it("omits terminal promotion operations for non-terminal final states", () => {
		for (const scenario of [
			{
				status: "pending",
				ledgerState: "waiting",
				kind: "wait",
				phase: "wait",
				actor: "platform",
				type: "wait.pending",
			},
			{
				status: "denied",
				ledgerState: "blocked",
				kind: "governance",
				phase: "govern",
				actor: "system",
				type: "policy.decision",
			},
		] as const) {
			const ledger = buildLedgerForEvents(`session-${scenario.ledgerState}`, [
				{
					id: `event-${scenario.ledgerState}`,
					sequence: 1,
					timestamp: "2026-05-09T10:00:01.000Z",
					kind: scenario.kind,
					phase: scenario.phase,
					actor: scenario.actor,
					type: scenario.type,
					status: scenario.status,
					visibility: "user",
					source: "local",
					title: `Final ${scenario.ledgerState} event`,
					evidence: [],
				},
			]);

			expect(
				ledger.promotion.operations.some(
					(operation) =>
						operation.operation === "complete_run" ||
						operation.operation === "fail_run",
				),
			).toBe(false);
			expect(ledger.promotion.warnings).toContain(
				`Terminal operation omitted because final ledger entry ended in ${scenario.ledgerState} state.`,
			);
		}
	});

	it("keeps passive info entries succeeded without treating them as terminal", () => {
		const ledger = buildLedgerForEvents("session-info-only", [
			{
				id: "event-session-started",
				sequence: 1,
				timestamp: "2026-05-09T10:00:01.000Z",
				kind: "session",
				phase: "setup",
				actor: "system",
				type: "session.started",
				status: "info",
				visibility: "user",
				source: "local",
				title: "Session started",
				evidence: [],
			},
		]);

		expect(ledger.entries[0]?.state).toBe("succeeded");
		expect(
			ledger.promotion.operations.some(
				(operation) =>
					operation.operation === "complete_run" ||
					operation.operation === "fail_run",
			),
		).toBe(false);
		expect(ledger.promotion.warnings).toContain(
			"Terminal operation omitted because no substantive terminal ledger entry was available.",
		);
	});

	it("does not project governance decisions as active waits", () => {
		const ledger = buildLedgerForEvents("session-governance", [
			{
				id: "event-policy",
				sequence: 1,
				timestamp: "2026-05-09T10:00:01.000Z",
				kind: "governance",
				phase: "govern",
				actor: "system",
				type: "policy.decision",
				status: "info",
				visibility: "user",
				source: "local",
				title: "Policy decision recorded",
				evidence: [],
			},
			{
				id: "event-final-message",
				sequence: 2,
				timestamp: "2026-05-09T10:00:02.000Z",
				kind: "message",
				phase: "think",
				actor: "assistant",
				type: "message.assistant",
				status: "completed",
				visibility: "user",
				source: "local",
				title: "Assistant response",
				evidence: [],
			},
		]);

		expect(ledger.entries[0]?.platformShape.waitType).toBeUndefined();
		expect(
			ledger.promotion.operations.some(
				(operation) =>
					operation.operation === "wait_run" &&
					operation.ledgerEntryId === "ledger:event-policy",
			),
		).toBe(false);
	});

	it("keeps informational final events eligible for completion promotion", () => {
		const ledger = buildLedgerForEvents("session-info", [
			{
				id: "event-info",
				sequence: 1,
				timestamp: "2026-05-09T10:00:01.000Z",
				kind: "context",
				phase: "setup",
				actor: "system",
				type: "model.info",
				status: "info",
				visibility: "user",
				source: "local",
				title: "Model metadata recorded",
				evidence: [],
			},
		]);

		expect(ledger.entries[0]?.state).toBe("succeeded");
		expect(ledger.promotion.operations.at(-1)).toMatchObject({
			operation: "complete_run",
			payload: { state: "succeeded" },
		});
	});
});
