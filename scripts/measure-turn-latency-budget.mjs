#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
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

function parseProfileCheckpoints(stderr) {
	const startup = [];
	const query = [];
	for (const line of (stderr ?? "").split("\n")) {
		const match = line.match(/^\[(startup|query)\]\s+(\d+)ms\s+([^ ]+)/);
		if (!match) continue;
		const checkpoint = {
			ms: Number.parseInt(match[2], 10),
			checkpoint: match[3],
			line,
		};
		if (match[1] === "startup") {
			startup.push(checkpoint);
		} else {
			query.push(checkpoint);
		}
	}
	return { startup, query };
}

function firstCheckpointMs(checkpoints, name) {
	return checkpoints.find((entry) => entry.checkpoint === name)?.ms;
}

function summarizeOptional(samples) {
	return summarize(samples.filter((value) => Number.isFinite(value)));
}

function findFiles(root, predicate, results = []) {
	if (!existsSync(root)) {
		return results;
	}
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const fullPath = join(root, entry.name);
		if (entry.isDirectory()) {
			findFiles(fullPath, predicate, results);
		} else if (predicate(fullPath)) {
			results.push(fullPath);
		}
	}
	return results;
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
	const isAssistantDelta =
		event.type === "item" && event.subtype === "message_delta";
	const isTool =
		event.type === "item" &&
		["tool_call", "tool_result", "tool_update"].includes(event.subtype);
	return { isUser, isAssistantOrTool, isAssistantDelta, isTool };
}

function runExecReplaySample(readSessionEntries) {
	return new Promise((resolve) => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-exec-latency-"));
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
			first_assistant_delta_ms: undefined,
			first_tool_event_ms: undefined,
			first_non_json_stdout_line_ms: undefined,
			first_startup_profile_ms: undefined,
			startup_exec_ready_parent_ms: undefined,
			first_query_profile_ms: undefined,
			query_tools_prepared_parent_ms: undefined,
			query_model_first_token_parent_ms: undefined,
			query_turn_complete_parent_ms: undefined,
			stdout_lines: 0,
			non_json_stdout_lines: 0,
			non_json_stdout_samples: [],
			json_events: 0,
			session_file_visible_ms: undefined,
			session_read_duration_ms: undefined,
			session_entries: 0,
			session_file_count: 0,
			startup_checkpoints: [],
			query_checkpoints: [],
			error: undefined,
		};
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let stderr = "";
		let settled = false;

		const child = spawn(
			node,
			[
				cliPath,
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

		const processLine = (line) => {
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
			if (classification.isAssistantDelta) {
				sample.first_assistant_delta_ms ??= elapsed;
			}
			if (classification.isTool) {
				sample.first_tool_event_ms ??= elapsed;
			}
		};
		const processStderrLine = (line) => {
			if (!line.trim()) return;
			const match = line.match(/^\[(startup|query)\]\s+(\d+)ms\s+([^ ]+)/);
			if (!match) return;
			const elapsed = performance.now() - startedAt;
			const scope = match[1];
			const checkpoint = match[3];
			if (scope === "startup") {
				sample.first_startup_profile_ms ??= elapsed;
				if (checkpoint === "exec:ready") {
					sample.startup_exec_ready_parent_ms ??= elapsed;
				}
				return;
			}
			sample.first_query_profile_ms ??= elapsed;
			if (checkpoint === "tools:prepared") {
				sample.query_tools_prepared_parent_ms ??= elapsed;
			} else if (checkpoint === "model:first-token") {
				sample.query_model_first_token_parent_ms ??= elapsed;
			} else if (checkpoint === "turn:complete") {
				sample.query_turn_complete_parent_ms ??= elapsed;
			}
		};

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stderr += text;
			stderrBuffer += text;
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
				processLine(stdoutBuffer);
			}
			if (stderrBuffer) {
				processStderrLine(stderrBuffer);
			}
			sample.status = status;
			sample.signal = signal;
			sample.wall_ms = performance.now() - startedAt;
			const checkpoints = parseProfileCheckpoints(stderr);
			sample.startup_checkpoints = checkpoints.startup;
			sample.query_checkpoints = checkpoints.query;

			const sessionReadStart = performance.now();
			try {
				const sessionFiles = findFiles(
					sessionDir,
					(filePath) =>
						filePath.endsWith(".jsonl") &&
						!filePath.endsWith("session-migration-state.jsonl"),
				);
				sample.session_file_count = sessionFiles.length;
				if (sessionFiles[0]) {
					const entries = readSessionEntries(sessionFiles[0]);
					sample.session_entries = entries.length;
					sample.session_file_visible_ms = performance.now() - startedAt;
				}
				sample.session_read_duration_ms = performance.now() - sessionReadStart;
			} catch (error) {
				sample.error = error instanceof Error ? error.message : String(error);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			resolve(sample);
		});
	});
}

