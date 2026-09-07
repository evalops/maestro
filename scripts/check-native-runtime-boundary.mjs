#!/usr/bin/env node

/**
 * Check the native Maestro agent ownership and crate dependency boundary.
 *
 * Cargo metadata is the source of truth for dependency edges. The Rust scan is
 * intentionally narrow: it finds production `struct`, `type`, and `impl`
 * declarations for the two native agent types while masking comments, string
 * literals, and `#[cfg(test)]` modules. This guard does not claim to verify
 * tool policy, authorization, or privileged execution semantics.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_PACKAGE = "maestro-runtime";
const CONTRACTS_PACKAGE = "maestro-runtime-contracts";
const TUI_PACKAGE = "maestro-tui";
const AI_PACKAGE = "maestro-ai";
const FORBIDDEN_RUNTIME_PACKAGES = new Set([
	"maestro-tui",
	"maestro-ui",
	"ratatui",
]);
const FORBIDDEN_CONTRACT_PACKAGES = new Set([RUNTIME_PACKAGE, AI_PACKAGE]);
const DRIVER_METHODS = new Set(["run", "run_loop", "run_loop_inner"]);
const RUST_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SKIPPED_DIRECTORY_NAMES = new Set([
	".git",
	"target",
	"node_modules",
	"dist",
	"coverage",
	"tests",
	"testdata",
	"fixtures",
	"benches",
	"examples",
]);
const SKIPPED_SOURCE_FILE_NAMES = new Set(["test.rs", "tests.rs"]);

/** @param {string} name */
function canonicalPackageName(name) {
	return name.trim().replaceAll("_", "-");
}

/** @param {string} name */
function crateImportName(name) {
	return canonicalPackageName(name).replaceAll("-", "_");
}

/** @param {string} root @param {string} path */
function relativePath(root, path) {
	return relative(root, path).split(sep).join("/");
}

/**
 * Ask Cargo to resolve the workspace and return its own dependency records.
 * A checked-in lockfile gets a normal locked resolve, which includes the
 * transitive registry graph. Temporary fixtures without a lockfile use
 * `--no-deps`; their path dependency graph is still complete and keeps tests
 * offline.
 *
 * @param {string} root
 */
