import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentState, AppMessage } from "../../src/agent/types.js";
import { buildConversationModel } from "../../src/conversation/render-model.js";
process.env.TZ = "UTC";

const normalizeWhitespace = (input: string): string =>
	input.replace(/\s+/g, " ").trim();
import {
	exportSessionToHtml,
	exportSessionToJson,
	exportSessionToJsonl,
	exportSessionToText,
} from "../../src/export-html.js";
import { SessionManager } from "../../src/session/manager.js";

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
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
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

const richSessionJson = `
{"type":"session","id":"session-2","timestamp":"2024-02-01T00:00:00.000Z","cwd":"/repo","model":"anthropic/claude-3","thinkingLevel":"medium","systemPrompt":"Persisted system","tools":[{"name":"read","description":"Read files"},{"name":"bash","description":"Run bash"}]}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"See attachment for context"}],"attachments":[{"id":"att-1","type":"image","fileName":"design.png","mimeType":"image/png","size":12345,"content":"base64-data","preview":"thumbnail"}],"timestamp":4}}
{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Reviewing screenshot"},{"type":"text","text":"Scanning files"},{"type":"toolCall","id":"tool-2","name":"read","arguments":{"path":"src/export-html.ts"}},{"type":"toolCall","id":"tool-3","name":"bash","arguments":{"command":"npm run test"}}],"api":"anthropic-messages","provider":"anthropic","model":"claude-3","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":5}}
{"type":"message","message":{"role":"toolResult","toolCallId":"tool-2","toolName":"read","content":[{"type":"text","text":"// file contents"}],"isError":false,"timestamp":6}}
{"type":"message","message":{"role":"toolResult","toolCallId":"tool-3","toolName":"bash","content":[{"type":"text","text":"All tests passing"},{"type":"image","mimeType":"image/png","data":"image-bytes"}],"isError":false,"timestamp":7}}
`;

const secretSessionJson = `
{"type":"session","id":"session-3","timestamp":"2024-03-01T00:00:00.000Z","cwd":"/repo","model":"anthropic/claude-3","thinkingLevel":"low","systemPrompt":"Persisted system","tools":[]}
{"type":"message","message":{"role":"user","content":"apiKey=sk-ant-abcdefghijklmnopqrstuvwxyz123456","timestamp":8}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Stored apiKey=sk-ant-abcdefghijklmnopqrstuvwxyz123456"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-3","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":9}}
`;

const largeArraySessionJson = (() => {
	const content = Array.from({ length: 105 }, (_, index) => ({
		type: "text",
		text: `line-${index}`,
	}));
	return [
		'{"type":"session","id":"session-4","timestamp":"2024-04-01T00:00:00.000Z","cwd":"/repo","model":"anthropic/claude-3","thinkingLevel":"low","systemPrompt":"Persisted system","tools":[]}',
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-3",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				timestamp: 10,
			},
		}),
	].join("\n");
})();

