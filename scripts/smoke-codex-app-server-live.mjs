#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cli = join(scriptDir, "..", "dist", "cli.js");
const baseEnv = {
	...process.env,
	NO_COLOR: "1",
	MAESTRO_TELEMETRY_DISABLED: "1",
};

const DEFAULT_MAX_TOTAL_TOOL_CALLS = 3;
const DEFAULT_MAX_IDENTICAL_TOOL_CALLS = 1;

const loopWarningPatterns = [
	/Exact repetition loop detected/i,
	/Similar operation loop detected/i,
	/Cyclic pattern detected/i,
	/Identical tool call repeated/i,
	/Similar .* calls detected/i,
	/Loop pattern detected/i,
	/loop_detected/i,
	/loop detector is paused/i,
	/tool\.duplicate_request/i,
	/possible doom loop/i,
];

function run(name, args, options = {}) {
	console.log(`[codex-live-smoke] ${name}`);
	const result = spawnSync("node", [cli, ...args], {
		encoding: "utf8",
		env: baseEnv,
		cwd: options.cwd,
		timeout: options.timeoutMs ?? 180_000,
	});
	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`${name} failed with exit code ${result.status}`);
	}
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function parsePositiveIntegerEnv(name, fallback) {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer. Received ${raw}`);
	}
	return parsed;
}

export function parseJsonlEvents(output) {
	const events = [];
	for (const [index, rawLine] of output.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		try {
			events.push(JSON.parse(line));
		} catch (error) {
			throw new Error(
				`Codex live smoke emitted non-JSON output on line ${index + 1}: ${line}`,
				{ cause: error },
			);
		}
	}
	return events;
}

function stableJson(value) {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, entryValue]) => typeof entryValue !== "undefined")
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function dynamicToolOperationArgs(args) {
	if (!isRecord(args)) {
		return {};
	}
	if (isRecord(args.arguments)) {
		return args.arguments;
	}
	const { callId, threadId, toolCallId, turnId, ...operationArgs } = args;
	void callId;
	void threadId;
	void toolCallId;
	void turnId;
	return operationArgs;
}

function toolCallSignature(call) {
	return `${call.toolName}:${stableJson(dynamicToolOperationArgs(call.args ?? {}))}`;
}

export function summarizeDynamicToolCalls(events) {
	const calls = events
		.filter((event) => event?.type === "item" && event.subtype === "tool_call")
		.map((event) => ({
			toolName: event.data?.toolName,
			args: event.data?.args ?? {},
			toolCallId: event.data?.toolCallId,
			signature: toolCallSignature({
				toolName: event.data?.toolName,
				args: event.data?.args ?? {},
			}),
		}));
	const bySignature = new Map();
	for (const call of calls) {
		bySignature.set(call.signature, (bySignature.get(call.signature) ?? 0) + 1);
	}
	const maxIdenticalCalls =
		bySignature.size === 0 ? 0 : Math.max(...bySignature.values());
	return {
		calls,
		totalCalls: calls.length,
		uniqueCalls: bySignature.size,
		maxIdenticalCalls,
	};
}

export function getFinalAssistantText(events) {
	const completions = events.filter(
		(event) => event?.type === "item" && event.subtype === "message_complete",
	);
	const final = completions.at(-1);
	const text = final?.data?.text;
	return typeof text === "string" ? text : "";
}

function findLoopWarningText(output) {
	for (const pattern of loopWarningPatterns) {
		const match = output.match(pattern);
		if (match) {
			return match[0];
		}
	}
	return null;
}

export function assertBoundedDynamicToolUse({
	stdout,
	stderr = "",
	expectedToken,
	maxTotalToolCalls = DEFAULT_MAX_TOTAL_TOOL_CALLS,
	maxIdenticalToolCalls = DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
}) {
	const combinedOutput = `${stdout}\n${stderr}`;
	const warningText = findLoopWarningText(combinedOutput);
	if (warningText) {
		throw new Error(
			`Codex live smoke emitted a loop warning: ${warningText}`,
		);
	}

	const events = parseJsonlEvents(stdout);
	const finalAssistantText = getFinalAssistantText(events).trim();
	if (finalAssistantText !== expectedToken) {
		throw new Error(
			`real inference final assistant text did not exactly match expected token ${expectedToken}. Received ${JSON.stringify(finalAssistantText)}`,
		);
	}

	const summary = summarizeDynamicToolCalls(events);
	if (summary.totalCalls === 0) {
		throw new Error("real inference did not execute any dynamic tools");
	}
	if (summary.totalCalls > maxTotalToolCalls) {
		throw new Error(
			`real inference executed ${summary.totalCalls} dynamic tools, exceeding limit ${maxTotalToolCalls}`,
		);
	}
	if (summary.maxIdenticalCalls > maxIdenticalToolCalls) {
		throw new Error(
			`real inference repeated an identical dynamic tool call ${summary.maxIdenticalCalls} times, exceeding limit ${maxIdenticalToolCalls}`,
		);
	}
	return summary;
}

export function main() {
	run("doctor", ["codex", "doctor"], { timeoutMs: 60_000 });

	const tempDir = mkdtempSync(join(tmpdir(), "maestro-codex-live-"));
	try {
		const token = `codex-live-smoke-${Date.now().toString(36)}`;
		const tokenPath = join(tempDir, "token.txt");
		const maxTotalToolCalls = parsePositiveIntegerEnv(
			"MAESTRO_CODEX_LIVE_SMOKE_MAX_TOTAL_TOOL_CALLS",
			DEFAULT_MAX_TOTAL_TOOL_CALLS,
		);
		const maxIdenticalToolCalls = parsePositiveIntegerEnv(
			"MAESTRO_CODEX_LIVE_SMOKE_MAX_IDENTICAL_TOOL_CALLS",
			DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
		);
		writeFileSync(tokenPath, `${token}\n`, "utf8");

		const result = run(
			"real inference with dynamic read tool",
			[
				"--provider",
				"openai-codex",
				"--model",
				"gpt-5.5",
				"--mode",
				"json",
				"--no-session",
				"--approval-mode",
				"fail",
				"--sandbox",
				"read-only",
				`Use exactly one dynamic tool call: read ${tokenPath}. Do not read README.md, package READMEs, directories, or any other file. After that single read, reply exactly with the token in that file.`,
			],
			{ cwd: tempDir, timeoutMs: 240_000 },
		);
		const summary = assertBoundedDynamicToolUse({
			...result,
			expectedToken: token,
			maxTotalToolCalls,
			maxIdenticalToolCalls,
		});
		console.log("[codex-live-smoke] real inference returned expected token");
		console.log(
			`[codex-live-smoke] dynamic tool calls bounded: total=${summary.totalCalls} unique=${summary.uniqueCalls} max_identical=${summary.maxIdenticalCalls}`,
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
