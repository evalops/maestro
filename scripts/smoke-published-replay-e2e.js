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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getNpmCommand,
	installedBinPath,
	runInstalledCliSmoke,
} from "./install-smoke-utils.js";
import { getPackageMetadata } from "./package-metadata.js";

const SCRIPTED_SCENARIO_SCHEMA = "evalops.maestro.scripted-scenario.v1";
const FINAL_TEXT =
	"Published package golden path completed with manifest evidence.";
const TOOL_CALL_ID = "call-read-package-json";
const PROMPT_TEXT = "Replay the published package golden path.";
const timeoutMs = Number.parseInt(
	process.env.MAESTRO_PUBLISHED_REPLAY_E2E_TIMEOUT_MS ?? "45000",
	10,
);

function fail(message, details) {
	console.error(message);
	if (details) {
		console.error(details);
	}
	process.exit(1);
}

function parseArgs(argv) {
	/** @type {{packageName: string; version: string; cliCommand: string; installRoot: string}} */
	const options = {
		packageName: "",
		version: "",
		cliCommand: "",
		installRoot: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--package":
				options.packageName = argv[++index] ?? "";
				break;
			case "--version":
				options.version = argv[++index] ?? "";
				break;
			case "--cli-command":
				options.cliCommand = argv[++index] ?? "";
				break;
			case "--install-root":
				options.installRoot = argv[++index] ?? "";
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
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
					"Published package replay with one real read tool call and a final assistant response.",
				metadata: {
					recordedFrom: "smoke-published-replay-e2e",
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
								text: "I will inspect the published package manifest.",
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
	const runDir = mkdtempSync(join(tmpdir(), `maestro-published-${label}-`));
	const home = join(runDir, "home");
	const maestroHome = join(runDir, "maestro-home");
	const agentDir = join(runDir, "agent");
	const sessionDir = join(runDir, "sessions");
	writeFileSync(
		join(runDir, "package.json"),
		`${JSON.stringify(
			{
				name: `maestro-published-${label}`,
				version: "1.0.0",
				private: true,
			},
			null,
			2,
		)}\n`,
	);
	return {
		runDir,
		scenarioPath: createScenario(runDir, label),
		sessionDir,
		env: {
			...process.env,
			CI: "1",
			NO_COLOR: "1",
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
	const files = [];
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
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

function assertSessionEvidence(sessionDir, label) {
	const sessionFiles = collectFiles(sessionDir).filter((path) =>
		path.endsWith(".jsonl"),
	);
	if (sessionFiles.length === 0) {
		fail(`${label} did not write a session JSONL file in ${sessionDir}.`);
	}
	const sessionText = sessionFiles
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
	if (!sessionText.includes(FINAL_TEXT) || !sessionText.includes(TOOL_CALL_ID)) {
		fail(`${label} session evidence is missing the final text or tool call id.`);
	}
}

function assertJsonMode(messages, context, label) {
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
	if (finalMessage.data?.provider !== "scripted-replay") {
		fail(`${label} did not run through the scripted replay provider.`);
	}

	if (
		!messages.some(
			(message) =>
				message?.type === "thread" &&
				message?.phase === "end" &&
				message?.status === "ok",
		)
	) {
		fail(`${label} did not emit a thread end ok event.`);
	}

	assertSessionEvidence(context.sessionDir, label);
}

function runSingleShotMode(binPath, label, mode) {
	const context = createRunContext(label);
	try {
		const result = spawnSync(
			binPath,
			[
				"--replay",
				context.scenarioPath,
				"--mode",
				mode,
				"--approval-mode",
				"auto",
				"--sandbox",
				"workspace-write",
				"--tools",
				"read",
				PROMPT_TEXT,
			],
			{
				cwd: context.runDir,
				encoding: "utf8",
				env: context.env,
				timeout: timeoutMs,
			},
		);
		if (result.error) {
			fail(`${label} failed to launch.`, result.error.stack);
		}
		if (result.signal) {
			fail(
				`${label} terminated by signal ${result.signal}.`,
				[result.stdout, result.stderr].filter(Boolean).join("\n\n"),
			);
		}
		if (result.status !== 0) {
			fail(
				`${label} exited with code ${result.status}.`,
				[result.stdout, result.stderr].filter(Boolean).join("\n\n"),
			);
		}
		return { context, stdout: result.stdout };
	} catch (error) {
		rmSync(context.runDir, { recursive: true, force: true });
		throw error;
	}
}

function runTextMode(binPath) {
	const { context, stdout } = runSingleShotMode(
		binPath,
		"replay-text",
		"text",
	);
	try {
		if (!stdout.includes(FINAL_TEXT)) {
			fail("Published text replay did not print the final assistant response.");
		}
		assertSessionEvidence(context.sessionDir, "Published text replay");
		console.log("Published text replay smoke passed.");
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function runJsonMode(binPath) {
	const { context, stdout } = runSingleShotMode(
		binPath,
		"replay-json",
		"json",
	);
	try {
		assertJsonMode(
			parseJsonLines(stdout, "Published JSON replay"),
			context,
			"Published JSON replay",
		);
		console.log("Published JSON replay smoke passed.");
	} finally {
		rmSync(context.runDir, { recursive: true, force: true });
	}
}

function assertRpcEvents(events, context) {
	if (!events.some((event) => event?.type === "agent_start")) {
		fail("Published RPC replay did not emit agent_start.");
	}
	if (
		!events.some(
			(event) =>
				event?.type === "tool_execution_start" &&
				event?.toolName === "read" &&
				event?.args?.path === "package.json",
		)
	) {
		fail("Published RPC replay did not emit the expected read tool start.");
	}
	if (
		!events.some(
			(event) =>
				event?.type === "tool_execution_end" &&
				event?.toolName === "read" &&
				!event?.isError,
		)
	) {
		fail("Published RPC replay did not emit a successful read tool result.");
	}
	const agentEnd = events.findLast?.((event) => event?.type === "agent_end");
	if (!agentEnd || agentEnd.aborted) {
		fail("Published RPC replay did not emit a successful agent_end event.");
	}
	const stateText = JSON.stringify(agentEnd);
	if (!stateText.includes(FINAL_TEXT) || !stateText.includes(TOOL_CALL_ID)) {
		fail("Published RPC replay final state is missing replay evidence.");
	}
}

function runRpcMode(binPath) {
	return new Promise((resolvePromise, reject) => {
		const context = createRunContext("replay-rpc");
		const child = spawn(
			binPath,
			[
				"--mode",
				"rpc",
				"--replay",
				context.scenarioPath,
				"--approval-mode",
				"auto",
				"--sandbox",
				"workspace-write",
				"--tools",
				"read",
			],
			{
				cwd: context.runDir,
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
		let forceKillTimer;
		const timer = setTimeout(() => {
			finish(new Error("Published RPC replay smoke timed out."));
		}, timeoutMs);

		function settle(error) {
			if (settled) return;
			settled = true;
			if (forceKillTimer) clearTimeout(forceKillTimer);
			rmSync(context.runDir, { recursive: true, force: true });
			if (error) reject(error);
			else resolvePromise();
		}

		function finish(error) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (child.exitCode !== null || child.signalCode !== null) {
				settle(error);
				return;
			}
			child.once("exit", () => settle(error));
			if (!child.kill("SIGTERM")) {
				settle(error);
				return;
			}
			forceKillTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 2000);
			forceKillTimer.unref?.();
		}

		function handleEvent(event) {
			events.push(event);
			if (event?.type !== "agent_end") {
				return;
			}
			try {
				assertRpcEvents(events, context);
				console.log("Published RPC replay smoke passed.");
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
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
						`Published RPC replay exited early with code ${code} signal ${signal}.\n${stderr}`,
					),
				);
			}
		});

		child.stdin.write(`${JSON.stringify({ type: "prompt", message: PROMPT_TEXT })}\n`);
	});
}

export async function runPublishedReplayE2E({
	installRoot,
	cliCommand,
	packageSpec,
}) {
	if (process.env.MAESTRO_SKIP_PUBLISHED_REPLAY_E2E === "1") {
		console.log(`Skipping published replay E2E smoke for ${packageSpec}.`);
		return;
	}

	const binPath = installedBinPath(installRoot, cliCommand);
	runTextMode(binPath);
	runJsonMode(binPath);
	await runRpcMode(binPath);
	console.log(`Published replay E2E smoke passed for ${packageSpec}.`);
}

async function main() {
	const defaults = getPackageMetadata();
	const overrides = parseArgs(process.argv.slice(2));
	const cliCommand = overrides.cliCommand || defaults.cliCommand;
	const name = overrides.packageName || defaults.name;
	const version = overrides.version || defaults.version;
	const packageSpec = `${name}@${version}`;
	const npmCommand = getNpmCommand();
	let installRoot = overrides.installRoot
		? resolve(overrides.installRoot)
		: "";
	const shouldCleanup = !installRoot;

	if (!installRoot) {
		installRoot = mkdtempSync(join(tmpdir(), "maestro-published-replay-install-"));
		try {
			spawnSync(npmCommand, ["init", "-y"], {
				cwd: installRoot,
				stdio: "ignore",
			});
			const install = spawnSync(npmCommand, ["install", packageSpec], {
				cwd: installRoot,
				encoding: "utf8",
				stdio: "inherit",
			});
			if (install.error) {
				throw install.error;
			}
			if (install.status !== 0) {
				throw new Error(`npm install ${packageSpec} exited with ${install.status}`);
			}
		} catch (error) {
			if (shouldCleanup) {
				rmSync(installRoot, { recursive: true, force: true });
			}
			throw error;
		}
	}

	try {
		runInstalledCliSmoke(installRoot, {
			cliCommand,
			expectedVersion: version,
			label: "published replay CLI",
		});
		await runPublishedReplayE2E({ installRoot, cliCommand, packageSpec });
	} finally {
		if (shouldCleanup) {
			rmSync(installRoot, { recursive: true, force: true });
		}
	}
}

const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypointPath && fileURLToPath(import.meta.url) === entrypointPath) {
	await main();
}
