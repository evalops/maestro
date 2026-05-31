#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const repoRoot = process.cwd();
const node = process.execPath;
const cliPath = join(repoRoot, "dist", "cli.js");

function parseArgs(argv) {
	const options = {
		iterations: 5,
		json: false,
		keepProfiledCli: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") {
			options.json = true;
		} else if (arg === "--keep-profiled-cli") {
			options.keepProfiledCli = true;
		} else if (arg === "--iterations" && argv[index + 1]) {
			const value = Number.parseInt(argv[++index], 10);
			if (Number.isFinite(value) && value > 0) {
				options.iterations = value;
			}
		}
	}
	return options;
}

function percentile(sorted, p) {
	if (sorted.length === 0) return 0;
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[index];
}

function summarize(samples) {
	const values = samples.filter((value) => Number.isFinite(value));
	const sorted = [...values].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	return {
		count: sorted.length,
		min_ms: Number(sorted[0]?.toFixed(1) ?? 0),
		median_ms: Number(percentile(sorted, 50).toFixed(1)),
		p90_ms: Number(percentile(sorted, 90).toFixed(1)),
		max_ms: Number(sorted[sorted.length - 1]?.toFixed(1) ?? 0),
		mean_ms: Number((total / Math.max(1, sorted.length)).toFixed(1)),
		samples_ms: sorted.map((value) => Number(value.toFixed(1))),
	};
}

function replaceOnce(source, needle, replacement) {
	if (!source.includes(needle)) {
		throw new Error(`Unable to instrument dist/cli.js; missing marker: ${needle}`);
	}
	return source.replace(needle, replacement);
}

function replaceAllRequired(source, needle, replacement) {
	const next = source.replaceAll(needle, replacement);
	if (next === source) {
		throw new Error(`Unable to instrument dist/cli.js; missing marker: ${needle}`);
	}
	return next;
}

function launcherPrelude() {
	return `const __launcherProfileEnabled = process.env.MAESTRO_LAUNCHER_PROFILE === "1";
const __launcherProfileStartMs = globalThis.performance?.now?.() ?? Date.now();
function __launcherNowMs() {
	return globalThis.performance?.now?.() ?? Date.now();
}
function __launcherMark(name, fields = {}) {
	if (!__launcherProfileEnabled) {
		return;
	}
	const ms = Number((__launcherNowMs() - __launcherProfileStartMs).toFixed(1));
	const extra = Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => \`\${key}=\${JSON.stringify(value)}\`)
		.join(" ");
	process.stderr.write(\`[launcher] \${ms}ms \${name}\${extra ? \` \${extra}\` : ""}\\n\`);
}
__launcherMark("module:body-start");
`;
}

