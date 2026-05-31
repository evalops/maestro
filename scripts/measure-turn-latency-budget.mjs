#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const repoRoot = process.cwd();
const node = process.execPath;
const cliPath = join(repoRoot, "dist", "cli.js");

function parseArgs(argv) {
	const options = {
		iterations: 8,
		json: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") {
			options.json = true;
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
	const sorted = [...samples].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	return {
		min_ms: Number(sorted[0]?.toFixed(1) ?? 0),
		median_ms: Number(percentile(sorted, 50).toFixed(1)),
		p90_ms: Number(percentile(sorted, 90).toFixed(1)),
		max_ms: Number(sorted[sorted.length - 1]?.toFixed(1) ?? 0),
		mean_ms: Number((total / Math.max(1, sorted.length)).toFixed(1)),
		samples_ms: sorted.map((value) => Number(value.toFixed(1))),
	};
}

function time(fn) {
	const start = performance.now();
	const result = fn();
	return { durationMs: performance.now() - start, result };
}

async function withQuietConsole(fn) {
	const originalLog = console.log;
	const originalInfo = console.info;
	const originalWarn = console.warn;
	try {
		console.log = () => {};
		console.info = () => {};
		console.warn = () => {};
		return await fn();
	} finally {
		console.log = originalLog;
		console.info = originalInfo;
		console.warn = originalWarn;
	}
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

async function measurePromptAssembly(iterations) {
	const { buildBundledSystemPromptBase, finalizeSystemPrompt } =
		await withQuietConsole(() =>
			import(join(repoRoot, "dist", "cli", "system-prompt.js")),
		);
	const { loadPromptProjectDocManifest } = await withQuietConsole(() =>
		import(join(repoRoot, "dist", "config", "index.js")),
	);
	const basePrompt = buildBundledSystemPromptBase(["read"]);
	const runtimeConstraints = {
		sandboxMode: "none",
		sandboxEnabled: false,
	};
	const contextSamples = [];
	const finalizeSamples = [];
	const combinedSamples = [];
	let systemBytes = 0;
	let projectDocEntries = 0;
	let projectDocBytes = 0;

	for (let i = 0; i < iterations; i++) {
		const combinedStart = performance.now();
		const contextStart = performance.now();
		const promptContextManifest = await withQuietConsole(() =>
			loadPromptProjectDocManifest(repoRoot),
		);
		contextSamples.push(performance.now() - contextStart);

		const { durationMs, result: systemPrompt } = time(() =>
			finalizeSystemPrompt(basePrompt, undefined, repoRoot, {
				promptContextManifest,
				runtimeConstraints,
			}),
		);
		finalizeSamples.push(durationMs);
		combinedSamples.push(performance.now() - combinedStart);
		systemBytes = systemPrompt.length;
		projectDocEntries = promptContextManifest.entries.length;
		projectDocBytes = promptContextManifest.bytesRead;
	}

	return {
		system_bytes: systemBytes,
		project_doc_entries: projectDocEntries,
		project_doc_bytes: projectDocBytes,
		context_manifest: summarize(contextSamples),
		finalize: summarize(finalizeSamples),
		combined: summarize(combinedSamples),
	};
}

function measureCommand(label, args, iterations) {
	const samples = [];
	const failures = [];
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		const result = spawnSync(node, [cliPath, ...args], {
			cwd: repoRoot,
			env: commandEnv(),
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		});
		samples.push(performance.now() - start);
		if (result.status !== 0) {
			failures.push({
				status: result.status,
				stderr: result.stderr?.slice(0, 500) ?? "",
				stdout: result.stdout?.slice(0, 500) ?? "",
			});
		}
	}
	return {
		label,
		args,
		...summarize(samples),
		failures,
	};
}

function measureMockTurn(iterations) {
	const samples = [];
	const failures = [];
	for (let i = 0; i < Math.max(3, Math.ceil(iterations / 2)); i++) {
		const start = performance.now();
		const result = spawnSync(node, ["scripts/run-mock-agent.js", "README.md"], {
			cwd: repoRoot,
			env: commandEnv(),
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 1024 * 1024,
		});
		samples.push(performance.now() - start);
		if (result.status !== 0) {
			failures.push({
				status: result.status,
				stderr: result.stderr?.slice(0, 500) ?? "",
			});
		}
	}

	const profile = spawnSync(node, ["scripts/run-mock-agent.js", "README.md"], {
		cwd: repoRoot,
		env: commandEnv({ MAESTRO_QUERY_PROFILE: "1" }),
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 1024 * 1024,
	});
	const checkpoints = [];
	for (const line of (profile.stderr ?? "").split("\n")) {
		const match = line.match(/^\[query\]\s+(\d+)ms\s+([^ ]+)/);
		if (match) {
			checkpoints.push({
				ms: Number.parseInt(match[1], 10),
				checkpoint: match[2],
				line,
			});
		}
	}

	return {
		...summarize(samples),
		profile_status: profile.status,
		profile_checkpoints: checkpoints,
		failures,
	};
}

async function measureSessionWriteRead(iterations) {
	const { SessionFileWriter } = await import(
		join(repoRoot, "dist", "session", "file-writer.js")
	);
	const { readSessionEntries } = await import(
		join(repoRoot, "dist", "session", "session-context.js")
	);

	const samples = [];
	const entryCount = 500;
	for (let i = 0; i < iterations; i++) {
		const dir = mkdtempSync(join(tmpdir(), "maestro-session-latency-"));
		const file = join(dir, "session.jsonl");
		const { durationMs } = time(() => {
			const writer = new SessionFileWriter(file, 50);
			for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
				writer.write({
					type: "message",
					id: `entry-${entryIndex}`,
					parentId: entryIndex === 0 ? null : `entry-${entryIndex - 1}`,
					timestamp: new Date(0).toISOString(),
					message: {
						role: entryIndex % 2 === 0 ? "user" : "assistant",
						content: [{ type: "text", text: `message ${entryIndex}` }],
					},
				});
			}
			writer.flushSync();
			writer.dispose();
			const entries = readSessionEntries(file);
			if (entries.length !== entryCount) {
				throw new Error(`Expected ${entryCount} entries, got ${entries.length}`);
			}
		});
		samples.push(durationMs);
		rmSync(dir, { recursive: true, force: true });
	}
	return {
		entries: entryCount,
		...summarize(samples),
	};
}

