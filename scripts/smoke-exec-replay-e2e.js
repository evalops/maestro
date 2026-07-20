#!/usr/bin/env node
// @ts-check

/**
 * Exec / print / RPC golden-path smoke after the TS agent kill.
 *
 * Real scripted-replay lives on the Node shim + native handoff contract:
 * - `maestro exec` must launch native print (`--print`, `--output-last-message`)
 * - `maestro --mode rpc` must launch native headless
 *
 * The smoke installs a deterministic mock `maestro-tui` via MAESTRO_TUI_BIN so
 * CI does not need network or a full native scripted-replay provider. The mock
 * still exercises the CLI packaging path (dist/cli.js → native binary flags).
 */

import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTED_SCENARIO_SCHEMA = "evalops.maestro.scripted-scenario.v1";
const FINAL_TEXT = "Golden path completed with manifest evidence.";
const TOOL_CALL_ID = "call-read-package-json";
const SMOKE_TIMEOUT_ENV = "MAESTRO_EXEC_REPLAY_SMOKE_TIMEOUT_MS";
const LOCAL_SMOKE_TIMEOUT_MS = 60_000;
const CI_SMOKE_TIMEOUT_MS = 120_000;
const timeoutMs = resolveSmokeTimeoutMs();
const cliPath = join(process.cwd(), "dist", "cli.js");

export function defaultSmokeTimeoutMs(env = process.env) {
	return env.CI === "true" || env.GITHUB_ACTIONS === "true"
		? CI_SMOKE_TIMEOUT_MS
		: LOCAL_SMOKE_TIMEOUT_MS;
}

export function resolveSmokeTimeoutMs(env = process.env) {
	const rawValue = env[SMOKE_TIMEOUT_ENV];
	if (rawValue === undefined || rawValue === "") {
		return defaultSmokeTimeoutMs(env);
	}
	if (!/^\d+$/.test(rawValue)) {
		throw new Error(
			`${SMOKE_TIMEOUT_ENV} must be a positive integer of milliseconds.`,
		);
	}
	const parsedValue = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		throw new Error(
			`${SMOKE_TIMEOUT_ENV} must be a positive integer of milliseconds.`,
		);
	}
	return parsedValue;
}

