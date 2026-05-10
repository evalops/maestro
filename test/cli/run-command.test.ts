import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { handleRunCommand, testing } from "../../src/cli/commands/run.js";
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
					content: [{ type: "text", text: "no results" }],
					isError: false,
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
			"tool.completed": 2,
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
		const toolCompleted = report?.trajectory.events.find(
			(event) =>
				event.type === "tool.completed" &&
				event.toolName === "mcp__platform__search",
		);
		expect(toolCompleted).toMatchObject({
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
});