describe("exporters", () => {
	it("includes tool result renderables", () => {
		const messages = sessionJson
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const renderables = buildConversationModel(messages as AppMessage[]);
		expect(renderables.some((msg) => msg.kind === "toolResult")).toBe(true);
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
		expect(html).toContain("src");
	});

	it("uses maestro branding in exported HTML", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-02-02T12:00:00Z"));
		const sessionFile = createTempSessionFile(sessionJson);
		const manager = new SessionManager(false, sessionFile);
		const htmlPath = join(dirname(sessionFile), "export.html");
		const outputPath = await exportSessionToHtml(
			manager,
			buildAgentState(),
			htmlPath,
		);
		const html = readFileSync(outputPath, "utf8");
		vi.useRealTimers();
		expect(html).toContain("Maestro Session Export");
		expect(html).toContain("Generated by Maestro v");
		expect(html).not.toContain("Composer Session Export");
		expect(html).not.toContain("Generated by Composer v");
		expect(html).not.toContain(">Composer<");
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

	it("renders attachments, thinking, and multiple tool calls in HTML", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-02-02T12:00:00Z"));
		const sessionFile = createTempSessionFile(richSessionJson);
		const manager = new SessionManager(false, sessionFile);
		const htmlPath = join(dirname(sessionFile), "rich.html");
		const outputPath = await exportSessionToHtml(
			manager,
			buildAgentState(),
			htmlPath,
		);
		const html = readFileSync(outputPath, "utf8");
		vi.useRealTimers();
		const attachmentSection = normalizeWhitespace(
			html.match(
				/<div class="user-message">[\s\S]*?<div class="attachment-list">[\s\S]*?<\/div>\s*<\/div>/,
			)?.[0] ?? "",
		);
		expect(attachmentSection).toMatchInlineSnapshot(
			`"<div class=\"user-message\"><div>See attachment for context</div><div class=\"attachment-list\"><div class=\"attachment-item\">📎 design.png <span>image/png</span></div></div>"`,
		);
		const bashSection = normalizeWhitespace(
			html.match(
				/<div class="tool-command">\$ npm run test<\/div>[\s\S]*?<div class="attachment-list">[\s\S]*?<\/div>/,
			)?.[0] ?? "",
		);
		expect(bashSection).toMatchInlineSnapshot(
			`"<div class=\"tool-command\">$ npm run test</div><div class=\"tool-output\"><div>All tests passing</div></div><div class=\"attachment-list\"><div class=\"attachment-item\">🖼 image/png <span>Image 1</span></div>"`,
		);
	});

	it("exports attachments and tool images in text transcript", async () => {
		const sessionFile = createTempSessionFile(richSessionJson);
		const manager = new SessionManager(false, sessionFile);
		const textPath = join(dirname(sessionFile), "rich.txt");
		const outputPath = await exportSessionToText(
			manager,
			buildAgentState(),
			textPath,
		);
		const text = readFileSync(outputPath, "utf8");
		expect(text).toContain("[attachment] design.png (image/png)");
		expect(text).toContain("[tool call] read");
		expect(text).toContain("Tool bash (tool-3):");
		expect(text).toContain("[image] image/png");
	});

	it("renders attachments, thinking, and multiple tool calls in HTML", async () => {
		const sessionFile = createTempSessionFile(richSessionJson);
		const manager = new SessionManager(false, sessionFile);
		const htmlPath = join(dirname(sessionFile), "rich.html");
		const outputPath = await exportSessionToHtml(
			manager,
			buildAgentState(),
			htmlPath,
		);
		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("design.png");
		expect(html).toContain("Reviewing screenshot");
		expect(html).toContain("read");
		expect(html).toContain("npm run test");
	});

	it("exports attachments and tool images in text transcript", async () => {
		const sessionFile = createTempSessionFile(richSessionJson);
		const manager = new SessionManager(false, sessionFile);
		const textPath = join(dirname(sessionFile), "rich.txt");
		const outputPath = await exportSessionToText(
			manager,
			buildAgentState(),
			textPath,
		);
		const text = readFileSync(outputPath, "utf8");
		expect(text).toContain("[attachment] design.png (image/png)");
		expect(text).toContain("[tool call] read");
		expect(text).toContain("[tool result] read");
		expect(text).toContain("[image] image/png");
	});

	it("flushes session manager before exporting HTML", async () => {
		const sessionFile = createTempSessionFile(sessionJson);
		const flushSpy = vi.fn().mockResolvedValue(undefined);
		const manager = {
			flush: flushSpy,
			getSessionFile: () => sessionFile,
		} as unknown as SessionManager;
		await exportSessionToHtml(manager, buildAgentState());
		expect(flushSpy).toHaveBeenCalledTimes(1);
	});

	it("flushes session manager before exporting text", async () => {
		const sessionFile = createTempSessionFile(sessionJson);
		const flushSpy = vi.fn().mockResolvedValue(undefined);
		const manager = {
			flush: flushSpy,
			getSessionFile: () => sessionFile,
		} as unknown as SessionManager;
		await exportSessionToText(manager, buildAgentState());
		expect(flushSpy).toHaveBeenCalledTimes(1);
	});

	it("exports a portable JSON wrapper", async () => {
		const sessionFile = createTempSessionFile(sessionJson);
		const manager = new SessionManager(false, sessionFile);
		const jsonPath = join(dirname(sessionFile), "portable.json");
		const outputPath = await exportSessionToJson(manager, jsonPath);
		const exported = JSON.parse(readFileSync(outputPath, "utf8")) as {
			format: string;
			exportedAt: string;
			entries: Array<{ type: string }>;
		};
		expect(exported.format).toBe("maestro-session-export.v1");
		expect(exported.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(exported.entries[0]?.type).toBe("session");
	});

	it("redacts secrets in portable JSONL exports", async () => {
		const sessionFile = createTempSessionFile(secretSessionJson);
		const manager = new SessionManager(false, sessionFile);
		const jsonlPath = join(dirname(sessionFile), "portable.jsonl");
		const outputPath = await exportSessionToJsonl(manager, jsonlPath, {
			redactSecrets: true,
		});
		const exported = readFileSync(outputPath, "utf8");
		expect(exported).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz123456");
		expect(exported).toContain("[REDACTED:api_key:");
	});

	it("preserves full arrays when redacting portable exports", async () => {
		const sessionFile = createTempSessionFile(largeArraySessionJson);
		const manager = new SessionManager(false, sessionFile);
		const jsonPath = join(dirname(sessionFile), "portable.json");
		const outputPath = await exportSessionToJson(manager, jsonPath, {
			redactSecrets: true,
		});
		const exported = JSON.parse(readFileSync(outputPath, "utf8")) as {
			entries: Array<{
				type: string;
				message?: { content?: Array<{ type: string; text: string }> };
			}>;
		};
		const messageEntry = exported.entries.find(
			(entry) => entry.type === "message",
		);
		expect(messageEntry?.message?.content).toHaveLength(105);
		expect(messageEntry?.message?.content?.[104]).toEqual({
			type: "text",
			text: "line-104",
		});
	});

	it("ignores malformed lines in portable exports", async () => {
		const sessionFile = createTempSessionFile(
			`${sessionJson.trim()}\n{"type":"message","message":{"role":"user"\n`,
		);
		const manager = new SessionManager(false, sessionFile);
		const jsonPath = join(dirname(sessionFile), "portable.json");
		const outputPath = await exportSessionToJson(manager, jsonPath);
		const exported = JSON.parse(readFileSync(outputPath, "utf8")) as {
			entries: Array<{ type: string }>;
		};
		expect(exported.entries.some((entry) => entry.type === "session")).toBe(
			true,
		);
	});
});
