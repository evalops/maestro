import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentState } from "../src/agent/types.js";
import { buildConversationModel } from "../src/conversation/render-model.js";
import {
	exportSessionToHtml,
	exportSessionToText,
} from "../src/export-html.js";
import { SessionManager } from "../src/session-manager.js";

function createTempSessionFile(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "composer-export-"));
	const filePath = join(dir, "session.jsonl");
	writeFileSync(filePath, `${contents.trim()}\n`, "utf8");
	return filePath;
}

function buildAgentState(): AgentState {
	return {
		systemPrompt: "fallback system prompt",
		model: {
			id: "test-model",
			name: "Test Model",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 4096,
		},
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Map(),
	};
}

const sessionJson = `
{"type":"session","id":"session-1","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/repo","model":"anthropic/claude-3","thinkingLevel":"low","systemPrompt":"Persisted system","tools":[{"name":"bash","description":"Run bash"}]}
{"type":"message","message":{"role":"user","content":"list files","timestamp":1}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Running ls"},{"type":"toolCall","id":"tool-1","name":"bash","arguments":{"command":"ls"}}],"api":"anthropic-messages","provider":"anthropic","model":"claude-3","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":2}}
{"type":"message","message":{"role":"toolResult","toolCallId":"tool-1","toolName":"bash","content":[{"type":"text","text":"src\\npackage.json"}],"isError":false,"timestamp":3}}
`;

describe("exporters", () => {
	it("includes tool result renderables", () => {
		const messages = sessionJson
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const renderables = buildConversationModel(messages as any);
		expect(renderables.some((msg: any) => msg.kind === "toolResult")).toBe(
			true,
		);
	});

	it("exports HTML using shared render model", async () => {
		const sessionFile = createTempSessionFile(sessionJson);
		const manager = new SessionManager(false, sessionFile);
		const htmlPath = join(dirname(sessionFile), "export.html");
		const outputPath = await exportSessionToHtml(
			manager,
			buildAgentState(),
			htmlPath,
		);
		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("Running ls");
		expect(html).toContain("Persisted system");
		expect(html).toContain("src");
		expect(html).toContain("Available Tools");
	});

	it("exports text transcript with tool results", async () => {
		const sessionFile = createTempSessionFile(sessionJson);
		const manager = new SessionManager(false, sessionFile);
		const textPath = join(dirname(sessionFile), "export.txt");
		const outputPath = await exportSessionToText(
			manager,
			buildAgentState(),
			textPath,
		);
		const text = readFileSync(outputPath, "utf8");
		expect(text).toContain("User:\nlist files");
		expect(text).toContain("[tool call] bash");
		expect(text).toContain("[tool result] bash");
	});
});
