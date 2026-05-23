#!/usr/bin/env node
// @ts-check

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTED_SCENARIO_SCHEMA = "evalops.maestro.scripted-scenario.v1";
const FINAL_TEXT = "Golden path completed with manifest evidence.";
const TOOL_CALL_ID = "call-read-package-json";
const timeoutMs = Number.parseInt(
	process.env.MAESTRO_EXEC_REPLAY_SMOKE_TIMEOUT_MS ?? "45000",
	10,
);
const cliPath = join(process.cwd(), "dist", "cli.js");

if (!existsSync(cliPath)) {
	console.error("dist/cli.js is missing; run npm run build before this smoke.");
	process.exit(1);
}

function fail(message, details) {
	console.error(message);
	if (details) {
		console.error(details);
	}
	process.exit(1);
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
					"CLI golden path replay with one real read tool call and a final assistant response.",
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
							{
								kind: "text",
								text: "I will inspect the package manifest.",
							},
							{
								kind: "tool_call",
								id: TOOL_CALL_ID,
								tool: "read",
								input: {
									path: "package.json",
								},
								expectedResult: "success",
							},
						],
					},
					{
						index: 1,
						statements: [
							{
								kind: "text",
								text: FINAL_TEXT,
							},
							{
								kind: "end",
								reason: "complete",
							},
						],
					},
				],
				assertions: [
					{
						id: "read-tool-called",
						kind: "tool_called",
						tool: "read",
					},
					{
						id: "write-tool-not-called",
						kind: "tool_not_called",
						tool: "write",
					},
					{
						id: "audit-event-tagged",
						kind: "audit_event_emitted",
						eventType: "maestro.scenario.replay.ready",
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
	return {
		runDir,
		scenarioPath: createScenario(runDir, label),
		lastMessagePath: join(runDir, "last-message.txt"),
		sessionDir,
		env: {
			...process.env,
			HOME: home,
			MAESTRO_HOME: maestroHome,
			MAESTRO_AGENT_DIR: agentDir,
			MAESTRO_SESSION_DIR: sessionDir,
			ANTHROPIC_API_KEY: "test-key",
			OPENAI_API_KEY: "test-key",
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
	return readdirSync(dir, { recursive: true })
		.map((entry) => join(dir, String(entry)))
		.filter((path) => statSync(path).isFile());
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
			fail(`${label} failed to launch.`, result.error.stack);
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
			fail("Text exec replay did not print the final assistant response.");
		}
		const captured = readFileSync(context.lastMessagePath, "utf8");
		if (!captured.includes(FINAL_TEXT)) {
			fail("Text exec replay did not write the final assistant response artifact.");
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
		assertExecJson(parseJsonLines(stdout, "JSON exec replay"), context, "JSON exec replay");
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
		const timer = setTimeout(() => {
			finish(new Error("RPC replay smoke timed out."));
		}, timeoutMs);

		function finish(error) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			child.kill("SIGTERM");
			rmSync(context.runDir, { recursive: true, force: true });
			if (error) reject(error);
			else resolve();
		}

		function handleEvent(event) {
			events.push(event);
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

		child.stdin.write(
			`${JSON.stringify({ type: "prompt", message: "Replay the RPC golden path." })}\n`,
		);
	});
}

runTextMode();
runJsonMode();
await runRpcMode();
console.log("Exec replay E2E smoke completed successfully.");
