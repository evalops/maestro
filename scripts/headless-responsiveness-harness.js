#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_PROTOCOL_VERSION = "2026-04-02";

function parseArgs(argv) {
	const args = {
		target: "all",
		cli: "dist/cli.js",
		promptRequests: 100,
		concurrency: 20,
		delayMs: 2,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--target" && argv[i + 1]) {
			args.target = argv[++i];
		} else if (arg === "--cli" && argv[i + 1]) {
			args.cli = argv[++i];
		} else if (arg === "--prompt-requests" && argv[i + 1]) {
			args.promptRequests = Number.parseInt(argv[++i], 10);
		} else if (arg === "--concurrency" && argv[i + 1]) {
			args.concurrency = Number.parseInt(argv[++i], 10);
		} else if (arg === "--delay-ms" && argv[i + 1]) {
			args.delayMs = Number.parseInt(argv[++i], 10);
		}
	}
	return args;
}

function percentile(values, p) {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.ceil((p / 100) * sorted.length) - 1,
	);
	return sorted[index];
}

async function requestJson(url, options = {}) {
	const startedAt = performance.now();
	const response = await fetch(url, {
		...options,
		headers: {
			"content-type": "application/json",
			...(options.headers ?? {}),
		},
	});
	const text = await response.text();
	const durationMs = performance.now() - startedAt;
	let body;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	return { status: response.status, body, durationMs };
}

async function runConcurrent(count, concurrency, fn) {
	const durations = [];
	let next = 0;
	async function worker() {
		for (;;) {
			const index = next++;
			if (index >= count) {
				return;
			}
			const startedAt = performance.now();
			await fn(index);
			durations.push(performance.now() - startedAt);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, count) }, () => worker()),
	);
	return {
		count,
		concurrency,
		p50_ms: percentile(durations, 50),
		p95_ms: percentile(durations, 95),
		p99_ms: percentile(durations, 99),
	};
}

function createMockRunner({ delayMs }) {
	const events = [
		{ sequence: 1, type: "ready" },
		{ sequence: 2, type: "hello_ok" },
		{ sequence: 3, type: "response_start" },
		{ sequence: 4, type: "response_end" },
	];
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method === "GET" && req.url === "/healthz") {
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}
		if (req.method === "GET" && req.url === "/readyz") {
			res.end(JSON.stringify({ status: "ready" }));
			return;
		}
		if (req.method === "POST" && req.url === "/headless/hello") {
			res.end(
				JSON.stringify({
					type: "hello_ok",
					protocol_version: DEFAULT_PROTOCOL_VERSION,
					connection_id: "mock-local",
					role: "controller",
				}),
			);
			return;
		}
		if (req.method === "POST" && req.url === "/prompt") {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			res.end(
				JSON.stringify({
					type: "response_end",
					duration_ms: delayMs,
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						total_cost_usd: 0,
					},
				}),
			);
			return;
		}
		if (req.method === "GET" && req.url?.startsWith("/events")) {
			res.end(JSON.stringify({ events }));
			return;
		}
		if (req.method === "POST" && req.url === "/drain") {
			res.end(
				JSON.stringify({
					status: "drained",
					snapshot_manifest_uri: "mock://snapshot-manifest.json",
				}),
			);
			return;
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ error: "not found" }));
	});
	return server;
}

async function listen(server) {
	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Mock runner did not bind to a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function runMockHarness(options) {
	const server = createMockRunner(options);
	const baseUrl = await listen(server);
	try {
		const health = await requestJson(`${baseUrl}/healthz`);
		const ready = await requestJson(`${baseUrl}/readyz`);
		const hello = await requestJson(`${baseUrl}/headless/hello`, {
			method: "POST",
			body: JSON.stringify({
				type: "hello",
				protocol_version: DEFAULT_PROTOCOL_VERSION,
			}),
		});
		const prompt = await runConcurrent(
			options.promptRequests,
			options.concurrency,
			(index) =>
				requestJson(`${baseUrl}/prompt`, {
					method: "POST",
					body: JSON.stringify({ prompt: `hello ${index}` }),
				}),
		);
		const events = await requestJson(`${baseUrl}/events?cursor=0`);
		const drain = await requestJson(`${baseUrl}/drain`, { method: "POST" });
		return {
			target: "mock",
			base_url: baseUrl,
			health,
			ready,
			hello,
			prompt,
			events_count: Array.isArray(events.body?.events)
				? events.body.events.length
				: 0,
			drain,
		};
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

function parseJsonLines(stdout) {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const messages = [];
	const invalid = [];
	for (const [index, line] of lines.entries()) {
		try {
			messages.push(JSON.parse(line));
		} catch (error) {
			invalid.push({
				line: index + 1,
				content: line,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { lines: lines.length, messages, invalid };
}

function runHeadlessHarness({ cli }) {
	const home = mkdtempSync(join(tmpdir(), "maestro-headless-harness-"));
	try {
		const startedAt = performance.now();
		const result = spawnSync(
			"node",
			[
				cli,
				"--headless",
				"--provider",
				"openai",
				"--model",
				"gpt-4o-mini",
				"--api-key",
				"test-key",
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				input: `${JSON.stringify({
					type: "hello",
					protocol_version: DEFAULT_PROTOCOL_VERSION,
					client_info: {
						name: "maestro-headless-responsiveness-harness",
						version: "0.1.0",
					},
					role: "controller",
				})}\n`,
				env: {
					...process.env,
					HOME: home,
					MAESTRO_HOME: join(home, ".maestro"),
					OPENAI_API_KEY: "test-key",
					ANTHROPIC_API_KEY: "test-key",
				},
				timeout: 15_000,
			},
		);
		const elapsedMs = performance.now() - startedAt;
		const parsed = parseJsonLines(result.stdout ?? "");
		return {
			target: "headless-cli",
			cli,
			exit_code: result.status,
			elapsed_ms: elapsedMs,
			stdout_line_count: parsed.lines,
			invalid_stdout_lines: parsed.invalid,
			message_types: parsed.messages.map((message) => message.type),
			stderr: result.stderr,
			error: result.error
				? result.error instanceof Error
					? result.error.message
					: String(result.error)
				: undefined,
		};
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const startedAt = new Date().toISOString();
	const results = [];
	if (options.target === "all" || options.target === "mock") {
		results.push(await runMockHarness(options));
	}
	if (options.target === "all" || options.target === "headless") {
		results.push(runHeadlessHarness(options));
	}
	console.log(
		JSON.stringify(
			{
				started_at: startedAt,
				protocol_version: DEFAULT_PROTOCOL_VERSION,
				options,
				results,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