function instrumentCliSource(source) {
	let instrumented = replaceOnce(
		source,
		"#!/usr/bin/env node\n",
		`#!/usr/bin/env node\n${launcherPrelude()}`,
	);
	instrumented = replaceOnce(
		instrumented,
		"async function refreshInstalledCliOnStartup(args, ignoredEnvKeys = []) {\n    try {",
		`async function refreshInstalledCliOnStartup(args, ignoredEnvKeys = []) {
    __launcherMark("startup-refresh:start", { ignored_env_keys: ignoredEnvKeys.length });
    try {`,
	);
	instrumented = replaceOnce(
		instrumented,
		`        const [{ getPackageName, getPackageVersion }, { attemptStartupUpdate }] = await Promise.all([
            import("./package-metadata.js"),
            import("./update/startup-refresh.js"),
        ]);`,
		`        __launcherMark("startup-refresh:imports:start");
        const [{ getPackageName, getPackageVersion }, { attemptStartupUpdate }] = await Promise.all([
            import("./package-metadata.js"),
            import("./update/startup-refresh.js"),
        ]);
        __launcherMark("startup-refresh:imports:done");`,
	);
	instrumented = replaceOnce(
		instrumented,
		`        const outcome = await attemptStartupUpdate({
            args,
            currentVersion: getPackageVersion(env),
            env,
            packageName: getPackageName(env),
        });`,
		`        __launcherMark("startup-refresh:attempt:start");
        const outcome = await attemptStartupUpdate({
            args,
            currentVersion: getPackageVersion(env),
            env,
            packageName: getPackageName(env),
        });
        __launcherMark("startup-refresh:attempt:done", { status: outcome.status });`,
	);
	instrumented = replaceOnce(
		instrumented,
		`    const { main } = await loadMain();
    await main(args);`,
		`    __launcherMark("main-runtime:import:start");
    const { main } = await loadMain();
    __launcherMark("main-runtime:import:done");
    await main(args);`,
	);
	instrumented = replaceOnce(
		instrumented,
		`        return import("./cli/direct-runtime-command.js");`,
		`        __launcherMark("direct-runtime-command:import:start", { bundled: true });
        const directRuntimeCommandModule = await import("./cli/direct-runtime-command.js");
        __launcherMark("direct-runtime-command:import:done", { bundled: true });
        return directRuntimeCommandModule;`,
	);
	instrumented = replaceOnce(
		instrumented,
		`    return import(directRuntimeCommandEntry);`,
		`    __launcherMark("direct-runtime-command:import:start", { bundled: false });
    const directRuntimeCommandModule = await import(directRuntimeCommandEntry);
    __launcherMark("direct-runtime-command:import:done", { bundled: false });
    return directRuntimeCommandModule;`,
	);
	instrumented = replaceOnce(
		instrumented,
		"async function runCliCommandRuntime(args) {\n    const { shouldAttemptDirectRuntimeDispatch } = await loadDirectRuntimeCommandModule();",
		`async function runCliCommandRuntime(args) {
    __launcherMark("cli-command-runtime:check:start");
    const { shouldAttemptDirectRuntimeDispatch } = await loadDirectRuntimeCommandModule();
    __launcherMark("cli-command-runtime:check:loaded");`,
	);
	instrumented = replaceOnce(
		instrumented,
		`    if (!shouldAttemptDirectRuntimeDispatch(args)) {
        return false;
    }`,
		`    if (!shouldAttemptDirectRuntimeDispatch(args)) {
        __launcherMark("cli-command-runtime:skip");
        return false;
    }
    __launcherMark("cli-command-runtime:accepted");`,
	);
	instrumented = replaceOnce(
		instrumented,
		"async function runUnbundledMainRuntime(args) {\n    if (typeof MAESTRO_BUNDLE_RUNTIME !== \"undefined\" && MAESTRO_BUNDLE_RUNTIME) {",
		`async function runUnbundledMainRuntime(args) {
    __launcherMark("main-runtime:check:start");
    if (typeof MAESTRO_BUNDLE_RUNTIME !== "undefined" && MAESTRO_BUNDLE_RUNTIME) {`,
	);
	instrumented = replaceOnce(
		instrumented,
		`    if (!shouldUseUnbundledMainRuntime(args)) {
        return false;
    }
    await runMainRuntime(args);`,
		`    if (!shouldUseUnbundledMainRuntime(args)) {
        __launcherMark("main-runtime:skip");
        return false;
    }
    __launcherMark("main-runtime:accepted");
    await runMainRuntime(args);`,
	);
	instrumented = replaceOnce(
		instrumented,
		"const run = async () => {\n    try {",
		`const run = async () => {
    try {
        __launcherMark("run:start");`,
	);
	instrumented = replaceOnce(
		instrumented,
		"        const immediateExit = getImmediateCliExit(args);",
		`        const immediateExit = getImmediateCliExit(args);
        __launcherMark("args:parsed", { args: args.length, immediate_exit: immediateExit?.kind ?? null });`,
	);
	instrumented = replaceAllRequired(
		instrumented,
		`const { loadEnv } = await import("./load-env.js");
            loadedEnvKeys = loadEnv();`,
		`__launcherMark("load-env:import:start");
            const { loadEnv } = await import("./load-env.js");
            __launcherMark("load-env:import:done");
            __launcherMark("load-env:call:start");
            loadedEnvKeys = loadEnv();
            __launcherMark("load-env:call:done", { keys: loadedEnvKeys.length });`,
	);
	instrumented = replaceOnce(
		instrumented,
		"        await refreshInstalledCliOnStartup(args, loadedEnvKeys);",
		`        __launcherMark("startup-refresh:call:start");
        await refreshInstalledCliOnStartup(args, loadedEnvKeys);
        __launcherMark("startup-refresh:call:done");`,
	);
	instrumented = replaceOnce(
		instrumented,
		"        if (await runCliCommandRuntime(args)) {",
		`        __launcherMark("cli-command-runtime:call:start");
        if (await runCliCommandRuntime(args)) {`,
	);
	instrumented = replaceOnce(
		instrumented,
		"        if (await runUnbundledMainRuntime(args)) {",
		`        __launcherMark("main-runtime:call:start");
        if (await runUnbundledMainRuntime(args)) {`,
	);
	return instrumented;
}