function sampleTraceInput(spanCount) {
	const children = [];
	for (let i = 1; i < spanCount; i++) {
		children.push({
			name: `tool/call/${i}`,
			kind: "tool_call",
			status: "ok",
			durationMs: 5 + i,
			attributes: {
				"maestro.tool.name": "read",
				"maestro.sequence": i,
			},
			input: { path: `file-${i}.ts` },
			output: { bytes: i * 17 },
		});
	}
	return {
		workspaceId: "workspace-latency-budget",
		agentId: "agent-latency-budget",
		status: "completed",
		durationMs: 250,
		createdAt: "2026-05-31T00:00:00.000Z",
		spans: [
			{
				name: "agent/run",
				kind: "reasoning",
				status: "ok",
				durationMs: 250,
				attributes: { "gen_ai.request.model": "gpt-5" },
				children,
			},
		],
	};
}

async function measureTraceNormalizeExport(iterations) {
	const { normalizeExecutionTraceInput, exportTraceToOpenTelemetry } =
		await import(join(repoRoot, "dist", "services", "traces", "index.js"));
	const samples = [];
	const spanCount = 25;
	for (let i = 0; i < iterations * 25; i++) {
		const { durationMs } = time(() => {
			const trace = normalizeExecutionTraceInput(sampleTraceInput(spanCount));
			const exported = exportTraceToOpenTelemetry(trace);
			if (!exported.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length) {
				throw new Error("Trace export produced no spans");
			}
		});
		samples.push(durationMs);
	}
	return {
		span_count: spanCount,
		...summarize(samples),
	};
}