export function describeSpawnSyncError(label, result, configuredTimeoutMs) {
	const errorCode = result.error?.code;
	const message =
		errorCode === "ETIMEDOUT"
			? `${label} timed out after ${configuredTimeoutMs}ms.`
			: `${label} failed to launch.`;
	const details = [
		`status: ${result.status ?? "null"}`,
		`signal: ${result.signal ?? "null"}`,
		result.error?.stack ?? String(result.error),
		result.stdout ? `stdout:\n${result.stdout}` : "",
		result.stderr ? `stderr:\n${result.stderr}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	return { message, details };
}

function fail(message, details) {
	console.error(message);
	if (details) {
		console.error(details);
	}
	process.exit(1);
}

/**
 * Mock maestro-tui that implements the golden-path responses the smoke asserts.
 * Written as a self-contained node script so CI does not need a shell with bashisms.
 */
function writeMockNativeBinary(runDir, sessionDir) {
	const mockPath = join(runDir, "mock-maestro-tui.mjs");
	const sessionFile = join(sessionDir, "smoke-session.jsonl");
	writeFileSync(
		mockPath,
		`#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const FINAL_TEXT = ${JSON.stringify(FINAL_TEXT)};
const TOOL_CALL_ID = ${JSON.stringify(TOOL_CALL_ID)};
const SESSION_FILE = ${JSON.stringify(sessionFile)};
const args = process.argv.slice(2);

function writeSession() {
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  const lines = [
    JSON.stringify({ type: "message", role: "assistant", text: "I will inspect the package manifest.", toolCallId: TOOL_CALL_ID }),
    JSON.stringify({ type: "tool_call", id: TOOL_CALL_ID, tool: "read", path: "package.json" }),
    JSON.stringify({ type: "message", role: "assistant", text: FINAL_TEXT }),
  ];
  writeFileSync(SESSION_FILE, lines.join("\\n") + "\\n");
}

function outputLastMessagePath() {
  const idx = args.indexOf("--output-last-message");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const eq = args.find((a) => a.startsWith("--output-last-message="));
  return eq ? eq.slice("--output-last-message=".length) : null;
}

const isHeadless = args.includes("--headless") || args.includes("--rpc");
const isPrint = args.includes("--print") || args.includes("exec") || args.includes("print");
const isJson = args.includes("--json");

if (isHeadless) {
  writeSession();
  console.log(JSON.stringify({
    type: "ready",
    protocol_version: "2026-04-02",
    model: "maestro-replay-v1",
    provider: "scripted-replay",
  }));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (msg.type === "hello") {
      console.log(JSON.stringify({ type: "hello_ok", protocol_version: "2026-04-02" }));
      return;
    }
    if (msg.type === "prompt") {
      console.log(JSON.stringify({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: TOOL_CALL_ID,
        isError: false,
      }));
      console.log(JSON.stringify({
        type: "agent_end",
        status: "ok",
      }));
      return;
    }
    if (msg.type === "get_state") {
      console.log(JSON.stringify({
        type: "state",
        id: msg.id ?? "state",
        state: {
          model: "maestro-replay-v1",
          messages: [
            { role: "assistant", content: FINAL_TEXT, toolCallId: TOOL_CALL_ID },
          ],
          queuedMessageCount: 0,
        },
      }));
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  // Print / exec path
  writeSession();
  const lastPath = outputLastMessagePath();
  if (lastPath) {
    writeFileSync(lastPath, FINAL_TEXT + "\\n");
  }

  if (isJson) {
    console.log(JSON.stringify({
      type: "item",
      subtype: "tool_call",
      data: { toolName: "read", toolCallId: TOOL_CALL_ID, args: { path: "package.json" } },
    }));
    console.log(JSON.stringify({
      type: "item",
      subtype: "tool_result",
      data: { toolCallId: TOOL_CALL_ID, isError: false, content: "{}" },
    }));
    console.log(JSON.stringify({
      type: "item",
      subtype: "message_complete",
      data: { text: FINAL_TEXT },
    }));
    console.log(JSON.stringify({ type: "done", status: "ok" }));
  } else if (isPrint || args.length > 0) {
    console.log(FINAL_TEXT);
  } else {
    console.error("mock-maestro-tui: expected --print, exec, or --headless");
    process.exit(2);
  }
  process.exit(0);
}
`,
	);
	chmodSync(mockPath, 0o755);
	return mockPath;
}

function createScenario(runDir, id) {
	const scenarioPath = join(runDir, `${id}.json`);
	writeFileSync(
		scenarioPath,
		`${JSON.stringify(
			{
				schemaVersion: SCRIPTED_SCENARIO_SCHEMA,
				id,
				description:
					"CLI golden path replay fixture (native handoff smoke).",
				metadata: {
					recordedFrom: "smoke-exec-replay-e2e",
					recordedAt: "2026-05-23T00:00:00.000Z",
					modelOriginal: "maestro-replay-v1",
					toolsExpected: ["read"],
					auditEvents: ["maestro.scenario.replay.ready"],
				},
				frames: [
					{
						index: 0,
						statements: [
							{ kind: "text", text: "I will inspect the package manifest." },
							{
								kind: "tool_call",
								id: TOOL_CALL_ID,
								tool: "read",
								input: { path: "package.json" },
								expectedResult: "success",
							},
						],
					},
					{
						index: 1,
						statements: [
							{ kind: "text", text: FINAL_TEXT },
							{ kind: "end", reason: "complete" },
						],
					},
				],
				assertions: [
					{ id: "read-tool-called", kind: "tool_called", tool: "read" },
					{
						id: "write-tool-not-called",
						kind: "tool_not_called",
						tool: "write",
					},
				],
			},
			null,
			2,
		)}\n`,
	);
	return scenarioPath;
}

function createRunContext(label) {
	const runDir = mkdtempSync(join(tmpdir(), `maestro-${label}-`));
	const home = join(runDir, "home");
	const maestroHome = join(runDir, "maestro-home");
	const agentDir = join(runDir, "agent");
	const sessionDir = join(runDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const mockBin = writeMockNativeBinary(runDir, sessionDir);
	return {
		runDir,
		scenarioPath: createScenario(runDir, label),
		lastMessagePath: join(runDir, "last-message.txt"),
		sessionDir,
		mockBin,
		env: {
			...process.env,
			HOME: home,
			MAESTRO_HOME: maestroHome,
			MAESTRO_AGENT_DIR: agentDir,
			MAESTRO_SESSION_DIR: sessionDir,
			MAESTRO_TUI_BIN: mockBin,
			// Avoid real provider traffic if anything leaks past the mock.
			ANTHROPIC_API_KEY: "test-key",
			OPENAI_API_KEY: "test-key",
			MAESTRO_SKIP_STARTUP_UPDATE: "1",
		},
	};
}

function parseJsonLines(stdout, label) {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				fail(
					`${label} emitted invalid JSON on stdout line ${index + 1}.`,
					`${line}\n${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
}

function collectFiles(dir) {
	if (!existsSync(dir)) return [];
	const files = [];
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			const stats = statSync(path);
			if (stats.isDirectory()) {
				pending.push(path);
			} else if (stats.isFile()) {
				files.push(path);
			}
		}
	}
	return files;
}

function sessionEvidenceFailure(sessionDir, label) {
	const sessionFiles = collectFiles(sessionDir).filter((path) =>
		path.endsWith(".jsonl"),
	);
	if (sessionFiles.length === 0) {
		return `${label} did not write a session JSONL file in ${sessionDir}.`;
	}
	const sessionText = sessionFiles
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
	if (!sessionText.includes(FINAL_TEXT) || !sessionText.includes(TOOL_CALL_ID)) {
		return `${label} session evidence is missing the final text or tool call id.`;
	}
	return null;
}

function assertSessionEvidence(sessionDir, label) {
	const failure = sessionEvidenceFailure(sessionDir, label);
	if (failure) fail(failure);
}

function assertExecJson(messages, context, label) {
	const toolCall = messages.find(
		(message) =>
			message?.type === "item" &&
			message?.subtype === "tool_call" &&
			message?.data?.toolName === "read",
	);
	if (toolCall?.data?.args?.path !== "package.json") {
		fail(`${label} did not emit the expected read tool_call JSONL event.`);
	}

	const toolResult = messages.find(
		(message) =>
			message?.type === "item" &&
			message?.subtype === "tool_result" &&
			message?.data?.toolCallId === TOOL_CALL_ID,
	);
	if (!toolResult || toolResult.data?.isError) {
		fail(`${label} did not emit a successful read tool_result JSONL event.`);
	}

	const finalMessage = messages
		.filter(
			(message) =>
				message?.type === "item" &&
				message?.subtype === "message_complete" &&
				typeof message?.data?.text === "string",
		)
		.at(-1);
	if (!finalMessage?.data?.text?.includes(FINAL_TEXT)) {
		fail(`${label} did not emit the final assistant response.`);
	}

	if (!messages.some((message) => message?.type === "done" && message.status === "ok")) {
		fail(`${label} did not emit a done ok event.`);
	}

	const captured = readFileSync(context.lastMessagePath, "utf8");
	if (!captured.includes(FINAL_TEXT)) {
		fail(`${label} did not write the final assistant response artifact.`);
	}
	assertSessionEvidence(context.sessionDir, label);
}

function runExecMode(label, extraArgs = []) {
	const context = createRunContext(label);
	try {
		const result = spawnSync(
			process.execPath,
			[
				cliPath,
				"exec",
				"--replay",
				context.scenarioPath,
				"--tools",
				"read",
				"--output-last-message",
				context.lastMessagePath,
				...extraArgs,
				"Replay the CLI golden path.",
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: context.env,
				timeout: timeoutMs,
			},
		);
		if (result.error) {
			const failure = describeSpawnSyncError(label, result, timeoutMs);
			fail(failure.message, failure.details);
		}
		if (result.status !== 0) {
			fail(
				`${label} exited with code ${result.status}.`,
				[result.stdout, result.stderr].filter(Boolean).join("\n\n"),
			);
		}
		return { context, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		rmSync(context.runDir, { recursive: true, force: true });
		throw error;
	}
}

function runTextMode() {
	const { context, stdout } = runExecMode("exec-replay-text");
	try {
		if (!stdout.includes(FINAL_TEXT)) {
			fail(
				"Text exec replay did not print the final assistant response.",
				stdout,
			);
		}
		const captured = readFileSync(context.lastMessagePath, "utf8");
		if (!captured.includes(FINAL_TEXT)) {
			fail(
				"Text exec replay did not write the final assistant response artifact.",
			);
		}
		assertSessionEvidence(context.sessionDir, "Text exec replay");
		console.log("Text exec replay smoke passed.");
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function runJsonMode() {
	const { context, stdout } = runExecMode("exec-replay-json", ["--json"]);
	try {
		assertExecJson(
			parseJsonLines(stdout, "JSON exec replay"),
			context,
			"JSON exec replay",
		);
		console.log("JSON exec replay smoke passed.");
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function runRpcMode() {
	return new Promise((resolve, reject) => {
		const context = createRunContext("exec-replay-rpc");
		const child = spawn(
			process.execPath,
			[
				cliPath,
				"--mode",
				"rpc",
				"--replay",
				context.scenarioPath,
				"--tools",
				"read",
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: context.env,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		const events = [];
		let stdoutBuffer = "";
		let stderr = "";
		let finished = false;
		let settled = false;
		let rpcEvidenceValidated = false;
		let forceKillTimer;
		const timer = setTimeout(() => {
			finish(new Error("RPC replay smoke timed out."));
		}, timeoutMs);

		function finish(error) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			const settle = () => {
				if (settled) return;
				settled = true;
				if (forceKillTimer) clearTimeout(forceKillTimer);
				let settleError = error;
				if (!settleError && rpcEvidenceValidated) {
					const failure = sessionEvidenceFailure(
						context.sessionDir,
						"RPC replay",
					);
					if (failure) {
						settleError = new Error(failure);
					}
				}
				rmSync(context.runDir, { recursive: true, force: true });
				if (settleError) reject(settleError);
				else resolve();
			};
			if (child.exitCode !== null || child.signalCode !== null) {
				settle();
				return;
			}
			child.once("exit", settle);
			if (!child.kill("SIGTERM")) {
				settle();
				return;
			}
			forceKillTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 2000);
			forceKillTimer.unref?.();
		}

		function handleEvent(event) {
			events.push(event);
			if (event.type === "ready" || event.type === "hello_ok") {
				return;
			}
			if (event.type === "agent_end") {
				child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
				return;
			}
			if (event.type !== "state") {
				return;
			}

			const hasReadTool = events.some(
				(candidate) =>
					candidate?.type === "tool_execution_end" &&
					candidate?.toolName === "read" &&
					!candidate?.isError,
			);
			const stateText = JSON.stringify(event.state ?? {});
			if (!hasReadTool) {
				finish(new Error("RPC replay smoke did not complete the read tool."));
				return;
			}
			if (!stateText.includes(FINAL_TEXT) || !stateText.includes(TOOL_CALL_ID)) {
				finish(
					new Error(
						"RPC replay state is missing the final text or read tool call.",
					),
				);
				return;
			}
			rpcEvidenceValidated = true;
			console.log("RPC replay smoke passed.");
			finish();
		}

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("{")) continue;
				try {
					handleEvent(JSON.parse(trimmed));
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => finish(error));
		child.on("exit", (code, signal) => {
			if (!finished && code !== 0) {
				finish(
					new Error(
						`RPC replay exited early with code ${code} signal ${signal}.\n${stderr}`,
					),
				);
			}
		});

		// Native headless expects hello first, then prompt.
		child.stdin.write(
			`${JSON.stringify({ type: "hello", protocol_version: "2026-04-02" })}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({ type: "prompt", message: "Replay the RPC golden path." })}\n`,
		);
	});
}

export async function main() {
	if (!existsSync(cliPath)) {
		fail("dist/cli.js is missing; run npm run build before this smoke.");
	}
	runTextMode();
	runJsonMode();
	await runRpcMode();
	console.log("Exec replay E2E smoke completed successfully.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await main();
}
