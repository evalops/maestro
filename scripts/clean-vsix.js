#!/usr/bin/env node
import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const cwd = process.cwd();

for (const entry of readdirSync(cwd)) {
	if (entry.endsWith(".vsix")) {
		rmSync(resolve(cwd, entry), { force: true });
	}
}
