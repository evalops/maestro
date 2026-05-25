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
 * @param {string} filePath
 */
function rustModulePathForTestsFile(filePath) {
	return normalizeRepoPath(filePath).replace(/\/tests\.rs$/, ".rs");
}

/**
 * @param {string} line
 * @param {number} startIndex
 */
function rustCharLiteralEnd(line, startIndex) {
	let escaped = false;
	const maxCharLiteralLength = 24;
	const maxIndex = Math.min(
		line.length - 1,
		startIndex + maxCharLiteralLength,
	);

	for (let index = startIndex + 1; index <= maxIndex; index += 1) {
		const char = line[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "'") {
			return index;
		}
	}

	return -1;
}

/**
 * @param {string} line
 * @param {number} startIndex
 */
function rustRawStringStart(line, startIndex) {
	let rawPrefixIndex = -1;
	if (line[startIndex] === "r") {
		rawPrefixIndex = startIndex;
	} else if (line[startIndex] === "b" && line[startIndex + 1] === "r") {
		rawPrefixIndex = startIndex + 1;
	}
	if (rawPrefixIndex === -1) {
		return null;
	}

	let cursor = rawPrefixIndex + 1;
	let hashCount = 0;
	while (line[cursor] === "#") {
		hashCount += 1;
		cursor += 1;
	}

	if (line[cursor] !== '"') {
		return null;
	}

	return {
		contentStart: cursor + 1,
		hashCount,
	};
}

/**
 * @param {number} hashCount
 */
function rustRawStringEndToken(hashCount) {
	return `"${"#".repeat(hashCount)}`;
}

/**
 * @param {string} line
 * @param {{ blockCommentDepth: number; rawStringHashes: number | null }} state
 */
function braceDelta(line, state) {
	let delta = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		const next = line[index + 1];

		if (state.rawStringHashes !== null) {
			const endToken = rustRawStringEndToken(state.rawStringHashes);
			const endIndex = line.indexOf(endToken, index);
			if (endIndex === -1) {
				break;
			}
			state.rawStringHashes = null;
			index = endIndex + endToken.length - 1;
			continue;
		}

		if (state.blockCommentDepth > 0) {
			if (char === "/" && next === "*") {
				state.blockCommentDepth += 1;
				index += 1;
			} else if (char === "*" && next === "/") {
				state.blockCommentDepth -= 1;
				index += 1;
			}
			continue;
		}

		if (!inString && char === "/" && next === "/") {
			break;
		}
		if (!inString && char === "/" && next === "*") {
			state.blockCommentDepth = 1;
			index += 1;
			continue;
		}
		if (!inString) {
			const rawStringStart = rustRawStringStart(line, index);
			if (rawStringStart) {
				const endToken = rustRawStringEndToken(rawStringStart.hashCount);
				const endIndex = line.indexOf(endToken, rawStringStart.contentStart);
				if (endIndex === -1) {
					state.rawStringHashes = rawStringStart.hashCount;
					break;
				}
				index = endIndex + endToken.length - 1;
				continue;
			}
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
		if (char === "'") {
			const literalEnd = rustCharLiteralEnd(line, index);
			if (literalEnd !== -1) {
				index = literalEnd;
				continue;
			}
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
		/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+tests\s*(;|\{)/;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const moduleMatch = line.match(testModulePattern);
		if (!moduleMatch) {
			output.push(line);
			continue;
		}

		while (output.length > 0 && /^\s*#\[/.test(output[output.length - 1])) {
			output.pop();
		}

		if (moduleMatch[1] === ";") {
			continue;
		}

		const scannerState = { blockCommentDepth: 0, rawStringHashes: null };
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
export function hasCfgTestModuleDeclaration(source) {
	const lines = source.split(/\r?\n/);
	const moduleDeclarationPattern =
		/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+tests\s*;/;
	const inlineCfgModuleDeclarationPattern =
		/^\s*#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+tests\s*;/;
	const cfgTestAttrPattern = /^\s*#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*$/;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (inlineCfgModuleDeclarationPattern.test(line)) {
			return true;
		}
		if (!moduleDeclarationPattern.test(line)) {
			continue;
		}

		for (let attrIndex = index - 1; attrIndex >= 0; attrIndex -= 1) {
			const attrLine = lines[attrIndex].trim();
			if (!attrLine) {
				continue;
			}
			if (!attrLine.startsWith("#[")) {
				break;
			}
			if (cfgTestAttrPattern.test(lines[attrIndex])) {
				return true;
			}
		}
	}

	return false;
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
 *   oldParentContent?: string;
 *   newParentContent?: string;
 * }} change
 */
export function isPackageImpactingChange(change) {
	const path = normalizeRepoPath(change.path);
	if (!isPackageImpactingPath(path)) {
		return false;
	}
	if (isRustTestOnlyPath(path)) {
		const newParentContent = change.newParentContent ?? "";
		const oldParentContent = change.oldParentContent ?? "";
		const parentContent = newParentContent.trim()
			? newParentContent
			: oldParentContent;
		return !hasCfgTestModuleDeclaration(parentContent);
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
		const parentPath = isRustTestOnlyPath(changedPath)
			? rustModulePathForTestsFile(changedPath)
			: "";
		const oldParentContent = parentPath
			? readGitBlob({
					cwd,
					execFileSync,
					ref: options.tagTarget,
					path: parentPath,
				})
			: undefined;
		const newParentContent = parentPath
			? readGitBlob({
					cwd,
					execFileSync,
					ref: headRef,
					path: parentPath,
				})
			: undefined;

		if (
			isPackageImpactingChange({
				path: changedPath,
				oldContent,
				newContent,
				oldParentContent,
				newParentContent,
			})
		) {
			return true;
		}
	}

	return false;
}
