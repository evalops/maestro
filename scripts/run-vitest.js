import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.env.FORCE_COLOR && process.env.NO_COLOR) {
	Reflect.deleteProperty(process.env, "NO_COLOR");
}

const DEFAULT_POST_SUCCESS_EXIT_GRACE_MS = 15_000;
const TERMINATION_GRACE_MS = 5_000;
const SUMMARY_TAIL_BYTES = 64_000;
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function createVitestSummaryTracker() {
	let sawPassingFiles = false;
	let sawPassingTests = false;
	let sawFailedSummary = false;
	let bufferedLine = "";
	let rawTail = "";

	const inspectLine = (line) => {
		if (/\bTest Files\b.*\d+\s+failed\b/iu.test(line)) {
			sawFailedSummary = true;
		}
		if (/\bTests\b.*\d+\s+failed\b/iu.test(line)) {
			sawFailedSummary = true;
		}
		if (/\bTest Files\b.*\d+\s+passed\b/iu.test(line)) {
			sawPassingFiles = true;
		}
		if (/\bTests\b.*\d+\s+passed\b/iu.test(line)) {
			sawPassingTests = true;
		}
	};

	return {
		push(chunk) {
			const text = String(chunk);
			rawTail = `${rawTail}${text}`.slice(-SUMMARY_TAIL_BYTES);
			const lines = `${bufferedLine}${text}`.split(/\r?\n/u);
			bufferedLine = lines.pop() ?? "";
			for (const line of lines) {
				inspectLine(line.replace(ANSI_PATTERN, ""));
			}
			if (bufferedLine) {
				inspectLine(bufferedLine.replace(ANSI_PATTERN, ""));
			}
		},
		get passed() {
			const tail = rawTail.replace(ANSI_PATTERN, "");
			const tailHasPassingSummary =
				/\bTest Files\b[^\n]*\d+\s+passed\b[\s\S]*\bTests\b[^\n]*\d+\s+passed\b/iu.test(
					tail,
				);
			const tailHasFailedSummary =
				/\b(?:Test Files|Tests)\b[^\n]*\d+\s+failed\b/iu.test(tail);
			return (
				((sawPassingFiles && sawPassingTests) || tailHasPassingSummary) &&
				!sawFailedSummary &&
				!tailHasFailedSummary
			);
		},
	};
}

function parseGraceMs() {
	const value = Number.parseInt(
		process.env.VITEST_CI_POST_SUCCESS_EXIT_GRACE_MS ?? "",
		10,
	);
	return Number.isFinite(value) && value >= 0
		? value
		: DEFAULT_POST_SUCCESS_EXIT_GRACE_MS;
}

function shouldUseCiExitWatchdog(args) {
	const isCoverageRun = args.some(
		(arg) =>
			arg === "--coverage" ||
			arg.startsWith("--coverage.") ||
			arg.startsWith("--coverage="),
	);
	return (
		process.env.GITHUB_ACTIONS === "true" &&
		args.includes("--run") &&
		!args.includes("--watch") &&
		!isCoverageRun
	);
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
			// Fall through to direct child termination.
		}
	}
	child.kill(signal);
}

async function runVitestWithCiExitWatchdog(args) {
	const tracker = createVitestSummaryTracker();
	const graceMs = parseGraceMs();
	const child = spawn("bunx", ["vitest", ...args], {
		detached: process.platform !== "win32",
		env: process.env,
		shell: process.platform === "win32",
		stdio: ["inherit", "pipe", "pipe"],
	});
	let forcedSuccessExit = false;
	let terminatedChild = false;
	let lastOutputAt = Date.now();
	let postSuccessTimer = null;
	let terminationTimer = null;
	let postSuccessInterval = null;

	const clearPostSuccessTimer = () => {
		if (postSuccessTimer) {
			clearTimeout(postSuccessTimer);
			postSuccessTimer = null;
		}
	};

	const terminateChildAfterPassingSummary = () => {
		if (terminatedChild) {
			return;
		}
		terminatedChild = true;
		forcedSuccessExit = true;
		console.error(
			`[run-vitest] Vitest printed a passing summary but did not exit after ${graceMs}ms; terminating CI process group.`,
		);
		killChild(child, "SIGTERM");
		terminationTimer = setTimeout(() => {
			killChild(child, "SIGKILL");
		}, TERMINATION_GRACE_MS);
	};

	const maybeTerminateAfterPassingSummary = () => {
		if (!tracker.passed || graceMs === 0) {
			return;
		}
		if (Date.now() - lastOutputAt >= graceMs) {
			terminateChildAfterPassingSummary();
		}
	};

	const schedulePostSuccessExit = () => {
		clearPostSuccessTimer();
		if (!tracker.passed || graceMs === 0) {
			return;
		}
		postSuccessTimer = setTimeout(() => {
			terminateChildAfterPassingSummary();
		}, graceMs);
	};

	const observe = (stream, chunk) => {
		lastOutputAt = Date.now();
		stream.write(chunk);
		tracker.push(chunk);
		schedulePostSuccessExit();
	};

	postSuccessInterval = setInterval(
		maybeTerminateAfterPassingSummary,
		Math.min(1_000, Math.max(10, graceMs)),
	);

	child.stdout?.on("data", (chunk) => observe(process.stdout, chunk));
	child.stderr?.on("data", (chunk) => observe(process.stderr, chunk));

	const result = await new Promise((resolve) => {
		child.on("error", (error) => {
			console.error(`[run-vitest] failed to start Vitest: ${error.message}`);
			resolve({ code: 127, signal: null });
		});
		child.on("close", (code, signal) => resolve({ code, signal }));
	});

	clearPostSuccessTimer();
	if (terminationTimer) {
		clearTimeout(terminationTimer);
	}
	if (postSuccessInterval) {
		clearInterval(postSuccessInterval);
	}

	if (forcedSuccessExit && tracker.passed) {
		return 0;
	}
	if (typeof result.code === "number") {
		return result.code;
	}
	return result.signal ? 1 : 0;
}

export async function runVitest(args) {
	if (shouldUseCiExitWatchdog(args)) {
		return runVitestWithCiExitWatchdog(args);
	}

	const result = spawnSync("bunx", ["vitest", ...args], {
		env: process.env,
		shell: process.platform === "win32",
		stdio: "inherit",
	});

	if (result.error) {
		throw result.error;
	}

	return result.status ?? 1;
}

async function main() {
	process.exitCode = await runVitest(process.argv.slice(2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await main();
}
