#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const agentModule = await import(
	pathToFileURL(join(projectRoot, "dist", "agent", "index.js")).href,
);
const searchModule = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "search.js")).href,
);
const readModule = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "read.js")).href,
);
const helpersModule = await import(
	pathToFileURL(join(projectRoot, "dist", "testing", "mock-agent.js")).href,
);

const { Agent } = agentModule;
const { searchTool } = searchModule;
const { readTool } = readModule;
const { MockToolTransport } = helpersModule;

const tempDir = mkdtempSync(join(projectRoot, "evals/search-read-"));
const tempFile = join(tempDir, "note.txt");
writeFileSync(tempFile, "Composer eval scenario\nAnother line\nTODO testing");

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

let lineNumber = 1;
let readContent = "";
let foundSearchMatch = false;
const readOperation = {
	name: "read",
	args: { path: tempFile, offset: lineNumber },
	onResult: (result) => {
		const text = result.content.find((item) => item.type === "text");
		readContent = text?.text ?? "";
	},
};
const transport = new MockToolTransport(
	[
		{
			name: "search",
			args: { pattern: "TODO", paths: [tempDir] },
			onResult: (result) => {
				const match = result.content
					.find((item) => item.type === "text")?.text?.split("\n")
					.find((line) => line.includes(tempFile));
				const number = match?.split(":")[1];
				lineNumber = number ? Number(number) : 1;
				foundSearchMatch = !!match && Number.isFinite(lineNumber) && lineNumber > 0;
				readOperation.args.offset = lineNumber;
			},
		},
		readOperation,
	],
	() => `Search and read: ${readContent.includes("TODO testing") ? "ok" : readContent.trim()}`,
);

const agent = new Agent({
	transport,
	initialState: { model: mockModel, tools: [searchTool, readTool] },
});
agent.setTools([searchTool, readTool]);

await agent.prompt("Search todo and read");

const finalAssistant = [...agent.state.messages]
	.reverse()
	.find((msg) => msg.role === "assistant" && msg.content.some((c) => c.type === "text"));

if (!finalAssistant) {
	console.error("No assistant response recorded.");
	rmSync(tempDir, { recursive: true, force: true });
	process.exit(1);
}

console.log(finalAssistant.content.find((c) => c.type === "text")?.text ?? "");
if (!foundSearchMatch) {
	console.error("mock search/read flow did not find the expected search match");
	rmSync(tempDir, { recursive: true, force: true });
	process.exit(1);
}
if (!readContent.includes("TODO testing")) {
	console.error("mock search/read flow did not read the expected search match");
	rmSync(tempDir, { recursive: true, force: true });
	process.exit(1);
}
rmSync(tempDir, { recursive: true, force: true });
