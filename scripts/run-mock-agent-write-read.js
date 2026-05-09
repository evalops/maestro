#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { runMockAgentFlow } from "./mock-agent-runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const targetFile = join(projectRoot, "evals", "mock-agent-flow.txt");

rmSync(targetFile, { force: true });

let readContent = "";

await runMockAgentFlow({
	steps: [
		{ name: "write", args: { path: targetFile, content: "Hello evals" } },
		{
			name: "read",
			args: { path: targetFile },
			onResult: (result) => {
				const firstText = result.content.find((item) => item.type === "text");
				readContent = firstText?.text ?? "";
			},
		},
	],
	buildSummary: () => `Wrote and read ${targetFile}: ${readContent.includes("Hello evals") ? "ok" : readContent.trim()}`,
	targetPath: targetFile,
	tools: ["write", "read"],
	cleanup: true,
	prompt: `Write and read ${targetFile}`,
});

if (!readContent.includes("Hello evals")) {
	throw new Error("mock write/read flow did not read the expected file content");
}
