#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const cliPath = join(projectRoot, "dist", "cli.js");
const scenariosPath = join(projectRoot, "evals", "scenarios.json");

let recordEvaluationResult;
try {
	const telemetryModule = await import(
		pathToFileURL(join(projectRoot, "dist", "telemetry.js")).href,
	);
	recordEvaluationResult = telemetryModule.recordEvaluationResult;
} catch (_error) {
	// Telemetry not available (likely not built yet) – proceed without it.
}

async function runScenario(scenario) {
	const env = { ...process.env, ...scenario.env };
	const args = Array.isArray(scenario.args) ? [...scenario.args] : [];
	const messages = Array.isArray(scenario.messages)
		? [...scenario.messages]
		: [];

	let command = "node";
	let launchArgs = ["--enable-source-maps", cliPath, ...args, ...messages];

	if (Array.isArray(scenario.command) && scenario.command.length > 0) {
		[command, ...launchArgs] = scenario.command;
	}

	const { exitCode, stdout, stderr } = await new Promise((resolve) => {
		const child = spawn(command, launchArgs, {
			cwd: projectRoot,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let capturedStdout = "";
		let capturedStderr = "";

		child.stdout?.on("data", (chunk) => {
			capturedStdout += chunk.toString();
		});

		child.stderr?.on("data", (chunk) => {
			capturedStderr += chunk.toString();
		});

		child.on("close", (code) => {
			resolve({
				exitCode: code ?? 0,
				stdout: capturedStdout,
				stderr: capturedStderr,
			});
		});
	});

	let passed = exitCode === 0;
	if (scenario.expectedRegex) {
		try {
			const regex = new RegExp(scenario.expectedRegex, "i");
			passed = passed && regex.test(stdout);
		} catch (_error) {
			passed = false;
		}
	}

	if (typeof recordEvaluationResult === "function") {
		recordEvaluationResult(scenario.name, passed, {
			exitCode,
			stdoutLength: stdout.length,
			stderrLength: stderr.length,
		});
	}

	return { exitCode, stdout, stderr, passed };
}

async function main() {
	let scenarios;
	try {
		scenarios = JSON.parse(await readFile(scenariosPath, "utf-8"));
	} catch (error) {
		console.error("Failed to read evaluation scenarios:", error);
		process.exit(1);
	}

	if (!Array.isArray(scenarios) || scenarios.length === 0) {
		console.warn("No evaluation scenarios defined. Nothing to run.");
		return;
	}

	let failures = 0;

	for (const scenario of scenarios) {
		const { passed, stdout, stderr } = await runScenario(scenario);
		const status = passed ? "PASS" : "FAIL";
		console.log(`[${status}] ${scenario.name}`);
		if (!passed) {
			failures += 1;
			if (stdout.trim()) {
				console.log("stdout:\n", stdout.trim());
			}
			if (stderr.trim()) {
				console.log("stderr:\n", stderr.trim());
			}
		}
	}

	console.log(
		`\nCompleted ${scenarios.length} scenario(s) with ${failures} failure(s).`,
	);

	if (failures > 0) {
		process.exit(1);
	}
}

await main();
