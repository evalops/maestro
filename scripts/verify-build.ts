#!/usr/bin/env node
/**
 * Comprehensive build verification script
 *
 * Verifies that all build artifacts are present, valid, and functional.
 * This script should be run after `npm run build:all` or `npx nx run composer:build:all`
 */

import { access, readFile, stat, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const distPath = join(projectRoot, "dist");

interface CheckResult {
	name: string;
	passed: boolean;
	error?: string;
}

const results: CheckResult[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		results.push({ name, passed: true });
		console.log(`✓ ${name}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		results.push({ name, passed: false, error: message });
		console.error(`✗ ${name}: ${message}`);
	}
}

async function verifyCriticalFiles() {
	console.log("\n[1/6] Verifying critical files...\n");

	const criticalFiles = [
		{ path: "cli.js", minSize: 1000 },
		{ path: "main.js", minSize: 100 },
		{ path: "index.js", minSize: 100 },
		{ path: "web-server.js", minSize: 100 },
	];

	for (const file of criticalFiles) {
		await check(`Critical file: ${file.path}`, async () => {
			const filePath = join(distPath, file.path);
			await access(filePath);
			const stats = await stat(filePath);
			if (stats.size < file.minSize) {
				throw new Error(`File too small: ${stats.size} bytes (expected at least ${file.minSize})`);
			}
		});
	}
}

async function verifyTypeDefinitions() {
	console.log("\n[2/6] Verifying type definitions...\n");

	const typeFiles = [
		"cli.d.ts",
		"main.d.ts",
		"index.d.ts",
		"web-server.d.ts",
	];

	for (const file of typeFiles) {
		await check(`Type definition: ${file}`, async () => {
			const filePath = join(distPath, file);
			await access(filePath);
			const content = await readFile(filePath, "utf-8");
			if (content.length === 0) {
				throw new Error("Type definition file is empty");
			}
		});
	}
}

async function verifySourceMaps() {
	console.log("\n[3/6] Verifying source maps...\n");

	const sourceMapFiles = [
		"cli.js.map",
		"main.js.map",
		"index.js.map",
	];

	for (const file of sourceMapFiles) {
		await check(`Source map: ${file}`, async () => {
			const filePath = join(distPath, file);
			await access(filePath);
			const content = await readFile(filePath, "utf-8");
			const map = JSON.parse(content);
			if (!map.version || !map.sources) {
				throw new Error("Invalid source map structure");
			}
		});
	}
}

async function verifyModuleStructure() {
	console.log("\n[4/6] Verifying module structure...\n");

	const modules = [
		"agent",
		"tools",
		"cli",
		"models",
		"session",
		"config",
		"safety",
		"web",
	];

	for (const module of modules) {
		await check(`Module directory: ${module}`, async () => {
			const modulePath = join(distPath, module);
			await access(modulePath);
			const entries = await readdir(modulePath);
			if (entries.length === 0) {
				throw new Error("Module directory is empty");
			}
		});
	}
}

async function verifyEssentialTools() {
	console.log("\n[5/6] Verifying essential tools...\n");

	const tools = [
		"read.js",
		"write.js",
		"edit.js",
		"list.js",
		"search.js",
		"bash.js",
		"diff.js",
	];

	for (const tool of tools) {
		await check(`Tool: ${tool}`, async () => {
			const toolPath = join(distPath, "tools", tool);
			await access(toolPath);
			const stats = await stat(toolPath);
			if (stats.size === 0) {
				throw new Error("Tool file is empty");
			}
		});
	}
}

async function verifyCLIFunctionality() {
	console.log("\n[6/6] Verifying CLI functionality...\n");

	const baseEnv = {
		...process.env,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "test-key",
		COMPOSER_NO_COLOR: "1",
	};

	const cliPath = join(distPath, "cli.js");
	const spawnOpts = {
		stdio: "pipe" as const,
		env: baseEnv,
		cwd: projectRoot,
		timeout: 15000, // guard against hangs
	};

	const runCli = (args: string[]) => {
		const result = spawnSync("node", [cliPath, ...args], spawnOpts);
		if (result.timedOut) {
			throw new Error(`Process timed out after ${spawnOpts.timeout}ms`);
		}
		if (result.error) {
			throw result.error;
		}
		if (result.signal) {
			throw new Error(`Process terminated by signal ${result.signal}`);
		}
		if (result.status !== 0) {
			throw new Error(
				`Exit code ${result.status}: ${result.stderr?.toString() ?? "no stderr"}`,
			);
		}
		return result.stdout?.toString() ?? "";
	};

	await check("CLI help command", () => {
		runCli(["--help"]);
	});

	await check("CLI version command", () => {
		const output = runCli(["--version"]);
		if (!output.includes("Composer")) {
			throw new Error("Version output doesn't contain 'Composer'");
		}
	});

	await check("CLI json mode", () => {
		runCli(["--mode", "json", "--help"]);
	});
}

async function verifyPackageBuilds() {
	console.log("\n[Bonus] Verifying package builds...\n");

	const packages = [
		{ name: "TUI", path: join(projectRoot, "packages", "tui", "dist") },
		{ name: "Web", path: join(projectRoot, "packages", "web", "dist") },
		{ name: "Contracts", path: join(projectRoot, "packages", "contracts", "dist") },
		{ name: "AI", path: join(projectRoot, "packages", "ai", "dist") },
	];

	for (const pkg of packages) {
		await check(`Package: ${pkg.name}`, async () => {
			try {
				await access(pkg.path);
				const entries = await readdir(pkg.path);
				if (entries.length === 0) {
					throw new Error("Package dist directory is empty");
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					throw new Error("Package dist directory does not exist - run 'npm run build:all'");
				}
				throw error;
			}
		});
	}
}

async function main() {
	console.log("=".repeat(60));
	console.log("Build Verification");
	console.log("=".repeat(60));

	try {
		await verifyCriticalFiles();
		await verifyTypeDefinitions();
		await verifySourceMaps();
		await verifyModuleStructure();
		await verifyEssentialTools();
		await verifyCLIFunctionality();

		// Package builds are optional - they may not exist if build:all wasn't run
		if (process.env.VERIFY_PACKAGES === "1") {
			await verifyPackageBuilds();
		}

		console.log("\n" + "=".repeat(60));
		const passed = results.filter(r => r.passed).length;
		const failed = results.filter(r => !r.passed).length;
		console.log(`Results: ${passed} passed, ${failed} failed`);
		console.log("=".repeat(60) + "\n");

		if (failed > 0) {
			console.error("Build verification failed!");
			console.error("\nFailed checks:");
			for (const result of results.filter(r => !r.passed)) {
				console.error(`  - ${result.name}: ${result.error}`);
			}
			process.exit(1);
		}

		console.log("✓ Build verification passed!");
	} catch (error) {
		console.error("Fatal error during build verification:", error);
		process.exit(1);
	}
}

main();
