#!/usr/bin/env node
// @ts-check

import { execFileSync as defaultExecFileSync } from "node:child_process";

export const packageImpactingFiles = new Set([
	"buf.gen.yaml",
	"buf.yaml",
	"bun.lockb",
	"package.json",
	"tsconfig.base.json",
	"tsconfig.build.json",
	"tsconfig.json",
	"scripts/bundle-runtime-deps.mjs",
	"scripts/copy-db-migrations.js",
	"scripts/copy-themes.js",
	"scripts/codegen-utils.mjs",
	"scripts/ensure-deps.js",
	"scripts/ensure-dir.js",
	"scripts/headless-protocol-codegen.mjs",
	"scripts/package-metadata.js",
	"scripts/runtime-workspaces.mjs",
	"scripts/session-wire-format-codegen.mjs",
	"scripts/workspace-utils.js",
]);

/**
 * @param {string} filePath
 */
export function normalizeRepoPath(filePath) {
	return filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

/**
 * @param {string} filePath
 */
export function isPackageImpactingPath(filePath) {
	const path = normalizeRepoPath(filePath);
	return (
		packageImpactingFiles.has(path) ||
		path.startsWith("packages/") ||
		path.startsWith("proto/") ||
		path.startsWith("skills/") ||
		path.startsWith("src/") ||
		path.startsWith("types/")
	);
}

/**
 * @param {string} filePath
 */
export function isRustTestOnlyPath(filePath) {
	const path = normalizeRepoPath(filePath);
	return path.startsWith("packages/") && path.endsWith("/tests.rs");
}

/**
 * @param {string} line
 * @param {{ inBlockComment: boolean }} state
 */
function braceDelta(line, state) {
	let delta = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		const next = line[index + 1];

		if (state.inBlockComment) {
			if (char === "*" && next === "/") {
				state.inBlockComment = false;
				index += 1;
			}
			continue;
		}

		if (!inString && char === "/" && next === "/") {
			break;
		}
		if (!inString && char === "/" && next === "*") {
			state.inBlockComment = true;
			index += 1;
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			delta += 1;
		} else if (char === "}") {
			delta -= 1;
		}
	}

	return delta;
}

/**
 * @param {string} source
 */
export function stripRustTestModules(source) {
	const lines = source.split(/\r?\n/);
	const output = [];
	const testModulePattern =
		/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+tests\s*(?:;|\{)/;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!testModulePattern.test(line)) {
			output.push(line);
			continue;
		}

		while (output.length > 0 && /^\s*#\[/.test(output[output.length - 1])) {
			output.pop();
		}

		if (line.includes(";")) {
			continue;
		}

		const scannerState = { inBlockComment: false };
		let depth = braceDelta(line, scannerState);
		while (index + 1 < lines.length && depth > 0) {
			index += 1;
			depth += braceDelta(lines[index], scannerState);
		}
	}

	return output.join("\n");
}

/**
 * @param {string} source
 */
export function rustProductionContent(source) {
	return stripRustTestModules(source)
		.replace(/[ \t]+$/gm, "")
		.replace(/\n+$/g, "");
}

/**
 * @param {{
 *   path: string;
 *   oldContent?: string;
 *   newContent?: string;
 * }} change
 */
export function isPackageImpactingChange(change) {
	const path = normalizeRepoPath(change.path);
	if (!isPackageImpactingPath(path)) {
		return false;
	}
	if (isRustTestOnlyPath(path)) {
		return false;
	}
	if (path.startsWith("packages/") && path.endsWith(".rs")) {
		const oldProduction = rustProductionContent(change.oldContent ?? "");
		const newProduction = rustProductionContent(change.newContent ?? "");
		return oldProduction !== newProduction;
	}
	return true;
}

/**
 * @param {{
 *   cwd: string;
 *   execFileSync: typeof defaultExecFileSync;
 *   ref: string;
 *   path: string;
 * }} options
 */
function readGitBlob(options) {
	try {
		return options.execFileSync(
			"git",
			["show", `${options.ref}:${options.path}`],
			{
				cwd: options.cwd,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	} catch {
		return "";
	}
}

/**
 * @param {{
 *   cwd?: string;
 *   execFileSync?: typeof defaultExecFileSync;
 *   headRef?: string;
 *   tagTarget: string;
 * }} options
 */
export function packageChangedSinceTag(options) {
	const cwd = options.cwd ?? process.cwd();
	const execFileSync = options.execFileSync ?? defaultExecFileSync;
	const headRef = options.headRef ?? "HEAD";

	if (!options.tagTarget) {
		throw new Error("tagTarget is required");
	}

	const diffOutput = execFileSync(
		"git",
		["diff", "--name-only", `${options.tagTarget}..${headRef}`],
		{ cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);

	for (const changedPath of diffOutput.split(/\r?\n/).filter(Boolean)) {
		if (!isPackageImpactingPath(changedPath)) {
			continue;
		}

		const oldContent = readGitBlob({
			cwd,
			execFileSync,
			ref: options.tagTarget,
			path: changedPath,
		});
		const newContent = readGitBlob({
			cwd,
			execFileSync,
			ref: headRef,
			path: changedPath,
		});

		if (
			isPackageImpactingChange({
				path: changedPath,
				oldContent,
				newContent,
			})
		) {
			return true;
		}
	}

	return false;
}
