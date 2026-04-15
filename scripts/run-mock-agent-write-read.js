#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMockAgentFlow } from "./mock-agent-runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const targetFile = join(projectRoot, "evals", "mock-agent-flow.txt");

let readSummary = "";

await runMockAgentFlow({
	steps: [
		{ name: "write", args: { path: targetFile, content: "Hello evals" } },
		{
			name: "read",
			args: { path: targetFile },
			onResult: (result) => {
				const firstText = result.content.find((item) => item.type === "text");
				readSummary =
					firstText?.text?.split("\n").find((line) => line.trim()) ?? "";
			},
		},
	],
	buildSummary: () => `Wrote and read ${targetFile}: ${readSummary.trim()}`,
	targetPath: targetFile,
	tools: ["write", "read"],
	cleanup: true,
	prompt: `Write and read ${targetFile}`,
});
