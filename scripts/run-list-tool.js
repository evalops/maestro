#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const target = process.argv[2] ?? ".";
const absolute = join(projectRoot, target);

const { listTool } = await import(
	pathToFileURL(join(projectRoot, "dist", "tools", "list.js")).href,
);

const result = await listTool.execute("eval-list", { path: absolute });
const text = result.content.find((item) => item.type === "text");
if (!text) {
	console.error("List tool returned no text content");
	process.exit(1);
}
const firstLine = text.text.trim().split("\n")[0];
console.log(firstLine);

const files = await readdir(absolute);
console.log(files.length);