function createProfiledCli(options) {
	if (!existsSync(cliPath)) {
		throw new Error("dist/cli.js is missing. Run `npm run build` first.");
	}
	const profiledCliPath = join(
		dirname(cliPath),
		`cli.launcher-profile-${process.pid}-${Date.now()}.js`,
	);
	writeFileSync(
		profiledCliPath,
		instrumentCliSource(readFileSync(cliPath, "utf8")),
		"utf8",
	);
	return {
		path: profiledCliPath,
		dispose() {
			if (!options.keepProfiledCli) {
				try {
					unlinkSync(profiledCliPath);
				} catch {
					// Best-effort cleanup for a temporary profiling entrypoint.
				}
			}
		},
	};
}

function commandEnv(extra = {}) {
	return {
		...process.env,
		CI: "1",
		MAESTRO_SKIP_STARTUP_UPDATE: "1",
		MAESTRO_INTERNAL_TELEMETRY_DISABLED: "1",
		EVALOPS_INTERNAL_TELEMETRY_DISABLED: "1",
		...extra,
	};
}

function classifyJsonEvent(event) {
	if (!event || typeof event !== "object") {
		return {};
	}
	const isUser =
		event.role === "user" ||
		(event.type === "turn" && event.role === "user") ||
		(event.type === "item" &&
			event.subtype === "message_complete" &&
			event.turnId === "turn-1");
	const isAssistantOrTool =
		(event.type === "turn" &&
			(event.role === "assistant" || event.role === "tool")) ||
		(event.type === "item" &&
			["message_delta", "tool_call", "tool_result", "tool_update"].includes(
				event.subtype,
			)) ||
		(event.type === "item" &&
			event.subtype === "message_complete" &&
			event.turnId !== "turn-1");
	const isTool =
		event.type === "item" &&
		["tool_call", "tool_result", "tool_update"].includes(event.subtype);
	return { isUser, isAssistantOrTool, isTool };
}

function parseCheckpointLine(line) {
	const match = line.match(/^\[(launcher|startup|query)\]\s+([\d.]+)ms\s+([^ ]+)/);
	if (!match) {
		return null;
	}
	return {
		scope: match[1],
		child_ms: Number.parseFloat(match[2]),
		checkpoint: match[3],
		line,
	};
}

