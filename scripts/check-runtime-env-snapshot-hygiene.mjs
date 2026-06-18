#!/usr/bin/env node
/**
 * Ratchet against module-scope `defaultRuntimeEnv()` snapshots.
 *
 * `defaultRuntimeEnv()` is a compatibility bridge while callers migrate to
 * injected `RuntimeEnv`. It must not be captured at import time: bootstrap may
 * still need to load dotenv files, scrub repo-controlled security overrides,
 * and reset the snapshot before application code observes it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const srcRoot = resolve(repoRoot, "src");

const DEFAULT_RUNTIME_ENV_CALL_PATTERN = /\bdefaultRuntimeEnv\s*\(/;
const MODULE_SCOPE_CLASS_PATTERN =
	/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\b/;
const MODULE_SCOPE_ENUM_PATTERN = /^(?:export\s+)?(?:const\s+)?enum\b/;
const MODULE_SCOPE_NON_EXECUTABLE_PATTERN =
	/^(?:import\b|export\s+(?:\{|\*|type\b|interface\b|(?:async\s+)?function\b|class\b|enum\b)|(?:export\s+)?(?:type|interface|(?:async\s+)?function|class|enum)\b)/;

function isModuleScopeExecutableStatement(line) {
	if (line.trim().length === 0) return false;
	if (/^\s/.test(line)) return false;
	const trimmed = line.trimStart();
	if (trimmed.startsWith("//") || trimmed.startsWith("/*")) return false;
	if (trimmed.startsWith("}") || trimmed.startsWith(")")) return false;
	return !MODULE_SCOPE_NON_EXECUTABLE_PATTERN.test(trimmed);
}

function isLazyModuleScopeInitializer(statement) {
	return /^(?:export\s+)?(?:const|let|var)\s+[$A-Z_a-z][$\w]*(?:\s*:[\s\S]*?)?\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[$A-Z_a-z][$\w]*)(?:\s*:\s*[^=]+)?\s*=>)/.test(
		statement.trimStart(),
	) && !isImmediatelyInvokedFunctionInitializer(statement);
}

function isImmediatelyInvokedFunctionInitializer(statement) {
	const text = statement.replace(/\s+/g, " ").trim();
	return (
		/=\s*\(?\s*(?:async\s*)?function\b[\s\S]*\}\s*\)?\s*\(/.test(text) ||
		/=\s*\([\s\S]*=>[\s\S]*\)\s*\(/.test(text)
	);
}

function maskLazyRuntimeEnvReaders(statement) {
	return statement
		.replace(
			/=>\s*defaultRuntimeEnv\s*\([^)]*\)(?!\s*\)\s*\()/g,
			"=> __lazyRuntimeEnvRead",
		)
		.replace(
			/=>\s*\{[^{}]*defaultRuntimeEnv\s*\([^)]*\)[^{}]*\}(?!\s*\)\s*\()/g,
			"=> { __lazyRuntimeEnvRead }",
		)
		.replace(
			/function\b[^{]*\{[^{}]*defaultRuntimeEnv\s*\([^)]*\)[^{}]*\}(?!\s*\()/g,
			"function __lazyRuntimeEnvRead() {}",
		);
}

function hasEagerRuntimeEnvCall(statement) {
	if (!DEFAULT_RUNTIME_ENV_CALL_PATTERN.test(statement)) return false;
	if (isImmediatelyInvokedFunctionInitializer(statement)) return true;
	return DEFAULT_RUNTIME_ENV_CALL_PATTERN.test(
		maskLazyRuntimeEnvReaders(statement),
	);
}

function isLazyStaticInitializer(statement) {
	return /^\s*static\s+(?!\{)[\s\S]*?=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[$A-Z_a-z][$\w]*)(?:\s*:\s*[^=]+)?\s*=>)/.test(
		statement,
	) && !isImmediatelyInvokedFunctionInitializer(statement);
}

function hasEagerStaticComputedNameRuntimeEnvCall(statement) {
	const match = /\bstatic\s+(?:[$A-Z_a-z][$\w]*\s+)*\[([\s\S]*?)\]/.exec(
		statement,
	);
	return match ? DEFAULT_RUNTIME_ENV_CALL_PATTERN.test(match[1] ?? "") : false;
}

function collectDeclaration(lines, startIndex) {
	const collected = [];
	for (let index = startIndex; index < lines.length; index += 1) {
		collected.push(lines[index]);
		if (/;\s*(?:(?:\/\/).*)?$/.test(lines[index])) {
			break;
		}
	}
	return collected.join("\n");
}

function createSyntaxState(extra = {}) {
	return {
		blockComment: false,
		escaped: false,
		lastSignificant: "",
		openBraceCount: 0,
		quote: "",
		regex: false,
		regexCharClass: false,
		...extra,
	};
}

function isRegexLiteralStart(lastSignificant) {
	return lastSignificant === "" || /[([{,:;=!&|?+\-*%^~<>]/.test(lastSignificant);
}

function noteSignificantSyntax(state, char) {
	if (!/\s/.test(char)) {
		state.lastSignificant = char;
	}
}

function countSyntaxBraceDelta(line, state) {
	let delta = 0;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		const next = line[index + 1];
		if (state.blockComment) {
			if (char === "*" && next === "/") {
				state.blockComment = false;
				index += 1;
			}
			continue;
		}
		if (state.quote) {
			if (state.escaped) {
				state.escaped = false;
			} else if (char === "\\") {
				state.escaped = true;
			} else if (char === state.quote) {
				state.quote = "";
			}
			continue;
		}
		if (state.regex) {
			if (state.escaped) {
				state.escaped = false;
			} else if (char === "\\") {
				state.escaped = true;
			} else if (char === "[") {
				state.regexCharClass = true;
			} else if (char === "]" && state.regexCharClass) {
				state.regexCharClass = false;
			} else if (char === "/" && !state.regexCharClass) {
				state.regex = false;
				noteSignificantSyntax(state, char);
			}
			continue;
		}
		if (char === "/" && next === "/") {
			break;
		}
		if (char === "/" && next === "*") {
			state.blockComment = true;
			index += 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			state.quote = char;
			continue;
		}
		if (char === "/" && isRegexLiteralStart(state.lastSignificant)) {
			state.regex = true;
			state.regexCharClass = false;
			state.escaped = false;
			continue;
		}
		if (char === "{") {
			delta += 1;
			state.openBraceCount = (state.openBraceCount ?? 0) + 1;
		} else if (char === "}") {
			delta -= 1;
		}
		noteSignificantSyntax(state, char);
	}
	return delta;
}

function hasSyntaxOpeningBrace(line) {
	const braceState = createSyntaxState();
	countSyntaxBraceDelta(line, braceState);
	return (braceState.openBraceCount ?? 0) > 0;
}

function collectModuleScopeStatement(lines, startIndex) {
	const collected = [];
	const braceState = createSyntaxState();
	let depth = 0;
	let opened = false;
	for (let index = startIndex; index < lines.length; index += 1) {
		const line = lines[index];
		collected.push(line);
		const openBraceCount = braceState.openBraceCount ?? 0;
		const delta = countSyntaxBraceDelta(line, braceState);
		if ((braceState.openBraceCount ?? 0) > openBraceCount) {
			opened = true;
		}
		depth += delta;
		if (opened) {
			if (depth <= 0) {
				break;
			}
			continue;
		}
		if (/;\s*(?:(?:\/\/).*)?$/.test(line)) {
			break;
		}
	}
	return collected.join("\n");
}

function collectClassBlock(lines, startIndex) {
	const collected = [];
	let depth = 0;
	let opened = false;
	const braceState = createSyntaxState();
	for (let index = startIndex; index < lines.length; index += 1) {
		const line = lines[index];
		collected.push(line);
		const openBraceCount = braceState.openBraceCount ?? 0;
		const delta = countSyntaxBraceDelta(line, braceState);
		if ((braceState.openBraceCount ?? 0) > openBraceCount) {
			opened = true;
		}
		depth += delta;
		if (opened && depth <= 0) {
			break;
		}
	}
	return collected;
}

function findClassBodyOpenBrace(line, state) {
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		const next = line[index + 1];
		if (state.blockComment) {
			if (char === "*" && next === "/") {
				state.blockComment = false;
				index += 1;
			}
			continue;
		}
		if (state.quote) {
			if (state.escaped) {
				state.escaped = false;
			} else if (char === "\\") {
				state.escaped = true;
			} else if (char === state.quote) {
				state.quote = "";
			}
			continue;
		}
		if (state.regex) {
			if (state.escaped) {
				state.escaped = false;
			} else if (char === "\\") {
				state.escaped = true;
			} else if (char === "[") {
				state.regexCharClass = true;
			} else if (char === "]" && state.regexCharClass) {
				state.regexCharClass = false;
			} else if (char === "/" && !state.regexCharClass) {
				state.regex = false;
				noteSignificantSyntax(state, char);
			}
			continue;
		}
		if (char === "/" && next === "/") {
			break;
		}
		if (char === "/" && next === "*") {
			state.blockComment = true;
			index += 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			state.quote = char;
			continue;
		}
		if (char === "/" && isRegexLiteralStart(state.lastSignificant)) {
			state.regex = true;
			state.regexCharClass = false;
			state.escaped = false;
			continue;
		}
		if (char === "(") {
			state.parenDepth += 1;
			noteSignificantSyntax(state, char);
			continue;
		}
		if (char === ")" && state.parenDepth > 0) {
			state.parenDepth -= 1;
			noteSignificantSyntax(state, char);
			continue;
		}
		if (char === "[") {
			state.bracketDepth += 1;
			noteSignificantSyntax(state, char);
			continue;
		}
		if (char === "]" && state.bracketDepth > 0) {
			state.bracketDepth -= 1;
			noteSignificantSyntax(state, char);
			continue;
		}
		if (char === "{" && state.parenDepth === 0 && state.bracketDepth === 0) {
			return index;
		}
		noteSignificantSyntax(state, char);
	}
	return -1;
}

function collectClassHeader(lines, startIndex) {
	const collected = [];
	const headerState = createSyntaxState({
		bracketDepth: 0,
		parenDepth: 0,
	});
	for (let index = startIndex; index < lines.length; index += 1) {
		const line = lines[index];
		const openBraceIndex = findClassBodyOpenBrace(line, headerState);
		if (openBraceIndex >= 0) {
			collected.push(line.slice(0, openBraceIndex + 1));
			break;
		}
		collected.push(line);
	}
	return collected.join("\n");
}

function findClassHeaderRuntimeEnvSnapshots(lines, startIndex, rel, findings) {
	const header = collectClassHeader(lines, startIndex);
	if (!DEFAULT_RUNTIME_ENV_CALL_PATTERN.test(header)) return;
	findings.push({
		file: rel,
		line: startIndex + 1,
		text: header.replace(/\s+/g, " ").trim(),
	});
}

function collectStaticBlock(lines, startIndex) {
	const collected = [];
	let depth = 0;
	let opened = false;
	const braceState = createSyntaxState();
	for (let index = startIndex; index < lines.length; index += 1) {
		const line = lines[index];
		collected.push(line);
		const openBraceCount = braceState.openBraceCount ?? 0;
		const delta = countSyntaxBraceDelta(line, braceState);
		if ((braceState.openBraceCount ?? 0) > openBraceCount) {
			opened = true;
		}
		depth += delta;
		if (opened && depth <= 0) {
			break;
		}
	}
	return collected.join("\n");
}

function findStaticRuntimeEnvSnapshots(lines, startIndex, rel, findings) {
	const block = collectClassBlock(lines, startIndex);
		for (const [offset, line] of block.entries()) {
			if (!/\bstatic\b/.test(line)) continue;
			const statement = hasSyntaxOpeningBrace(line)
				? collectStaticBlock(block, offset)
				: collectDeclaration(block, offset);
			const text = statement.replace(/\s+/g, " ").trim();
			const hasEagerComputedName =
				hasEagerStaticComputedNameRuntimeEnvCall(statement);
			if (!hasEagerComputedName && !/\bstatic\s*(?:\{|[^()=]+=)/.test(text)) {
				continue;
			}
			if (!hasEagerComputedName && isLazyStaticInitializer(statement)) continue;
			if (!hasEagerComputedName && !hasEagerRuntimeEnvCall(statement)) continue;
			findings.push({
				file: rel,
				line: startIndex + offset + 1,
			text,
		});
	}
}

function findEnumRuntimeEnvSnapshots(lines, startIndex, rel, findings) {
	const block = collectClassBlock(lines, startIndex);
	const statement = block.join("\n");
	if (!DEFAULT_RUNTIME_ENV_CALL_PATTERN.test(statement)) return;
	findings.push({
		file: rel,
		line: startIndex + 1,
		text: statement.replace(/\s+/g, " ").trim(),
	});
}

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const full = resolve(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (
			st.isFile() &&
			(name.endsWith(".ts") || name.endsWith(".tsx")) &&
			!name.endsWith(".d.ts")
		) {
			yield full;
		}
	}
}

export function scanRuntimeEnvSnapshotHygiene(root = srcRoot) {
	const findings = [];
	for (const absPath of walk(root)) {
		const rel = relative(repoRoot, absPath);
		const lines = readFileSync(absPath, "utf-8").split(/\r?\n/);
		for (const [index, line] of lines.entries()) {
			const isModuleScopeLine = line.trim().length > 0 && !/^\s/.test(line);
			if (isModuleScopeLine && MODULE_SCOPE_CLASS_PATTERN.test(line.trimStart())) {
				findClassHeaderRuntimeEnvSnapshots(lines, index, rel, findings);
				findStaticRuntimeEnvSnapshots(lines, index, rel, findings);
				continue;
			}
			if (isModuleScopeLine && MODULE_SCOPE_ENUM_PATTERN.test(line.trimStart())) {
				findEnumRuntimeEnvSnapshots(lines, index, rel, findings);
				continue;
			}
			if (!isModuleScopeExecutableStatement(line)) continue;
			const statement = collectModuleScopeStatement(lines, index);
			if (isLazyModuleScopeInitializer(statement)) continue;
			if (!hasEagerRuntimeEnvCall(statement)) continue;
			findings.push({
				file: rel,
				line: index + 1,
				text: statement.replace(/\s+/g, " ").trim(),
			});
		}
	}
	return findings;
}

function main() {
	const findings = scanRuntimeEnvSnapshotHygiene();
	if (findings.length === 0) {
		console.log("✓ No module-scope defaultRuntimeEnv() snapshots in src/");
		return;
	}

	console.error(
		"\n✗ Module-scope defaultRuntimeEnv() snapshots detected in src/.\n",
	);
	console.error(
		"Move the read behind an explicit bootstrap boundary or inject RuntimeEnv from the caller:\n",
	);
	for (const finding of findings) {
		console.error(`  ${finding.file}:${finding.line}`);
		console.error(`    ${finding.text}`);
	}
	console.error("");
	process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
