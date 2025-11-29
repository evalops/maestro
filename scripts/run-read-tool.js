#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const targetPath = process.argv[2];

if (!targetPath) {
	console.error("Usage: node scripts/run-read-tool.js <relative-path>");
	process.exit(1);
}

const absoluteTarget = join(projectRoot, targetPath);

if (!existsSync(absoluteTarget)) {
	console.error(`File not found: ${targetPath}`);
	process.exit(1);
}

const moduleUrl = pathToFileURL(join(projectRoot, "dist", "tools", "read.js"));
const { readTool } = await import(moduleUrl.href);

const result = await readTool.execute("eval-read", {
	path: absoluteTarget,
	wrapInCodeFence: false,
	lineNumbers: false,
});

const textContent = result.content.find((item) => item.type === "text");

if (!textContent) {
	console.error("Read tool did not return text content");
	process.exit(1);
}

const firstLine = textContent.text.split("\n").find((line) => line.trim().length > 0) ?? "";
const cleaned = firstLine.replace(/^#+\s*/, "").trim();
console.log(cleaned);