function runExecReplaySample(profiledCliPath) {
	return new Promise((resolve) => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-launcher-boundary-"));
		const homeDir = join(dir, "home");
		const maestroHome = join(dir, "maestro-home");
		const maestroAgentDir = join(dir, "maestro-agent");
		const sessionDir = join(dir, "sessions");
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(maestroHome, { recursive: true });
		mkdirSync(maestroAgentDir, { recursive: true });
		const startedAt = performance.now();
		const sample = {
			status: null,
			signal: null,
			wall_ms: 0,
			first_stdout_line_ms: undefined,
			first_json_event_ms: undefined,
			first_user_json_event_ms: undefined,
			first_assistant_or_tool_event_ms: undefined,
			first_tool_event_ms: undefined,
			first_non_json_stdout_line_ms: undefined,
			stdout_lines: 0,
			non_json_stdout_lines: 0,
			non_json_stdout_samples: [],
			json_events: 0,
			launcher_checkpoints: [],
			startup_checkpoints: [],
			query_checkpoints: [],
			error: undefined,
		};
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let settled = false;
		const child = spawn(
			node,
			[
				profiledCliPath,
				"exec",
				"--replay",
				"test/fixtures/scripted-replay/basic-tool-call.json",
				"--tools",
				"read",
				"--json",
				"Replay the CLI golden path.",
			],
			{
				cwd: repoRoot,
				env: commandEnv({
					HOME: homeDir,
					MAESTRO_HOME: maestroHome,
					MAESTRO_AGENT_DIR: maestroAgentDir,
					MAESTRO_SESSION_DIR: sessionDir,
					MAESTRO_LAUNCHER_PROFILE: "1",
					MAESTRO_STARTUP_PROFILE: "1",
					MAESTRO_QUERY_PROFILE: "1",
					ANTHROPIC_API_KEY: "test-key",
					OPENAI_API_KEY: "test-key",
				}),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const timeout = setTimeout(() => {
			if (!settled) {
				sample.error = "timeout";
				child.kill("SIGTERM");
			}
		}, 15_000);

		const processStdoutLine = (line) => {
			if (!line.trim()) return;
			const elapsed = performance.now() - startedAt;
			sample.stdout_lines++;
			sample.first_stdout_line_ms ??= elapsed;
			if (!line.trimStart().startsWith("{")) {
				sample.non_json_stdout_lines++;
				sample.first_non_json_stdout_line_ms ??= elapsed;
				if (sample.non_json_stdout_samples.length < 5) {
					sample.non_json_stdout_samples.push(line.slice(0, 160));
				}
				return;
			}
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				sample.non_json_stdout_lines++;
				sample.first_non_json_stdout_line_ms ??= elapsed;
				if (sample.non_json_stdout_samples.length < 5) {
					sample.non_json_stdout_samples.push(line.slice(0, 160));
				}
				return;
			}
			sample.json_events++;
			sample.first_json_event_ms ??= elapsed;
			const classification = classifyJsonEvent(event);
			if (classification.isUser) {
				sample.first_user_json_event_ms ??= elapsed;
			}
			if (classification.isAssistantOrTool) {
				sample.first_assistant_or_tool_event_ms ??= elapsed;
			}
			if (classification.isTool) {
				sample.first_tool_event_ms ??= elapsed;
			}
		};

		const processStderrLine = (line) => {
			if (!line.trim()) return;
			const checkpoint = parseCheckpointLine(line);
			if (!checkpoint) return;
			const entry = {
				...checkpoint,
				parent_ms: performance.now() - startedAt,
			};
			if (entry.scope === "launcher") {
				sample.launcher_checkpoints.push(entry);
			} else if (entry.scope === "startup") {
				sample.startup_checkpoints.push(entry);
			} else if (entry.scope === "query") {
				sample.query_checkpoints.push(entry);
			}
		};

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processStdoutLine(line);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderrBuffer += chunk.toString("utf8");
			const lines = stderrBuffer.split("\n");
			stderrBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processStderrLine(line);
			}
		});
		child.on("error", (error) => {
			sample.error = error.message;
		});
		child.on("close", (status, signal) => {
			settled = true;
			clearTimeout(timeout);
			if (stdoutBuffer) {
				processStdoutLine(stdoutBuffer);
			}
			if (stderrBuffer) {
				processStderrLine(stderrBuffer);
			}
			sample.status = status;
			sample.signal = signal;
			sample.wall_ms = performance.now() - startedAt;
			rmSync(dir, { recursive: true, force: true });
			resolve(sample);
		});
	});
}

