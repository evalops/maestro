#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unlinkSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const targetFile = join(projectRoot, "evals", "mock-agent-flow.txt");

const agentModule = await import(
	pathToFileURL(join(projectRoot, "dist", "agent", "index.js")).href,
);
const readModule = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "read.js")).href,
);
const writeModule = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "write.js")).href,
);

const { Agent } = agentModule;
const { readTool } = readModule;
const { writeTool } = writeModule;

class MultiToolTransport {
	constructor(path, content) {
		this.path = path;
		this.content = content;
		this.readSummary = "";
	}

	async *run(messages, userMessage, config, signal) {
		yield { type: "message_start", message: userMessage };

		const operations = [
			{ id: "write-op", name: "write", args: { path: this.path, content: this.content } },
			{ id: "read-op", name: "read", args: { path: this.path } },
		];

		for (const op of operations) {
			const callMessage = this.createToolCall(op);
			yield { type: "message_start", message: callMessage };
			yield { type: "message_end", message: callMessage };

			const tool = config.tools.find((t) => t.name === op.name);
			if (!tool) throw new Error(`Tool ${op.name} not registered`);

			yield {
				type: "tool_execution_start",
				oolCallId: op.id,
				oolName: op.name,
				args: op.args,
			};

			const result = await tool.execute(op.id, op.args, signal);
			const toolResultMessage = {
				role: "toolResult",
				toolCallId: op.id,
				oolName: op.name,
				content: result.content,
				details: result.details,
				isError: result.isError ?? false,
				timestamp: Date.now(),
			};

			if (op.name === "read") {
				const firstText = result.content.find((item) => item.type === "text");
				this.readSummary = firstText?.text?.split("\n").find((line) => line.trim()) ?? "";
			}

			yield {
				type: "tool_execution_end",
				oolCallId: op.id,
				oolName: op.name,
				result: toolResultMessage,
				isError: result.isError ?? false,
			};
		}

		const finalText = `Wrote and read ${this.path}: ${this.readSummary.trim()}`;
		const finalMessage = this.createAssistantMessage([{ type: "text", text: finalText }], "stop");
		yield { type: "message_start", message: finalMessage };
		yield { type: "message_end", message: finalMessage };
	}

	createToolCall(op) {
		return this.createAssistantMessage([
			{
				type: "toolCall",
				id: op.id,
				name: op.name,
				arguments: op.args,
			},
		]);
	}

	createAssistantMessage(content, stopReason = "toolUse") {
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
	transport: new MultiToolTransport(targetFile, "Hello evals"),
	initialState: { model: mockModel, tools: [] },
});
agent.setModel(mockModel);
agent.setTools([writeTool, readTool]);

await agent.prompt(`Write and read ${targetFile}`);

const finalAssistant = [...agent.state.messages]
	.reverse()
	.find((msg) => msg.role === "assistant");

if (!finalAssistant) {
	console.error("No assistant response recorded.");
	process.exit(1);
}

const textContent = finalAssistant.content.find((c) => c.type === "text");
if (!textContent) {
	console.error("Assistant response missing text content.");
	process.exit(1);
}

console.log(textContent.text.trim());

if (existsSync(targetFile)) {
	unlinkSync(targetFile);
}
