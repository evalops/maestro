#!/usr/bin/env node
/**
 * Fast prebuild dependency guard.
 *
 * Skips `bun install` when:
 * - bun.lockb exists
 * - node_modules exists
 * - stored lockfile hash matches current lockfile
 *
 * Writes the hash to node_modules/.bun-lockb.sha256 after a successful install.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const lockfile = "bun.lockb";
const stamp = join("node_modules", ".bun-lockb.sha256");
const workspacePackages = [
	{
		name: "@evalops/contracts",
		dir: "packages/contracts",
		outputs: ["dist/index.js", "dist/index.d.ts"],
	},
	{
		name: "@evalops/tui",
		dir: "packages/tui",
		outputs: ["dist/index.js", "dist/index.d.ts"],
	},
];

function usage() {
	return [
		"Usage: node scripts/ensure-deps.js [--no-install] [--workspace <package>...]",
		"",
		"Options:",
		"  --no-install           Assume dependencies were already installed.",
		"  --workspace <package>  Build only the named workspace package.",
	].join("\n");
}

export function parseOptions(argv = []) {
	const options = {
		allowInstall: true,
		workspaceNames: [],
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--no-install") {
			options.allowInstall = false;
			continue;
		}
		if (arg === "--workspace") {
			const name = argv[i + 1];
			if (!name || name.startsWith("--")) {
				throw new Error("--workspace requires a package name");
			}
			options.workspaceNames.push(name);
			i += 1;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

export function selectWorkspacePackages(workspaceNames = []) {
	if (workspaceNames.length === 0) {
		return workspacePackages;
	}

	const selected = [];
	for (const name of workspaceNames) {
		const pkg = workspacePackages.find((candidate) => candidate.name === name);
		if (!pkg) {
			throw new Error(`Unknown workspace package: ${name}`);
		}
		selected.push(pkg);
	}
	return selected;
}

function hashFile(path) {
	const buf = readFileSync(path);
	return createHash("sha256").update(buf).digest("hex");
}

function runInstall() {
	const result = spawnSync("bun", ["install", "--frozen-lockfile"], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
	const hash = hashFile(lockfile);
	mkdirSync(dirname(stamp), { recursive: true });
	writeFileSync(stamp, hash);
}

export function workspaceStampPath(projectRoot, pkg) {
	const safeName = pkg.name.replace(/[^a-zA-Z0-9._-]/g, "-");
	return join(projectRoot, "node_modules", `.workspace-build-${safeName}.sha256`);
}

function collectFiles(root, files = []) {
	if (!existsSync(root)) {
		return files;
	}
	const stat = statSync(root);
	if (stat.isFile()) {
		files.push(root);
		return files;
	}
	for (const entry of readdirSync(root).sort()) {
		if (entry === "dist" || entry === "node_modules") {
			continue;
		}
		collectFiles(join(root, entry), files);
	}
	return files;
}

export function computeWorkspacePackageHash(projectRoot, pkg) {
	const hash = createHash("sha256");
	const packageRoot = join(projectRoot, pkg.dir);
	const codegenInputs =
		pkg.name === "@evalops/contracts"
			? [
					join(projectRoot, "buf.gen.yaml"),
					join(projectRoot, "buf.yaml"),
					join(projectRoot, "proto"),
					join(projectRoot, "scripts/headless-protocol-codegen.mjs"),
				]
			: [];
	const inputs = [
		join(projectRoot, "bun.lockb"),
		join(projectRoot, "tsconfig.base.json"),
		join(packageRoot, "package.json"),
		join(packageRoot, "tsconfig.build.json"),
		...collectFiles(join(packageRoot, "src")),
		...codegenInputs.flatMap((path) => collectFiles(path)),
	].filter((path) => existsSync(path));

	for (const path of inputs.sort()) {
		hash.update(relative(projectRoot, path));
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function workspacePackageNeedsBuild(projectRoot, pkg) {
	const packageRoot = join(projectRoot, pkg.dir);
	for (const output of pkg.outputs) {
		if (!existsSync(join(packageRoot, output))) {
			return true;
		}
	}

	const expected = computeWorkspacePackageHash(projectRoot, pkg);
	const stampPath = workspaceStampPath(projectRoot, pkg);
	const actual = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
	return actual !== expected;
}

function buildWorkspacePackage(projectRoot, pkg) {
	console.log(`[ensure-deps] building ${pkg.name}`);
	const result = spawnSync("bun", ["run", "--filter", pkg.name, "build"], {
		cwd: projectRoot,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}

	const hash = computeWorkspacePackageHash(projectRoot, pkg);
	const stampPath = workspaceStampPath(projectRoot, pkg);
	mkdirSync(dirname(stampPath), { recursive: true });
	writeFileSync(stampPath, hash);
}

function ensureWorkspaceBuilds(projectRoot = process.cwd(), packages = workspacePackages) {
	for (const pkg of packages) {
		if (workspacePackageNeedsBuild(projectRoot, pkg)) {
			buildWorkspacePackage(projectRoot, pkg);
		}
	}
}

export function main(argv = process.argv.slice(2), projectRoot = process.cwd()) {
	let options;
	let selectedPackages;
	try {
		options = parseOptions(argv);
		selectedPackages = selectWorkspacePackages(options.workspaceNames);
	} catch (error) {
		console.error(`[ensure-deps] ${error.message}`);
		console.error(usage());
		process.exit(1);
	}

	if (!existsSync(lockfile)) {
		if (!options.allowInstall) {
			console.error("[ensure-deps] bun.lockb missing and --no-install was set");
			process.exit(1);
		}
		console.warn("[ensure-deps] bun.lockb missing; running bun install");
		runInstall();
		ensureWorkspaceBuilds(projectRoot, selectedPackages);
		return;
	}
	if (!existsSync("node_modules")) {
		if (!options.allowInstall) {
			console.error("[ensure-deps] node_modules missing and --no-install was set");
			process.exit(1);
		}
		console.log("[ensure-deps] node_modules missing; running bun install");
		runInstall();
		ensureWorkspaceBuilds(projectRoot, selectedPackages);
		return;
	}

	const currentHash = hashFile(lockfile);
	const cachedHash = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";

	if (!options.allowInstall) {
		console.log("[ensure-deps] assuming dependencies are installed; skipping bun install");
		ensureWorkspaceBuilds(projectRoot, selectedPackages);
		return;
	}

	if (currentHash === cachedHash) {
		console.log("[ensure-deps] dependencies up to date; skipping bun install");
		ensureWorkspaceBuilds(projectRoot, selectedPackages);
		return;
	}

	console.log("[ensure-deps] lockfile changed; running bun install");
	runInstall();
	ensureWorkspaceBuilds(projectRoot, selectedPackages);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
