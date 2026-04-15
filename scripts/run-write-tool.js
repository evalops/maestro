#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const target = process.argv[2];
const content = process.argv[3] ?? "";
if (!target) {
	console.error("Usage: node scripts/run-write-tool.js <path> [content]");
	process.exit(1);
}

const absolutePath = join(projectRoot, target);

const { writeTool } = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "write.js")).href,
);

const result = await writeTool.execute("eval-write", { path: absolutePath, content });
const firstText = result.content.find((item) => item.type === "text");
if (!firstText) {
	console.error("Write tool returned no text output");
	process.exit(1);
}
console.log(firstText.text.trim());

const fileContent = readFileSync(absolutePath, "utf-8");
console.log(fileContent);

await unlink(absolutePath);