async function measureExecReplayTimeline(iterations) {
	const { readSessionEntries } = await import(
		join(repoRoot, "dist", "session", "session-context.js")
	);
	const samples = [];
	const failures = [];
	for (let i = 0; i < iterations; i++) {
		const sample = await runExecReplaySample(readSessionEntries);
		samples.push(sample);
		if (sample.status !== 0 || sample.error) {
			failures.push({
				status: sample.status,
				signal: sample.signal,
				error: sample.error,
			});
		}
	}

	const startupCheckpointSamples = (name) =>
		samples
			.map((sample) => firstCheckpointMs(sample.startup_checkpoints, name))
			.filter((value) => value !== undefined);
	const queryCheckpointSamples = (name) =>
		samples
			.map((sample) => firstCheckpointMs(sample.query_checkpoints, name))
			.filter((value) => value !== undefined);

	return {
		wall: summarize(samples.map((sample) => sample.wall_ms)),
		first_stdout_line: summarizeOptional(
			samples.map((sample) => sample.first_stdout_line_ms),
		),
		first_non_json_stdout_line: summarizeOptional(
			samples.map((sample) => sample.first_non_json_stdout_line_ms),
		),
		first_json_event: summarizeOptional(
			samples.map((sample) => sample.first_json_event_ms),
		),
		first_user_json_event: summarizeOptional(
			samples.map((sample) => sample.first_user_json_event_ms),
		),
		first_assistant_or_tool_event: summarizeOptional(
			samples.map((sample) => sample.first_assistant_or_tool_event_ms),
		),
		first_assistant_delta: summarizeOptional(
			samples.map((sample) => sample.first_assistant_delta_ms),
		),
		first_tool_event: summarizeOptional(
			samples.map((sample) => sample.first_tool_event_ms),
		),
		session_file_visible_after_exit: summarizeOptional(
			samples.map((sample) => sample.session_file_visible_ms),
		),
		session_read_after_exit: summarizeOptional(
			samples.map((sample) => sample.session_read_duration_ms),
		),
		startup_process_start_parent: summarizeOptional(
			samples.map((sample) => sample.first_startup_profile_ms),
		),
		startup_exec_ready_parent: summarizeOptional(
			samples.map((sample) => sample.startup_exec_ready_parent_ms),
		),
		startup_agent_ready: summarizeOptional(startupCheckpointSamples("agent:ready")),
		startup_exec_ready: summarizeOptional(startupCheckpointSamples("exec:ready")),
		query_prompt_assembled: summarizeOptional(
			queryCheckpointSamples("prompt:assembled"),
		),
		query_tools_prepared: summarizeOptional(
			queryCheckpointSamples("tools:prepared"),
		),
		query_tools_prepared_parent: summarizeOptional(
			samples.map((sample) => sample.query_tools_prepared_parent_ms),
		),
		query_model_request_start: summarizeOptional(
			queryCheckpointSamples("model:request:start"),
		),
		query_model_first_token: summarizeOptional(
			queryCheckpointSamples("model:first-token"),
		),
		query_model_first_token_parent: summarizeOptional(
			samples.map((sample) => sample.query_model_first_token_parent_ms),
		),
		query_turn_complete: summarizeOptional(
			queryCheckpointSamples("turn:complete"),
		),
		query_turn_complete_parent: summarizeOptional(
			samples.map((sample) => sample.query_turn_complete_parent_ms),
		),
		stdout_lines: summarize(samples.map((sample) => sample.stdout_lines)),
		non_json_stdout_lines: summarize(
			samples.map((sample) => sample.non_json_stdout_lines),
		),
		non_json_stdout_samples: samples
			.flatMap((sample) => sample.non_json_stdout_samples)
			.filter((line, index, lines) => lines.indexOf(line) === index)
			.slice(0, 10),
		json_events: summarize(samples.map((sample) => sample.json_events)),
		session_entries: summarize(samples.map((sample) => sample.session_entries)),
		samples: samples.map((sample) => ({
			status: sample.status,
			wall_ms: Number(sample.wall_ms.toFixed(1)),
			first_non_json_stdout_line_ms:
				sample.first_non_json_stdout_line_ms === undefined
					? undefined
					: Number(sample.first_non_json_stdout_line_ms.toFixed(1)),
			first_json_event_ms:
				sample.first_json_event_ms === undefined
					? undefined
					: Number(sample.first_json_event_ms.toFixed(1)),
			first_assistant_or_tool_event_ms:
				sample.first_assistant_or_tool_event_ms === undefined
					? undefined
					: Number(sample.first_assistant_or_tool_event_ms.toFixed(1)),
			startup_process_start_parent_ms:
				sample.first_startup_profile_ms === undefined
					? undefined
					: Number(sample.first_startup_profile_ms.toFixed(1)),
			startup_exec_ready_parent_ms:
				sample.startup_exec_ready_parent_ms === undefined
					? undefined
					: Number(sample.startup_exec_ready_parent_ms.toFixed(1)),
			query_tools_prepared_parent_ms:
				sample.query_tools_prepared_parent_ms === undefined
					? undefined
					: Number(sample.query_tools_prepared_parent_ms.toFixed(1)),
			query_model_first_token_parent_ms:
				sample.query_model_first_token_parent_ms === undefined
					? undefined
					: Number(sample.query_model_first_token_parent_ms.toFixed(1)),
			query_turn_complete_parent_ms:
				sample.query_turn_complete_parent_ms === undefined
					? undefined
					: Number(sample.query_turn_complete_parent_ms.toFixed(1)),
			non_json_stdout_lines: sample.non_json_stdout_lines,
			session_entries: sample.session_entries,
		})),
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

function camelTraceRowToListRow(row) {
	return {
		trace_id: row.traceId,
		workspace_id: row.workspaceId,
		agent_id: row.agentId,
		duration_ms: row.durationMs,
		status: row.status,
		spans: row.spans,
		span_count: Array.isArray(row.spans) ? row.spans.length : 0,
		created_at: row.createdAt,
	};
}

function createInMemoryTraceDb() {
	const rows = new Map();
	return {
		insert() {
			let pending;
			return {
				values(value) {
					pending = value;
					return this;
				},
				onConflictDoUpdate() {
					return this;
				},
				async returning() {
					const previous = rows.get(pending.traceId);
					const createdAt =
						previous && previous.createdAt < pending.createdAt
							? previous.createdAt
							: pending.createdAt;
					const row = { ...pending, createdAt };
					rows.set(row.traceId, row);
					return [row];
				},
			};
		},
		select() {
			return {
				from() {
					return {
						where() {
							return {
								limit() {
									return Array.from(rows.values()).slice(0, 1);
								},
							};
						},
					};
				},
			};
		},
		async execute() {
			return Array.from(rows.values())
				.sort((a, b) => {
					const createdDelta =
						new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
					return createdDelta || a.traceId.localeCompare(b.traceId);
				})
				.map(camelTraceRowToListRow);
		},
	};
}

async function measureTraceServiceVisibility(iterations) {
	const { TracesService } = await import(
		join(repoRoot, "dist", "services", "traces", "index.js")
	);
	const writeSamples = [];
	const readSamples = [];
	const indexSamples = [];
	const totalSamples = [];
	const spanCount = 25;

	for (let i = 0; i < iterations; i++) {
		const db = createInMemoryTraceDb();
		const service = new TracesService(() => db, () => true);
		const input = {
			...sampleTraceInput(spanCount),
			traceId: `trace-latency-${i}`,
			createdAt: new Date(1_000 + i).toISOString(),
		};
		const totalStart = performance.now();
		const writeStart = performance.now();
		const recorded = await service.recordTrace(input);
		writeSamples.push(performance.now() - writeStart);

		const readStart = performance.now();
		const read = await service.getTrace(recorded.traceId);
		readSamples.push(performance.now() - readStart);

		const indexStart = performance.now();
		const listed = await service.listTraces({ limit: 10, offset: 0 });
		indexSamples.push(performance.now() - indexStart);
		totalSamples.push(performance.now() - totalStart);

		if (read?.traceId !== recorded.traceId) {
			throw new Error("Trace read visibility failed");
		}
		if (
			!listed.traces.some((trace) => trace.traceId === recorded.traceId)
		) {
			throw new Error("Trace index visibility failed");
		}
	}

	return {
		span_count: spanCount,
		write_flush: summarize(writeSamples),
		read_visible: summarize(readSamples),
		index_visible: summarize(indexSamples),
		total_write_read_index: summarize(totalSamples),
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
	);
	const { StreamingView } = await import(
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
		[
			"turn.exec_runtime_start_parent.median_ms",
			results.exec_replay.startup_process_start_parent.median_ms,
		],
		[
			"turn.exec_ready_parent.median_ms",
			results.exec_replay.startup_exec_ready_parent.median_ms,
		],
		[
			"turn.exec_first_json.median_ms",
			results.exec_replay.first_json_event.median_ms,
		],
		[
			"turn.exec_non_json_stdout_lines.median",
			results.exec_replay.non_json_stdout_lines.median_ms,
		],
		[
			"turn.exec_first_assistant_or_tool.median_ms",
			results.exec_replay.first_assistant_or_tool_event.median_ms,
		],
		[
			"turn.exec_query_prompt_assembled.median_ms",
			results.exec_replay.query_prompt_assembled.median_ms,
		],
		[
			"turn.exec_complete.median_ms",
			results.exec_replay.query_turn_complete.median_ms,
		],
		["session.write_read.median_ms", results.session_io.median_ms],
		["trace.normalize_export.median_ms", results.traces.median_ms],
		[
			"trace.write_read_index.median_ms",
			results.trace_service.total_write_read_index.median_ms,
		],
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
		exec_replay: await measureExecReplayTimeline(options.iterations),
		session_io: await measureSessionWriteRead(options.iterations),
		traces: await measureTraceNormalizeExport(options.iterations),
		trace_service: await measureTraceServiceVisibility(options.iterations),
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
