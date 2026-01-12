#!/usr/bin/env node
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const paths = process.argv.slice(2);

if (paths.length === 0) {
	console.error("Usage: clean-paths <path>...");
	process.exit(1);
}

for (const target of paths) {
	rmSync(resolve(process.cwd(), target), { recursive: true, force: true });
}
