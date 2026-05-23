#!/usr/bin/env node

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_HEARTBEAT_SECONDS = 300;
const TERMINATION_GRACE_MS = 10_000;

function parseSeconds(value, name, { allowZero = false } = {}) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed < (allowZero ? 0 : 1)) {
		throw new Error(
			`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer number of seconds`,
		);
	}
	return parsed;
}

export function parseArgs(argv) {
	const options = {
		command: [],
		heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
		label: "command",
		logfile: "",
		summaryJson: "",
		timeoutSeconds: 0,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--":
				options.command = argv.slice(index + 1);
				index = argv.length;
				break;
			case "--heartbeat-seconds":
				options.heartbeatSeconds = parseSeconds(argv[++index], arg, {
					allowZero: true,
				});
				break;
			case "--label":
				options.label = argv[++index] ?? options.label;
				break;
			case "--logfile":
				options.logfile = argv[++index] ?? "";
				break;
			case "--summary-json":
				options.summaryJson = argv[++index] ?? "";
				break;
			case "--timeout-seconds":
				options.timeoutSeconds = parseSeconds(argv[++index], arg, {
					allowZero: true,
				});
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (options.command.length === 0) {
		throw new Error(
			"Usage: node scripts/run-command-with-heartbeat.mjs [--label name] [--logfile path] [--timeout-seconds seconds] [--heartbeat-seconds seconds] -- <command> [args...]",
		);
	}

	return options;
}

function escapeAnnotation(value) {
	return String(value)
		.replaceAll("%", "%25")
		.replaceAll("\r", "%0D")
		.replaceAll("\n", "%0A")
		.replaceAll(":", "%3A")
		.replaceAll(",", "%2C");
}

function annotation(level, message) {
	if (process.env.GITHUB_ACTIONS === "true") {
		return `::${level}::${escapeAnnotation(message)}`;
	}
	return message;
}

function killChild(child, signal) {
	if (!child.pid) {
		return;
	}
	if (process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall through to killing the direct child.
		}
	}
	child.kill(signal);
}

function formatElapsed(startedAt) {
	const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const minutes = Math.floor(elapsedSeconds / 60);
	const seconds = elapsedSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function writeSummaryJson(options, summary) {
	if (!options.summaryJson) {
		return;
	}
	mkdirSync(dirname(options.summaryJson), { recursive: true });
	writeFileSync(options.summaryJson, `${JSON.stringify(summary, null, 2)}\n`);
}

export async function runCommandWithHeartbeat(options) {
	const [command, ...args] = options.command;
	const startedAt = Date.now();
	const startedAtIso = new Date(startedAt).toISOString();
	const logStream = options.logfile
		? createWriteStream(options.logfile, { flags: "w" })
		: null;
	let timedOut = false;
	let terminateTimer = null;

	const child = spawn(command, args, {
		detached: process.platform !== "win32",
		stdio: ["inherit", "pipe", "pipe"],
	});

	const write = (stream, chunk) => {
		stream.write(chunk);
		if (logStream) {
			logStream.write(chunk);
		}
	};

	child.stdout?.on("data", (chunk) => write(process.stdout, chunk));
	child.stderr?.on("data", (chunk) => write(process.stderr, chunk));

	const heartbeatTimer =
		options.heartbeatSeconds > 0
			? setInterval(() => {
					console.log(
						annotation(
							"notice",
							`${options.label} still running after ${formatElapsed(startedAt)}`,
						),
					);
				}, options.heartbeatSeconds * 1000)
			: null;

	const timeoutTimer =
		options.timeoutSeconds > 0
			? setTimeout(() => {
					timedOut = true;
					console.error(
						annotation(
							"error",
							`${options.label} timed out after ${options.timeoutSeconds}s; sending SIGTERM`,
						),
					);
					killChild(child, "SIGTERM");
					terminateTimer = setTimeout(() => {
						console.error(
							annotation(
								"error",
								`${options.label} did not exit after SIGTERM; sending SIGKILL`,
							),
						);
						killChild(child, "SIGKILL");
					}, TERMINATION_GRACE_MS);
				}, options.timeoutSeconds * 1000)
			: null;

	const result = await new Promise((resolve) => {
		child.on("error", (error) => {
			console.error(annotation("error", `${options.label} failed to start: ${error.message}`));
			resolve({ code: 127, signal: null });
		});
		child.on("close", (code, signal) => resolve({ code, signal }));
	});

	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
	}
	if (timeoutTimer) {
		clearTimeout(timeoutTimer);
	}
	if (terminateTimer) {
		clearTimeout(terminateTimer);
	}

	if (logStream) {
		await new Promise((resolve) => logStream.end(resolve));
	}

	const finishedAt = Date.now();
	const exitCode = timedOut
		? 124
		: typeof result.code === "number"
			? result.code
			: result.signal
				? 1
				: 0;
	writeSummaryJson(options, {
		command: options.command,
		elapsedMs: Math.max(0, finishedAt - startedAt),
		exitCode,
		finishedAt: new Date(finishedAt).toISOString(),
		label: options.label,
		logfile: options.logfile || undefined,
		signal: result.signal ?? null,
		startedAt: startedAtIso,
		timedOut,
		timeoutSeconds: options.timeoutSeconds,
	});

	if (timedOut) {
		return 124;
	}
	if (typeof result.code === "number") {
		return result.code;
	}
	if (result.signal) {
		console.error(annotation("error", `${options.label} exited from signal ${result.signal}`));
		return 1;
	}
	return 0;
}

async function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		process.exitCode = await runCommandWithHeartbeat(options);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
