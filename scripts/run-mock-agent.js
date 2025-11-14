#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const target = process.argv[2] ?? "README.md";
const targetPath = join(projectRoot, target);
if (!existsSync(targetPath)) {
	console.error(`Target file not found: ${target}`);
	process.exit(1);
}

const agentModule = await import(
	pathToFileURL(join(projectRoot, "dist", "agent", "index.js")).href,
);
const toolsModule = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "read.js")).href,
);

const { Agent } = agentModule;
const { readTool } = toolsModule;

class MockTransport {
	constructor(path) {
		this.path = path;
	}

	async *run(messages, userMessage, config, signal) {
		yield { type: "message_start", message: userMessage };
		const toolCallId = "mock-read-1";
		const toolCallMessage = this.createAssistantMessage(
			[
				{
					type: "toolCall",
					id: toolCallId,
					name: "read",
					arguments: { path: this.path },
				},
			],
			"toolUse",
		);
		yield { type: "message_start", message: toolCallMessage };
		yield { type: "message_end", message: toolCallMessage };

		const tool = config.tools.find((t) => t.name === "read");
		if (!tool) {
			throw new Error("read tool not registered");
		}

		yield {
			type: "tool_execution_start",
			toolCallId,
			toolName: "read",
			args: { path: this.path },
		};

		const toolResult = await tool.execute(toolCallId, { path: this.path }, signal);
		const toolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: toolResult.content,
			details: toolResult.details,
			isError: toolResult.isError ?? false,
			timestamp: Date.now(),
		};

		yield {
			type: "tool_execution_end",
			toolCallId,
			toolName: "read",
			result: toolResultMessage,
			isError: toolResult.isError ?? false,
		};

		const firstText =
			toolResult.content.find((item) => item.type === "text")?.text ?? "";
		const firstLine = firstText.split("\n").find((line) => line.trim()) ?? "";
		const reply = `Read ${this.path}: ${firstLine.trim()}`;
		const finalMessage = this.createAssistantMessage(
			[{ type: "text", text: reply }],
			"stop",
		);
		yield { type: "message_start", message: finalMessage };
		yield { type: "message_end", message: finalMessage };
	}

	createAssistantMessage(content, stopReason) {
		return {
			role: "assistant",
			content,
			api: "mock",
			provider: "mock",
			model: "mock-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		};
	}
}

const mockModel = {
	id: "mock-model",
	name: "Mock",
	provider: "mock",
	api: "openai-completions",
	baseUrl: "",
	reasoning: false,
	contextWindow: 8192,
	maxTokens: 2048,
	source: "builtin",
};

const agent = new Agent({
	transport: new MockTransport(targetPath),
	initialState: { model: mockModel, tools: [] },
});
agent.setModel(mockModel);
agent.setTools([readTool]);

await agent.prompt(`Read file ${targetPath}`);

const lastAssistant = [...agent.state.messages]
	.reverse()
	.find((msg) => msg.role === "assistant");

if (!lastAssistant) {
	console.error("No assistant response recorded.");
	process.exit(1);
}

const textContent = lastAssistant.content.find((c) => c.type === "text");
if (!textContent) {
	console.error("Assistant response missing text content.");
	process.exit(1);
}

console.log(textContent.text.trim());