function baseAssistant(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "latency-budget",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function measureLowBandwidthUi(iterations) {
	const { AgentEventRouter } = await import(
		join(repoRoot, "dist", "cli-tui", "agent-event-router.js")
	);
	const { StreamingView } = await import(
		join(repoRoot, "dist", "cli-tui", "streaming-view.js")
	);
	const samples = [];
	const renderSamples = [];
	const updateCount = 500;

	for (let i = 0; i < Math.max(3, Math.ceil(iterations / 2)); i++) {
		const chatContainer = {
			children: [],
			addChild(child) {
				this.children.push(child);
			},
			removeChild(child) {
				this.children = this.children.filter((candidate) => candidate !== child);
			},
		};
		let renderRequests = 0;
		const streamingView = new StreamingView({
			chatContainer,
			toolOutputView: { registerToolComponent() {} },
			pendingTools: new Map(),
			disableAnimations: true,
			lowBandwidth: {
				enabled: true,
				batchIntervalMs: 1,
				scrollbackLimit: 100,
			},
			getCleanMode: () => "off",
			requestRender: () => {
				renderRequests++;
			},
		});
		const router = new AgentEventRouter({
			messageView: { addMessage() {} },
			streamingView,
			loaderView: {
				beginTurn() {},
				completeTurn() {},
				setStreamingActive() {},
				maybeTransitionToResponding() {},
				registerToolStage() {},
				markToolComplete() {},
				showRuntimeStatus() {},
				showCompactionNotice() {},
				showRuntimeError() {},
				showToolBatchSummary() {},
			},
			runController: {
				handleAgentStart() {},
				handleAgentEnd(callback) {
					callback();
				},
			},
			sessionContext: {
				beginTurn() {},
				completeTurn() {},
				setLastUserMessage() {},
				setLastAssistantMessage() {},
				recordPrompt() {},
				recordToolUsage() {},
				recordToolStart() {},
				recordToolEnd() {},
			},
			extractText: () => "",
			clearEditor() {},
			requestRender: () => {
				renderRequests++;
			},
			clearPendingTools() {},
			refreshPlanHint() {},
		});

		const { durationMs } = time(() => {
			router.handle({ type: "message_start", message: baseAssistant("") });
			for (let updateIndex = 0; updateIndex < updateCount; updateIndex++) {
				router.handle({
					type: "message_update",
					message: baseAssistant(`token ${updateIndex}`),
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "x",
					},
				});
			}
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		streamingView.finishAssistantMessage(baseAssistant("final"));
		samples.push(durationMs);
		renderSamples.push(renderRequests);
	}

	return {
		updates: updateCount,
		handle_loop: summarize(samples),
		render_requests: summarize(renderSamples),
	};
}

function printTable(results) {
	const rows = [
		["bundle.cli_js_bytes", results.bundle.cli_js_bytes],
		["bundle.cli_runtime_js_bytes", results.bundle.cli_runtime_js_bytes],
		[
			"startup.version.median_ms",
			results.commands["startup.version"].median_ms,
		],
		["startup.help.median_ms", results.commands["startup.help"].median_ms],
		[
			"command.skill_help.median_ms",
			results.commands["command.skill_help"].median_ms,
		],
		[
			"command.update_help.median_ms",
			results.commands["command.update_help"].median_ms,
		],
		[
			"prompt.context_manifest.median_ms",
			results.prompt_context.context_manifest.median_ms,
		],
		["prompt.finalize.median_ms", results.prompt_context.finalize.median_ms],
		["prompt.combined.median_ms", results.prompt_context.combined.median_ms],
		["turn.mock_wall.median_ms", results.mock_turn.median_ms],
		[
			"turn.mock_tools_prepared_ms",
			results.mock_turn.profile_checkpoints.at(-1)?.ms ?? "n/a",
		],
		["session.write_read.median_ms", results.session_io.median_ms],
		["trace.normalize_export.median_ms", results.traces.median_ms],
		[
			"ui.low_bw.render_requests.median",
			results.ui_low_bandwidth.render_requests.median_ms,
		],
	];
	for (const [label, value] of rows) {
		console.log(`${label.padEnd(38)} ${value}`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!existsSync(cliPath)) {
		throw new Error("dist/cli.js is missing. Run `npm run build` first.");
	}

	const commands = {};
	for (const [label, args] of [
		["startup.version", ["--version"]],
		["startup.help", ["--help"]],
		["command.skill_help", ["skill", "--help"]],
		["command.update_help", ["update", "--help"]],
	]) {
		commands[label] = measureCommand(label, args, options.iterations);
	}

	const results = {
		recorded_at: new Date().toISOString(),
		iterations: options.iterations,
		bundle: {
			cli_js_bytes: statSync(cliPath).size,
			cli_runtime_js_bytes: statSync(join(repoRoot, "dist", "cli-runtime.js"))
				.size,
		},
		commands,
		prompt_context: await measurePromptAssembly(options.iterations),
		mock_turn: measureMockTurn(options.iterations),
		session_io: await measureSessionWriteRead(options.iterations),
		traces: await measureTraceNormalizeExport(options.iterations),
		ui_low_bandwidth: await measureLowBandwidthUi(options.iterations),
	};

	if (options.json) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		printTable(results);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
