#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const trackedOutputPath = resolve(
	rootDir,
	"packages/contracts/src/proto/maestro/v1/headless_pb.ts",
);
const protocGenEsPath = resolve(
	rootDir,
	"node_modules/.bin",
	process.platform === "win32" ? "protoc-gen-es.cmd" : "protoc-gen-es",
);

function renderTemplate(outDir) {
	return `version: v2
clean: true
plugins:
  - local: ${protocGenEsPath}
    out: ${outDir}
    opt:
      - target=ts
      - import_extension=.js
`;
}

const scratchRoot = resolve(rootDir, "packages/contracts/src/proto");
mkdirSync(scratchRoot, { recursive: true });
const tempDir = mkdtempSync(join(scratchRoot, ".maestro-headless-proto-check-"));

try {
	const tempOutDir = resolve(tempDir, "proto");
	const tempTemplatePath = resolve(tempDir, "buf.gen.yaml");
	writeFileSync(tempTemplatePath, renderTemplate(tempOutDir), "utf8");

	execFileSync("buf", ["generate", "--template", tempTemplatePath], {
		cwd: rootDir,
		stdio: "inherit",
	});

	const generatedOutputPath = resolve(tempOutDir, "maestro/v1/headless_pb.ts");
	execFileSync(
		"bunx",
		["biome", "check", "--write", "--unsafe", generatedOutputPath],
		{
			cwd: rootDir,
			stdio: "inherit",
		},
	);
	const tracked = readFileSync(trackedOutputPath, "utf8");
	const generated = readFileSync(generatedOutputPath, "utf8");

	if (tracked !== generated) {
		console.error(
			`Generated headless proto output is out of date: ${trackedOutputPath}`,
		);
		const diff = spawnSync(
			"git",
			["diff", "--no-index", "--", trackedOutputPath, generatedOutputPath],
			{
				cwd: rootDir,
				stdio: "inherit",
			},
		);
		process.exitCode = diff.status === 0 ? 1 : diff.status ?? 1;
	}
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