function checkpointParentMs(sample, scope, name) {
	const checkpoints =
		scope === "launcher"
			? sample.launcher_checkpoints
			: scope === "startup"
				? sample.startup_checkpoints
				: sample.query_checkpoints;
	return checkpoints.find((entry) => entry.checkpoint === name)?.parent_ms;
}

function checkpointChildMs(sample, scope, name) {
	const checkpoints =
		scope === "launcher"
			? sample.launcher_checkpoints
			: scope === "startup"
				? sample.startup_checkpoints
				: sample.query_checkpoints;
	return checkpoints.find((entry) => entry.checkpoint === name)?.child_ms;
}

function summarizeTimeline(samples) {
	const metric = (reader) => summarize(samples.map(reader));
	return {
		wall: metric((sample) => sample.wall_ms),
		first_json_event: metric((sample) => sample.first_json_event_ms),
		first_assistant_or_tool_event: metric(
			(sample) => sample.first_assistant_or_tool_event_ms,
		),
		first_tool_event: metric((sample) => sample.first_tool_event_ms),
		non_json_stdout_lines: metric((sample) => sample.non_json_stdout_lines),
		launcher_module_body_start_parent: metric((sample) =>
			checkpointParentMs(sample, "launcher", "module:body-start"),
		),
		launcher_run_start_parent: metric((sample) =>
			checkpointParentMs(sample, "launcher", "run:start"),
		),
		launcher_load_env_import_done_parent: metric((sample) =>
			checkpointParentMs(sample, "launcher", "load-env:import:done"),
		),
		launcher_load_env_call_done_parent: metric((sample) =>
			checkpointParentMs(sample, "launcher", "load-env:call:done"),
		),
		launcher_startup_refresh_done_parent: metric((sample) =>
			checkpointParentMs(sample, "launcher", "startup-refresh:call:done"),
		),
		launcher_direct_runtime_import_done_parent: metric((sample) =>
			checkpointParentMs(
				sample,
				"launcher",
				"direct-runtime-command:import:done",
			),
		),
		launcher_cli_command_skip_parent: metric((sample) =>
			checkpointParentMs(sample, "launcher", "cli-command-runtime:skip"),
		),
		launcher_main_runtime_accepted_parent: metric((sample) =>
			checkpointParentMs(sample, "launcher", "main-runtime:accepted"),
		),
		launcher_main_import_done_parent: metric((sample) =>
			checkpointParentMs(sample, "launcher", "main-runtime:import:done"),
		),
		startup_process_start_parent: metric((sample) =>
			checkpointParentMs(sample, "startup", "process:start"),
		),
		startup_agent_ready_child: metric((sample) =>
			checkpointChildMs(sample, "startup", "agent:ready"),
		),
		startup_exec_ready_child: metric((sample) =>
			checkpointChildMs(sample, "startup", "exec:ready"),
		),
		query_prompt_assembled_child: metric((sample) =>
			checkpointChildMs(sample, "query", "prompt:assembled"),
		),
		query_model_first_token_child: metric((sample) =>
			checkpointChildMs(sample, "query", "model:first-token"),
		),
		query_turn_complete_child: metric((sample) =>
			checkpointChildMs(sample, "query", "turn:complete"),
		),
	};
}

