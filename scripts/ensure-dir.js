#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const dirs = process.argv.slice(2);

if (dirs.length === 0) {
	console.error("Usage: ensure-dir <path>...");
	process.exit(1);
}

for (const target of dirs) {
	mkdirSync(resolve(process.cwd(), target), { recursive: true });
}