function cargoMetadata(root) {
	const manifestPath = resolve(root, "Cargo.toml");
	if (!existsSync(manifestPath)) {
		throw new Error(`Cargo manifest is missing: ${manifestPath}`);
	}
	const hasLockfile = existsSync(resolve(root, "Cargo.lock"));
	const args = ["metadata", "--format-version=1"];
	if (hasLockfile) args.push("--locked");
	else args.push("--no-deps");
	args.push("--manifest-path", manifestPath);
	const result = spawnSync(
		"cargo",
		args,
		{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const details = (result.stderr || result.stdout || "").trim();
		throw new Error(`cargo metadata failed${details ? `: ${details}` : ""}`);
	}
	try {
		return { metadata: JSON.parse(result.stdout), mode: hasLockfile ? "cargo-metadata-resolved" : "cargo-metadata-no-deps" };
	} catch (error) {
		throw new Error(
			`cargo metadata returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** @param {string} directory */
function rustFiles(directory) {
	if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
		if (
			SKIPPED_SOURCE_FILE_NAMES.has(entry.name) ||
			entry.name.endsWith("_test.rs") ||
			entry.name.endsWith("_tests.rs")
		) continue;
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...rustFiles(path));
		else if (entry.isFile() && extname(entry.name) === ".rs") files.push(path);
	}
	return files.sort();
}

/** @typedef {{ value: string, line: number }} Token */
/** @typedef {{ kind: "struct" | "type" | "impl", name: string, line: number, tokenIndex: number, bodyStart: number | null, bodyEnd: number | null, methods: MethodDefinition[] }} Definition */
/** @typedef {{ name: string, line: number, hasLoop: boolean }} MethodDefinition */
/** @typedef {{ path: string, tokens: Token[], definitions: Definition[] }} SourceFile */
/** @typedef {{ requestedName: string, packageName: string, packageId?: string, line?: number, path: string | null, manifestPath: string | null, workspace: boolean }} Dependency */
/** @typedef {{ id: string, packageName: string, manifestPath: string, packageRoot: string, isWorkspaceMember: boolean, dependencies: Dependency[], files: SourceFile[], definitions: Definition[] }} PackageInfo */

/**
 * Tokenize enough Rust syntax to distinguish code from comments and literals.
 * Rust block comments nest, and raw strings may contain arbitrary braces or
 * names, so a plain regular expression over source text is not sufficient.
 *
 * @param {string} source
 * @returns {Token[]}
 */
function tokenizeRust(source) {
	const tokens = [];
	let index = 0;
	let line = 1;
	const push = (value) => tokens.push({ value, line });

	const skipQuoted = (start, quote) => {
		let cursor = start + 1;
		let escaped = false;
		while (cursor < source.length) {
			const character = source[cursor];
			if (character === "\n") line += 1;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) {
				cursor += 1;
				break;
			}
			cursor += 1;
		}
		index = cursor;
	};

	const skipRawString = (start, hashCount, prefixLength) => {
		const close = `"${"#".repeat(hashCount)}`;
		let cursor = start + prefixLength;
		while (cursor < source.length) {
			if (source.startsWith(close, cursor)) {
				cursor += close.length;
				break;
			}
			if (source[cursor] === "\n") line += 1;
			cursor += 1;
		}
		index = cursor;
	};

	while (index < source.length) {
		const character = source[index];
		if (/\s/u.test(character)) {
			if (character === "\n") line += 1;
			index += 1;
			continue;
		}
		if (source.startsWith("//", index)) {
			const end = source.indexOf("\n", index + 2);
			index = end === -1 ? source.length : end;
			continue;
		}
		if (source.startsWith("/*", index)) {
			let cursor = index + 2;
			let depth = 1;
			while (cursor < source.length && depth > 0) {
				if (source.startsWith("/*", cursor)) {
					depth += 1;
					cursor += 2;
				} else if (source.startsWith("*/", cursor)) {
					depth -= 1;
					cursor += 2;
				} else {
					if (source[cursor] === "\n") line += 1;
					cursor += 1;
				}
			}
			index = cursor;
			continue;
		}

		const raw = source.slice(index).match(/^(?:r|br|rb)(#{0,255})"/u);
		if (raw) {
			skipRawString(index, raw[1].length, raw[0].length);
			continue;
		}
		if (character === '"' || character === "'") {
			const lifetime =
				source.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/u)?.[0] ?? "";
			const lifetimeEnd = index + 1 + lifetime.length;
			if (character === "'" && lifetime && source[lifetimeEnd] !== "'") {
				push(character);
				index += 1;
				continue;
			}
			skipQuoted(index, character);
			continue;
		}
		if (
			(character === "b" || character === "c") &&
			source[index + 1] === '"'
		) {
			skipQuoted(index + 1, '"');
			continue;
		}
		if (character === "b" && source[index + 1] === "'") {
			skipQuoted(index + 1, "'");
			continue;
		}
		if (/[A-Za-z_]/u.test(character)) {
			const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
			push(match[0]);
			index += match[0].length;
			continue;
		}
		push(character);
		index += 1;
	}
	return tokens;
}

/** @param {Token[]} tokens @param {number} start @param {string} open @param {string} close */
function matchingBrace(tokens, start, open = "{", close = "}") {
	let depth = 0;
	for (let index = start; index < tokens.length; index += 1) {
		if (tokens[index].value === open) depth += 1;
		else if (tokens[index].value === close) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return null;
}

/** @param {Token[]} tokens */
function testOnlyTokens(tokens) {
	const excluded = new Set();
	for (let index = 0; index < tokens.length; index += 1) {
		if (tokens[index].value !== "#" || tokens[index + 1]?.value !== "[") continue;
		let cursor = index + 2;
		let depth = 1;
		let hasCfg = false;
		let hasTest = false;
		for (; cursor < tokens.length && depth > 0; cursor += 1) {
			if (tokens[cursor].value === "[") depth += 1;
			else if (tokens[cursor].value === "]") depth -= 1;
			else if (tokens[cursor].value === "cfg") hasCfg = true;
			else if (tokens[cursor].value === "test") hasTest = true;
		}
		if (!hasCfg || !hasTest || tokens[cursor]?.value !== "mod") continue;
		while (cursor < tokens.length && tokens[cursor].value !== "{") cursor += 1;
		const end = cursor < tokens.length ? matchingBrace(tokens, cursor) : null;
		if (end === null) continue;
		for (let token = index; token <= end; token += 1) excluded.add(token);
		index = end;
	}
	return excluded;
}

/** @param {Token[]} tokens @param {number} start */
function implTarget(tokens, start) {
	let index = start + 1;
	if (tokens[index]?.value === "<") {
		const end = matchingBrace(tokens, index, "<", ">");
		if (end === null) return null;
		index = end + 1;
	}
	let first = null;
	for (; index < tokens.length && tokens[index].value !== "{" && tokens[index].value !== ";"; index += 1) {
		if (tokens[index].value === "for") {
			for (index += 1; index < tokens.length && tokens[index].value !== "{"; index += 1) {
				if (RUST_IDENTIFIER.test(tokens[index].value)) return tokens[index].value;
			}
			return null;
		}
		if (!first && RUST_IDENTIFIER.test(tokens[index].value)) first = tokens[index].value;
	}
	return first;
}

/** @param {Token[]} tokens @param {number} start @param {number} end */
function methodDefinitions(tokens, start, end) {
	const methods = [];
	for (let index = start; index < end; index += 1) {
		if (tokens[index].value !== "fn" || !RUST_IDENTIFIER.test(tokens[index + 1]?.value ?? "")) continue;
		const name = tokens[index + 1].value;
		let bodyStart = index + 2;
		while (bodyStart < end && tokens[bodyStart].value !== "{" && tokens[bodyStart].value !== ";") bodyStart += 1;
		const bodyEnd = tokens[bodyStart]?.value === "{" ? matchingBrace(tokens, bodyStart) : null;
		const scanEnd = bodyEnd === null ? bodyStart : bodyEnd;
		const hasLoop = tokens.slice(bodyStart, scanEnd + 1).some((token) => token.value === "loop" || token.value === "while");
		methods.push({ name, line: tokens[index].line, hasLoop });
		if (bodyEnd !== null) index = bodyEnd;
	}
	return methods;
}

/** @param {Token[]} tokens */
function scanRust(tokens) {
	const excluded = testOnlyTokens(tokens);
	const definitions = [];
	for (let index = 0; index < tokens.length; index += 1) {
		if (excluded.has(index)) continue;
		const value = tokens[index].value;
		if (
			(value === "struct" || value === "type") &&
			RUST_IDENTIFIER.test(tokens[index + 1]?.value ?? "")
		) {
			const bodyStart = tokens[index + 2]?.value === "{" ? index + 2 : null;
			definitions.push({
				kind: value,
				name: tokens[index + 1].value,
				line: tokens[index].line,
				tokenIndex: index,
				bodyStart,
				bodyEnd: bodyStart === null ? null : matchingBrace(tokens, bodyStart),
				methods: [],
			});
			continue;
		}
		if (value !== "impl") continue;
		const name = implTarget(tokens, index);
		if (!name) continue;
		let bodyStart = index + 1;
		while (bodyStart < tokens.length && tokens[bodyStart].value !== "{" && tokens[bodyStart].value !== ";") bodyStart += 1;
		const bodyEnd = tokens[bodyStart]?.value === "{" ? matchingBrace(tokens, bodyStart) : null;
		definitions.push({
			kind: "impl",
			name,
			line: tokens[index].line,
			tokenIndex: index,
			bodyStart: tokens[bodyStart]?.value === "{" ? bodyStart : null,
			bodyEnd,
			methods: bodyEnd === null ? [] : methodDefinitions(tokens, bodyStart + 1, bodyEnd),
		});
	}
	return definitions;
}

/**
 * Build package records from Cargo's metadata. Dependency `rename` is kept as
 * the requested name so aliased crate imports remain visible to the guard.
 *
 * @param {string} root
 */
function buildWorkspace(root) {
	const { metadata, mode } = cargoMetadata(root);
	if (!Array.isArray(metadata.packages)) throw new Error("cargo metadata has no packages array");
	const workspaceMemberIds = new Set(
		Array.isArray(metadata.workspace_members) ? metadata.workspace_members : [],
	);
	const packageMetadata = new Map();
	for (const packageEntry of metadata.packages) {
		if (
			!packageEntry ||
			typeof packageEntry.id !== "string" ||
			typeof packageEntry.name !== "string" ||
			typeof packageEntry.manifest_path !== "string"
		) continue;
		packageMetadata.set(packageEntry.id, packageEntry);
	}
	const packages = new Map();
	const packagesByManifest = new Map();
	const packagesById = new Map();
	const resolvedNodes = new Map(
		Array.isArray(metadata.resolve?.nodes)
			? metadata.resolve.nodes.filter((node) => typeof node?.id === "string").map((node) => [node.id, node])
			: [],
	);
	for (const packageEntry of packageMetadata.values()) {
		const manifestPath = resolve(packageEntry.manifest_path);
		const files = workspaceMemberIds.has(packageEntry.id)
			? rustFiles(resolve(dirname(manifestPath), "src")).map((path) => {
					const tokens = tokenizeRust(readFileSync(path, "utf8"));
					return { path, tokens, definitions: scanRust(tokens) };
				})
			: [];
		const packageInfo = {
			id: packageEntry.id,
			packageName: packageEntry.name,
			manifestPath,
			packageRoot: dirname(manifestPath),
			isWorkspaceMember: workspaceMemberIds.has(packageEntry.id),
			dependencies: [],
			files,
			definitions: files.flatMap((file) => file.definitions),
		};
		if (!packages.has(canonicalPackageName(packageEntry.name))) {
			packages.set(canonicalPackageName(packageEntry.name), packageInfo);
		}
		packagesByManifest.set(manifestPath, packageInfo);
		packagesById.set(packageEntry.id, packageInfo);
	}

	for (const packageEntry of packageMetadata.values()) {
		const packageInfo = packagesById.get(packageEntry.id);
		if (!packageInfo) continue;
		const addDependency = (dependency) => {
			const duplicate = packageInfo.dependencies.some((existing) =>
				(existing.packageId && dependency.packageId && existing.packageId === dependency.packageId) ||
				(!existing.packageId && !dependency.packageId &&
					canonicalPackageName(existing.packageName) === canonicalPackageName(dependency.packageName) &&
					existing.requestedName === dependency.requestedName),
			);
			if (!duplicate) packageInfo.dependencies.push(dependency);
		};
		const resolvedNode = resolvedNodes.get(packageEntry.id);
		if (resolvedNode && Array.isArray(resolvedNode.deps)) {
			for (const dependencyEntry of resolvedNode.deps) {
				if (!dependencyEntry || typeof dependencyEntry.pkg !== "string") continue;
				const child = packagesById.get(dependencyEntry.pkg);
				const childName = child?.packageName ?? dependencyEntry.name;
				if (typeof childName !== "string") continue;
				addDependency({
					requestedName: typeof dependencyEntry.name === "string" ? dependencyEntry.name : childName,
					packageName: childName,
					packageId: dependencyEntry.pkg,
					path: child?.packageRoot ?? null,
					manifestPath: child?.manifestPath ?? null,
					workspace: child?.isWorkspaceMember ?? false,
				});
			}
		}
		for (const dependencyEntry of Array.isArray(packageEntry.dependencies) ? packageEntry.dependencies : []) {
			if (!dependencyEntry || typeof dependencyEntry.name !== "string") continue;
			const dependencyPath = typeof dependencyEntry.path === "string" ? resolve(dependencyEntry.path) : null;
			const childManifestPath = dependencyPath ? resolve(dependencyPath, "Cargo.toml") : null;
			const child = childManifestPath ? packagesByManifest.get(childManifestPath) : null;
			addDependency({
				requestedName: typeof dependencyEntry.rename === "string" ? dependencyEntry.rename : dependencyEntry.name,
				packageName: child?.packageName ?? dependencyEntry.name,
				packageId: child?.id,
				path: dependencyPath,
				manifestPath: childManifestPath,
				workspace: dependencyEntry.source === null,
			});
		}
	}
	return { root, packages, packagesByManifest, packagesById, metadata, mode };
}

/** @param {Map<string, PackageInfo>} packages @param {Map<string, PackageInfo>} byManifest @param {Map<string, PackageInfo>} byId @param {Dependency} dependency */
function dependencyPackage(packages, byManifest, byId, dependency) {
	return (dependency.packageId && byId.get(dependency.packageId)) ||
		(dependency.manifestPath && byManifest.get(resolve(dependency.manifestPath))) ||
		packages.get(canonicalPackageName(dependency.packageName)) ||
		null;
}

/**
 * @param {PackageInfo} start
 * @param {ReturnType<typeof buildWorkspace>} workspace
 * @param {Set<string>} forbidden
 */
function dependencyViolations(start, workspace, forbidden) {
	const violations = [];
	const visited = new Set();
	const walk = (packageInfo, path) => {
		const packageKey = packageInfo.id ?? packageInfo.manifestPath;
		if (visited.has(packageKey)) return;
		visited.add(packageKey);
		for (const dependency of packageInfo.dependencies) {
			const canonical = canonicalPackageName(dependency.packageName);
			const nextPath = [...path, canonical];
			if (forbidden.has(canonical)) violations.push({ path: nextPath, dependency });
			const child = dependencyPackage(workspace.packages, workspace.packagesByManifest, workspace.packagesById, dependency);
			if (!child) continue;
			walk(child, nextPath);
		}
	};
	walk(start, [canonicalPackageName(start.packageName)]);
	return violations;
}

/** @param {PackageInfo} packageInfo @param {string} root */
function packageDefinitions(packageInfo, root) {
	return packageInfo.files.flatMap((file) =>
		file.definitions.map((definition) => ({
			...definition,
			path: relativePath(root, file.path),
		})),
	);
}

/** @param {PackageInfo} packageInfo @param {Set<string>} packageNames @param {string} root */
function sourcePackageEdges(packageInfo, packageNames, root) {
	const edges = [];
	for (const file of packageInfo.files) {
		for (let index = 0; index < file.tokens.length - 2; index += 1) {
			const token = file.tokens[index];
			if (!RUST_IDENTIFIER.test(token.value) || file.tokens[index + 1].value !== ":" || file.tokens[index + 2]?.value !== ":") continue;
			if (packageNames.has(canonicalPackageName(token.value))) {
				edges.push({ packageName: token.value, path: relativePath(root, file.path), line: token.line });
			}
		}
	}
	return edges;
}

/** @param {Token[]} tokens @param {number} start @param {number} end @param {Set<string>} names */
function hasNativeAgentPath(tokens, start, end, names) {
	for (let index = start; index < end - 2; index += 1) {
		if (!names.has(tokens[index].value)) continue;
		for (let cursor = index + 1; cursor < end; cursor += 1) {
			if ([";", ",", "{", "}"].includes(tokens[cursor].value)) break;
			if (tokens[cursor].value === "NativeAgent" && tokens[cursor - 2]?.value === ":" && tokens[cursor - 1]?.value === ":") return true;
		}
	}
	return false;
}

/**
 * Find evidence that a TUI NativeAgent declaration carries the runtime
 * NativeAgent handle. The import alias must specifically come from a
 * `NativeAgent` import, so an unrelated runtime telemetry type cannot satisfy
 * this check by name alone.
 *
 * @param {PackageInfo} tui
 * @param {string} root
 */
function runtimeHandleEvidence(tui, root) {
	const runtimeNames = new Set([crateImportName(RUNTIME_PACKAGE)]);
	for (const dependency of tui.dependencies) {
		if (canonicalPackageName(dependency.packageName) === RUNTIME_PACKAGE) {
			runtimeNames.add(crateImportName(dependency.requestedName));
		}
	}
	for (const file of tui.files) {
		const handleAliases = new Set();
		for (let index = 0; index < file.tokens.length; index += 1) {
			if (file.tokens[index].value !== "use") continue;
			let end = index + 1;
			while (end < file.tokens.length && file.tokens[end].value !== ";") end += 1;
			if (!runtimeNames.has(file.tokens[index + 1]?.value ?? "")) {
				index = end;
				continue;
			}
			let nativeImport = false;
			for (let cursor = index + 1; cursor < end; cursor += 1) {
				if (file.tokens[cursor].value === "NativeAgent") nativeImport = true;
				if (file.tokens[cursor].value === ",") nativeImport = false;
				if (nativeImport && file.tokens[cursor].value === "as" && RUST_IDENTIFIER.test(file.tokens[cursor + 1]?.value ?? "")) {
					handleAliases.add(file.tokens[cursor + 1].value);
				}
			}
			index = end;
		}
		for (const definition of file.definitions.filter((candidate) => candidate.name === "NativeAgent")) {
			const end = definition.bodyEnd ?? (() => {
				let cursor = definition.tokenIndex;
				while (cursor < file.tokens.length && file.tokens[cursor].value !== ";") cursor += 1;
				return cursor;
			})();
			if (
				hasNativeAgentPath(file.tokens, definition.tokenIndex, end, runtimeNames) ||
				file.tokens.slice(definition.tokenIndex, end).some((token) => handleAliases.has(token.value))
			) {
				return { path: relativePath(root, file.path), line: definition.line };
			}
		}
	}
	return null;
}

/** @typedef {{ code: string, message: string, path?: string, line?: number }} Violation */

/** @param {string} root */
export function analyzeNativeRuntimeBoundary(root = SCRIPT_ROOT) {
	const absoluteRoot = resolve(root);
	const workspace = buildWorkspace(absoluteRoot);
	const violations = [];
	const runtime = workspace.packages.get(RUNTIME_PACKAGE);
	const contracts = workspace.packages.get(CONTRACTS_PACKAGE);
	const tui = workspace.packages.get(TUI_PACKAGE);

	if (!runtime) violations.push({ code: "missing-runtime-package", message: "workspace is missing maestro-runtime" });
	if (!contracts) violations.push({ code: "missing-contracts-package", message: "workspace is missing maestro-runtime-contracts" });
	if (!tui) violations.push({ code: "missing-tui-package", message: "workspace is missing maestro-tui" });

	if (runtime) {
		const definitions = packageDefinitions(runtime, absoluteRoot);
		const agentStructs = definitions.filter((definition) => definition.kind === "struct" && definition.name === "NativeAgent");
		const runnerStructs = definitions.filter((definition) => definition.kind === "struct" && definition.name === "NativeAgentRunner");
		const agentImpls = definitions.filter((definition) => definition.kind === "impl" && definition.name === "NativeAgent");
		const runnerImpls = definitions.filter((definition) => definition.kind === "impl" && definition.name === "NativeAgentRunner");
		const runtimePath = relativePath(absoluteRoot, runtime.manifestPath);
		if (agentStructs.length === 0) violations.push({ code: "runtime-missing-native-agent", message: "maestro-runtime must define NativeAgent in production Rust", path: runtimePath });
		if (runnerStructs.length === 0) violations.push({ code: "runtime-missing-native-agent-runner", message: "maestro-runtime must define NativeAgentRunner in production Rust", path: runtimePath });
		if (agentImpls.length === 0) violations.push({ code: "runtime-missing-native-agent-impl", message: "maestro-runtime must implement NativeAgent", path: runtimePath });
		if (runnerImpls.length === 0) violations.push({ code: "runtime-missing-runner-impl", message: "maestro-runtime must implement NativeAgentRunner", path: runtimePath });
		const driverMethods = runnerImpls.flatMap((definition) => definition.methods).filter((method) => DRIVER_METHODS.has(method.name));
		if (driverMethods.length === 0) violations.push({ code: "runtime-missing-runner-driver", message: "NativeAgentRunner must expose run or run_loop in maestro-runtime", path: runtimePath });

		for (const edge of dependencyViolations(runtime, workspace, FORBIDDEN_RUNTIME_PACKAGES)) {
			const alias = edge.dependency.requestedName !== edge.dependency.packageName ? ` requested as ${edge.dependency.requestedName}` : "";
			violations.push({
				code: "runtime-forbidden-dependency",
				message: `maestro-runtime reaches forbidden package ${edge.dependency.packageName}${alias} through ${edge.path.join(" -> ")} (aliases and transitive dependencies are forbidden)`,
				path: runtimePath,
				line: edge.dependency.line,
			});
		}
		for (const edge of sourcePackageEdges(runtime, FORBIDDEN_RUNTIME_PACKAGES, absoluteRoot)) {
			violations.push({ code: "runtime-forbidden-source-import", message: `maestro-runtime source imports forbidden crate ${edge.packageName}`, path: edge.path, line: edge.line });
		}
	}

	if (contracts) {
		const contractsPath = relativePath(absoluteRoot, contracts.manifestPath);
		for (const edge of dependencyViolations(contracts, workspace, FORBIDDEN_CONTRACT_PACKAGES)) {
			const alias = edge.dependency.requestedName !== edge.dependency.packageName ? ` requested as ${edge.dependency.requestedName}` : "";
			violations.push({
				code: "contracts-backedge",
				message: `runtime contracts reach ${edge.dependency.packageName}${alias} through ${edge.path.join(" -> ")} (contracts must remain dependency-light)`,
				path: contractsPath,
				line: edge.dependency.line,
			});
		}
		for (const edge of sourcePackageEdges(contracts, FORBIDDEN_CONTRACT_PACKAGES, absoluteRoot)) {
			violations.push({ code: "contracts-backedge-source-import", message: `runtime contracts source imports forbidden crate ${edge.packageName}`, path: edge.path, line: edge.line });
		}
	}

	if (tui) {
		const definitions = packageDefinitions(tui, absoluteRoot);
		for (const definition of definitions.filter((candidate) => ["struct", "type", "impl"].includes(candidate.kind) && candidate.name === "NativeAgentRunner")) {
			violations.push({ code: "tui-owns-native-agent-runner", message: `maestro-tui contains a NativeAgentRunner ${definition.kind}; the native runner must live in maestro-runtime`, path: definition.path, line: definition.line });
		}
		const agentDefinitions = definitions.filter((candidate) => ["struct", "type", "impl"].includes(candidate.kind) && candidate.name === "NativeAgent");
		if (agentDefinitions.length > 0 && !runtimeHandleEvidence(tui, absoluteRoot)) {
			for (const definition of agentDefinitions) {
				violations.push({ code: "tui-owns-native-agent", message: "maestro-tui NativeAgent must delegate to the runtime handle", path: definition.path, line: definition.line });
			}
		}
	}

	const runnerOwners = [];
	for (const packageInfo of workspace.packages.values()) {
		if (packageDefinitions(packageInfo, absoluteRoot).some((definition) => definition.kind === "struct" && definition.name === "NativeAgentRunner")) runnerOwners.push(packageInfo);
	}
	if (runnerOwners.length > 1) {
		violations.push({ code: "duplicate-native-runner-owner", message: `NativeAgentRunner has ${runnerOwners.length} production owners: ${runnerOwners.map((owner) => owner.packageName).join(", ")}` });
	}
	for (const packageInfo of workspace.packages.values()) {
		if (packageInfo === runtime || packageInfo === tui) continue;
		for (const definition of packageDefinitions(packageInfo, absoluteRoot).filter((candidate) => ["struct", "type"].includes(candidate.kind) && candidate.name === "NativeAgent")) {
			violations.push({ code: "unexpected-native-agent-owner", message: `${packageInfo.packageName} defines NativeAgent outside the approved runtime or TUI wrapper locations`, path: definition.path, line: definition.line });
		}
		for (const definition of packageDefinitions(packageInfo, absoluteRoot).filter((candidate) => ["struct", "type"].includes(candidate.kind) && candidate.name === "NativeAgentRunner")) {
			violations.push({ code: "unexpected-native-runner-owner", message: `${packageInfo.packageName} defines NativeAgentRunner outside maestro-runtime`, path: definition.path, line: definition.line });
		}
	}

	return {
		schemaVersion: "evalops.maestro.native-runtime-boundary.v1",
		ok: violations.length === 0,
		root: absoluteRoot,
		metadata: {
			packageCount: workspace.packages.size,
			workspacePackageCount: [...workspace.packages.values()].filter((packageInfo) => packageInfo.isWorkspaceMember).length,
			mode: workspace.mode,
		},
		violations,
		owners: {
			nativeAgent: runtime ? packageDefinitions(runtime, absoluteRoot).filter((definition) => definition.kind === "struct" && definition.name === "NativeAgent").map((definition) => ({ package: runtime.packageName, path: definition.path, line: definition.line })) : [],
			nativeAgentRunner: runtime ? packageDefinitions(runtime, absoluteRoot).filter((definition) => definition.kind === "struct" && definition.name === "NativeAgentRunner").map((definition) => ({ package: runtime.packageName, path: definition.path, line: definition.line })) : [],
		},
	};
}

/** @param {ReturnType<typeof analyzeNativeRuntimeBoundary>} report */
export function formatNativeRuntimeBoundaryReport(report) {
	if (report.ok) return "Native Maestro runtime boundary check passed (runtime owns NativeAgent and NativeAgentRunner).";
	return [
		"Native Maestro runtime boundary check failed:",
		...report.violations.map((violation) => {
			const location = violation.path ? `${violation.path}${violation.line ? `:${violation.line}` : ""}: ` : "";
			return `- [${violation.code}] ${location}${violation.message}`;
		}),
	].join("\n");
}

function parseArguments(argv) {
	let root = SCRIPT_ROOT;
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--json") json = true;
		else if (argv[index] === "--root") {
			if (!argv[index + 1]) throw new Error("--root requires a directory");
			root = resolve(argv[++index]);
		} else throw new Error(`unknown argument: ${argv[index]}`);
	}
	return { root, json };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	try {
		const { root, json } = parseArguments(process.argv.slice(2));
		const report = analyzeNativeRuntimeBoundary(root);
		if (json) console.log(JSON.stringify(report, null, 2));
		else if (report.ok) console.log(formatNativeRuntimeBoundaryReport(report));
		else console.error(formatNativeRuntimeBoundaryReport(report));
		process.exitCode = report.ok ? 0 : 1;
	} catch (error) {
		console.error(`Native Maestro runtime boundary check could not run: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