function printTable(results) {
	const rows = [
		[
			"launcher.module_body_start.parent_ms",
			results.timeline.launcher_module_body_start_parent.median_ms,
		],
		[
			"launcher.run_start.parent_ms",
			results.timeline.launcher_run_start_parent.median_ms,
		],
		[
			"launcher.load_env_done.parent_ms",
			results.timeline.launcher_load_env_call_done_parent.median_ms,
		],
		[
			"launcher.startup_refresh_done.parent_ms",
			results.timeline.launcher_startup_refresh_done_parent.median_ms,
		],
		[
			"launcher.direct_runtime_done.parent_ms",
			results.timeline.launcher_direct_runtime_import_done_parent.median_ms,
		],
		[
			"launcher.cli_command_skip.parent_ms",
			results.timeline.launcher_cli_command_skip_parent.median_ms,
		],
		[
			"launcher.main_runtime_accepted.parent_ms",
			results.timeline.launcher_main_runtime_accepted_parent.median_ms,
		],
		[
			"launcher.main_import_done.parent_ms",
			results.timeline.launcher_main_import_done_parent.median_ms,
		],
		[
			"startup.process_start.parent_ms",
			results.timeline.startup_process_start_parent.median_ms,
		],
		[
			"startup.agent_ready.child_ms",
			results.timeline.startup_agent_ready_child.median_ms,
		],
		[
			"startup.exec_ready.child_ms",
			results.timeline.startup_exec_ready_child.median_ms,
		],
		["turn.first_json.parent_ms", results.timeline.first_json_event.median_ms],
		[
			"turn.first_assistant_or_tool.parent_ms",
			results.timeline.first_assistant_or_tool_event.median_ms,
		],
		[
			"turn.non_json_stdout_lines.median",
			results.timeline.non_json_stdout_lines.median_ms,
		],
		[
			"query.prompt_assembled.child_ms",
			results.timeline.query_prompt_assembled_child.median_ms,
		],
		[
			"query.model_first_token.child_ms",
			results.timeline.query_model_first_token_child.median_ms,
		],
		["turn.wall.parent_ms", results.timeline.wall.median_ms],
	];
	for (const [label, value] of rows) {
		console.log(`${label.padEnd(48)} ${value}`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const profiledCli = createProfiledCli(options);
	const samples = [];
	try {
		for (let i = 0; i < options.iterations; i++) {
			samples.push(await runExecReplaySample(profiledCli.path));
		}
	} finally {
		profiledCli.dispose();
	}
	const failures = samples.filter((sample) => sample.status !== 0 || sample.error);
	const results = {
		recorded_at: new Date().toISOString(),
		iterations: options.iterations,
		profiled_cli_path: options.keepProfiledCli ? profiledCli.path : null,
		timeline: summarizeTimeline(samples),
		samples: samples.map((sample) => ({
			status: sample.status,
			error: sample.error,
			wall_ms: Number(sample.wall_ms.toFixed(1)),
			first_json_event_ms:
				sample.first_json_event_ms === undefined
					? undefined
					: Number(sample.first_json_event_ms.toFixed(1)),
			first_assistant_or_tool_event_ms:
				sample.first_assistant_or_tool_event_ms === undefined
					? undefined
					: Number(sample.first_assistant_or_tool_event_ms.toFixed(1)),
			non_json_stdout_lines: sample.non_json_stdout_lines,
			launcher_checkpoints: sample.launcher_checkpoints.map((entry) => ({
				checkpoint: entry.checkpoint,
				parent_ms: Number(entry.parent_ms.toFixed(1)),
				child_ms: Number(entry.child_ms.toFixed(1)),
			})),
			startup_checkpoints: sample.startup_checkpoints.map((entry) => ({
				checkpoint: entry.checkpoint,
				parent_ms: Number(entry.parent_ms.toFixed(1)),
				child_ms: Number(entry.child_ms.toFixed(1)),
			})),
			query_checkpoints: sample.query_checkpoints.map((entry) => ({
				checkpoint: entry.checkpoint,
				parent_ms: Number(entry.parent_ms.toFixed(1)),
				child_ms: Number(entry.child_ms.toFixed(1)),
			})),
			non_json_stdout_samples: sample.non_json_stdout_samples,
		})),
		failures,
	};
	if (options.json) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		printTable(results);
	}
	if (failures.length > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
