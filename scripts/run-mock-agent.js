#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { runMockAgentFlow } from "./mock-agent-runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const target = process.argv[2] ?? "README.md";
const targetPath = join(projectRoot, target);
if (!existsSync(targetPath)) {
	console.error(`Target file not found: ${target}`);
	process.exit(1);
}

let readSummary = "";

await runMockAgentFlow({
	steps: [
		{
			name: "read",
			args: { path: targetPath },
			onResult: (result) => {
				const firstText = result.content.find((item) => item.type === "text");
				readSummary =
					firstText?.text?.split("\n").find((line) => line.trim()) ?? "";
			},
		},
	],
	buildSummary: () => `Read ${targetPath}: ${readSummary.trim()}`,
	targetPath,
	tools: ["read"],
	prompt: `Read file ${targetPath}`,
});
