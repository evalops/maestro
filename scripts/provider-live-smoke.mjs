#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectCliEntrypoint } from "./direct-cli-entrypoint.mjs";

const SCENARIO_TIMEOUT_MS = 90_000;
const scriptDir = dirname(fileURLToPath(import.meta.url));

export function redactSecrets(text, secrets) {
	let redacted = String(text ?? "");
	for (const secret of secrets) {
		if (secret) redacted = redacted.split(secret).join("[REDACTED]");
	}
	return redacted;
}

export function parseJsonl(output) {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				throw new Error(`non-JSON output on line ${index + 1}: ${line}`, {
					cause: error,
				});
			}
		});
}

export function verifyScenarioOutput(output, scenario) {
	const events = parseJsonl(output);
	const semantic = events.filter((event) => {
		if (event?.type === "thread" || event?.type === "turn") return false;
		return !(event?.type === "item" && event.subtype === "message_delta");
	});
	const expectedLength = scenario.tools.length * 2 + 2;
	if (semantic.length !== expectedLength) {
		throw new Error(`${scenario.name}: unexpected semantic event count ${semantic.length}`);
	}

	const callIds = new Set();
	for (const [index, expectedTool] of scenario.tools.entries()) {
		const call = semantic[index * 2];
		const result = semantic[index * 2 + 1];
		if (call?.type !== "item" || call.subtype !== "tool_call") {
			throw new Error(`${scenario.name}: expected tool_call at semantic event ${index * 2 + 1}`);
		}
		if (result?.type !== "item" || result.subtype !== "tool_result") {
			throw new Error(`${scenario.name}: expected tool_result immediately after ${expectedTool}`);
		}
		if (call.tool !== expectedTool || result.tool !== expectedTool) {
			throw new Error(
				`${scenario.name}: tool ${index + 1} must be ${expectedTool}; received call=${call.tool} result=${result.tool}`,
			);
		}
		if (typeof call.call_id !== "string" || call.call_id.length === 0) {
			throw new Error(`${scenario.name}: tool call ${index + 1} has no call_id`);
		}
		if (callIds.has(call.call_id)) {
			throw new Error(`${scenario.name}: duplicate call_id ${call.call_id}`);
		}
		callIds.add(call.call_id);
		if (result.call_id !== call.call_id) {
			throw new Error(
				`${scenario.name}: result call_id ${result.call_id} does not match ${call.call_id}`,
			);
		}
		if (result.success !== true) {
			throw new Error(`${scenario.name}: ${expectedTool} result was not successful`);
		}
		if (index === scenario.markerResultIndex && !String(result.output ?? "").includes(scenario.marker)) {
			throw new Error(`${scenario.name}: tool result does not contain ${scenario.marker}`);
		}
	}

	const message = semantic.at(-2);
	if (message?.type !== "item" || message.subtype !== "message_complete" || message.text?.trim() !== scenario.marker) {
		throw new Error(`${scenario.name}: final assistant marker does not match`);
	}
	const done = semantic.at(-1);
	if (done?.type !== "done" || done.status !== "ok") {
		throw new Error(`${scenario.name}: expected one final done event with status ok`);
	}
	return { callIds: [...callIds], events: events.length };
}

function scenarios(workspace, nonce) {
	const singleMarker = `MAESTRO_SINGLE_READ_${nonce}`;
	const globMarker = `MAESTRO_GLOB_READ_${nonce}`;
	const gpt56Marker = `MAESTRO_GPT56_READ_${nonce}`;
	writeFileSync(join(workspace, "single.txt"), `${singleMarker}\n`);
	mkdirSync(join(workspace, "glob-fixture"));
	writeFileSync(join(workspace, "glob-fixture", "marker.txt"), `${globMarker}\n`);
	writeFileSync(join(workspace, "gpt56.txt"), `${gpt56Marker}\n`);
	return [
		{
			name: "gpt-4.1-mini single read",
			model: "gpt-4.1-mini",
			marker: singleMarker,
			markerResultIndex: 0,
			tools: ["read"],
			prompt: `Call read exactly once on single.txt. Then reply exactly ${singleMarker} and nothing else.`,
		},
		{
			name: "gpt-4.1-mini glob and read",
			model: "gpt-4.1-mini",
			marker: globMarker,
			markerResultIndex: 1,
			tools: ["glob", "read"],
			prompt: `Call glob exactly once with pattern glob-fixture/*.txt and path ".". Read exactly the one returned file. Then reply exactly ${globMarker} and nothing else.`,
		},
		{
			name: "gpt-5.6 read",
			model: "gpt-5.6",
			marker: gpt56Marker,
			markerResultIndex: 0,
			tools: ["read"],
			prompt: `Call read exactly once on gpt56.txt. Then reply exactly ${gpt56Marker} and nothing else.`,
		},
	];
}

export function main() {
	const apiKey = process.env.MAESTRO_PROVIDER_SMOKE_OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error("MAESTRO_PROVIDER_SMOKE_OPENAI_API_KEY is required");
	}
	const cli = resolve(process.env.MAESTRO_PROVIDER_SMOKE_CLI ?? join(scriptDir, "..", "bin", "maestro"));
	const workspace = mkdtempSync(join(tmpdir(), "maestro-provider-live-smoke-"));
	const secrets = [apiKey, process.env.OPENAI_API_KEY].filter(Boolean);
	try {
		for (const scenario of scenarios(workspace, Date.now().toString(36))) {
			console.log(`[provider-live-smoke] ${scenario.name}`);
			const env = {
				...process.env,
				OPENAI_API_KEY: apiKey,
				NO_COLOR: "1",
				MAESTRO_TELEMETRY_DISABLED: "1",
			};
			delete env.MAESTRO_PROVIDER_SMOKE_OPENAI_API_KEY;
			const result = spawnSync(
				cli,
				[
					"exec",
					"--json",
					"--provider",
					"openai",
					"--model",
					scenario.model,
					"--approval-mode",
					"fail",
					scenario.prompt,
				],
				{
					cwd: workspace,
					encoding: "utf8",
					env,
					maxBuffer: 10 * 1024 * 1024,
					timeout: SCENARIO_TIMEOUT_MS,
				},
			);
			const stdout = redactSecrets(result.stdout, secrets);
			const stderr = redactSecrets(result.stderr, secrets);
			if (stdout) process.stdout.write(stdout);
			if (stderr) process.stderr.write(stderr);
			if (result.error) {
				throw new Error(
					`${scenario.name}: ${redactSecrets(result.error.message, secrets)}`,
				);
			}
			if (result.status !== 0) {
				throw new Error(`${scenario.name}: exited with status ${result.status}`);
			}
			const summary = verifyScenarioOutput(stdout, scenario);
			console.log(
				`[provider-live-smoke] verified ${scenario.name}: calls=${summary.callIds.length}`,
			);
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

if (isDirectCliEntrypoint(import.meta.url)) {
	try {
		main();
	} catch (error) {
		const secrets = [
			process.env.MAESTRO_PROVIDER_SMOKE_OPENAI_API_KEY,
			process.env.OPENAI_API_KEY,
		].filter(Boolean);
		console.error(
			redactSecrets(error instanceof Error ? error.message : String(error), secrets),
		);
		process.exit(1);
	}
}
