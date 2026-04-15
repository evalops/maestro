import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../src/agent/types.js";

function createMockState(): AgentState {
	return {
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
		messages: [],
		systemPrompt: "test system prompt",
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4",
			contextWindow: 200000,
			name: "Claude Sonnet 4",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com/v1/messages",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 0.003,
				output: 0.015,
				cacheRead: 0.0003,
				cacheWrite: 0.00375,
			},
			maxTokens: 8192,
		},
		tools: [],
		thinkingLevel: "off",
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Map(),
	};
}

describe("session memory sync", () => {
	let tempRoot: string;
	let originalMaestroHome: string | undefined;
	let originalAgentDir: string | undefined;
	let originalCwd: string;

	beforeEach(() => {
		originalMaestroHome = process.env.MAESTRO_HOME;
		originalAgentDir = process.env.MAESTRO_AGENT_DIR;
		originalCwd = process.cwd();
		tempRoot = mkdtempSync(join(tmpdir(), "maestro-session-memory-"));
		mkdirSync(tempRoot, { recursive: true });
		process.env.MAESTRO_HOME = join(tempRoot, ".maestro-home");
		process.env.MAESTRO_AGENT_DIR = join(tempRoot, ".maestro-agent");
		process.chdir(tempRoot);
		vi.resetModules();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		if (originalAgentDir === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_AGENT_DIR");
		} else {
			process.env.MAESTRO_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("syncs a scoped session-memory entry from session metadata updates", async () => {
		const [{ SessionManager }, memory] = await Promise.all([
			import("../../src/session/manager.js"),
			import("../../src/memory/index.js"),
		]);
		const sessionManager = new SessionManager(false);
		const state = createMockState();
		const userMessage = {
			role: "user" as const,
			content: [
				{ type: "text" as const, text: "Implement session memory syncing" },
			],
			timestamp: Date.now(),
		};

		state.messages.push(userMessage);
		sessionManager.saveMessage(userMessage);
		sessionManager.startSession(state);
		sessionManager.saveSessionSummary("Scoped memory plumbing is in place");
		sessionManager.saveSessionResumeSummary(
			"Finishing the current session memory slice",
		);
		sessionManager.setSessionTitle(
			sessionManager.getSessionFile(),
			"Session memory slice",
		);
		sessionManager.setSessionTags(sessionManager.getSessionFile(), [
			"memory",
			"session",
		]);

		const entries = memory.getTopicMemories("session-memory", {
			sessionId: sessionManager.getSessionId(),
		});

		expect(entries).toHaveLength(1);
		expect(entries[0]?.content).toContain("# Session Memory");
		expect(entries[0]?.content).toContain("## Current State");
		expect(entries[0]?.content).toContain(
			"Finishing the current session memory slice",
		);
		expect(entries[0]?.content).toContain("## Task");
		expect(entries[0]?.content).toContain("Implement session memory syncing");
		expect(entries[0]?.content).toContain("## Worklog");
		expect(entries[0]?.content).toContain("Scoped memory plumbing is in place");
		expect(entries[0]?.content).toContain("- Tags: memory, session");
	});
});
