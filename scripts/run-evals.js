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
const cliArgs = process.argv.slice(2);

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

	const expectedExit =
		scenario.expectedExitCode === undefined ? 0 : Number(scenario.expectedExitCode);
	let passed = exitCode === expectedExit;

	const checks = [
		{ value: scenario.expectedRegex ?? scenario.expectedStdoutRegex, source: stdout },
		{ value: scenario.expectedStderrRegex, source: stderr },
	];

	for (const check of checks) {
		if (!check.value) continue;
		try {
			const regex = new RegExp(check.value, "i");
			if (!regex.test(check.source)) {
				passed = false;
			}
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

	const { chunkCount, chunkIndex } = getChunkConfig();
	const filteredScenarios = scenarios.filter((_, idx) =>
		idx % chunkCount === chunkIndex,
	);

	if (filteredScenarios.length === 0) {
		console.warn(
			`No scenarios selected for chunk ${chunkIndex + 1}/${chunkCount}. Nothing to run.`,
		);
		return;
	}

	if (chunkCount > 1) {
		console.log(
			`Running chunk ${chunkIndex + 1}/${chunkCount} (${filteredScenarios.length}/${scenarios.length} scenarios)`,
		);
	}

	let failures = 0;

	for (const scenario of filteredScenarios) {
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
		`\nCompleted ${filteredScenarios.length} scenario(s) with ${failures} failure(s).`,
	);

	if (failures > 0) {
		process.exit(1);
	}
}

await main();

function getChunkConfig() {
	const argConfig = parseChunkArgs(cliArgs);
	const envChunkCount = parseNumber(process.env.COMPOSER_EVAL_CHUNK_COUNT);
	const envChunkIndex = parseNumber(process.env.COMPOSER_EVAL_CHUNK_INDEX);

	const chunkCount = clamp(
		argConfig.chunkCount ?? envChunkCount ?? 1,
		1,
		Number.POSITIVE_INFINITY,
	);
	const maxIndex = chunkCount;
	const chunkIndexInput = argConfig.chunkIndex ?? envChunkIndex ?? 1;
	const safeIndex = clamp(chunkIndexInput, 1, maxIndex) - 1;

	return {
		chunkCount,
		chunkIndex: safeIndex,
	};
}

function parseChunkArgs(args) {
	let chunkCount;
	let chunkIndex;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--chunk-count" && i + 1 < args.length) {
			chunkCount = parseNumber(args[++i]);
			continue;
		}
		if (arg === "--chunk-index" && i + 1 < args.length) {
			chunkIndex = parseNumber(args[++i]);
			continue;
		}
		if (arg.startsWith("--chunk=")) {
			const [, value] = arg.split("=");
			const [indexPart, countPart] = value.split("/");
			chunkIndex = parseNumber(indexPart);
			chunkCount = parseNumber(countPart);
		}
	}

	return { chunkCount, chunkIndex };
}

function parseNumber(value) {
	if (value === undefined || value === null) {
		return undefined;
	}
	const parsed = Number.parseInt(String(value), 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value, min, max) {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(Math.max(value, min), max);
}
