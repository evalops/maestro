import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADLESS_PROTOCOL_VERSION } from "../../src/cli/headless-protocol.js";
import { NativeHeadlessClient } from "../../src/server/native-headless-client.js";

function createFakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdin: PassThrough;
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn(() => true);
	return child;
}

function writeNdjson(
	stdout: PassThrough,
	message: Record<string, unknown>,
): void {
	stdout.write(`${JSON.stringify(message)}\n`);
}

describe("NativeHeadlessClient", () => {
	const clients: NativeHeadlessClient[] = [];

	afterEach(() => {
		for (const client of clients) {
			client.stop();
			client.removeAllListeners();
		}
		clients.length = 0;
	});

	function createClient(
		child: ReturnType<typeof createFakeChild>,
		options: ConstructorParameters<typeof NativeHeadlessClient>[0] = {},
	): NativeHeadlessClient {
		const client = new NativeHeadlessClient({
			readyTimeoutMs: 2_000,
			spawnProcess: () => ({
				child: child as unknown as import("node:child_process").ChildProcess,
				binary: "/fake/maestro-tui",
				args: ["--headless"],
			}),
			...options,
		});
		clients.push(client);
		return client;
	}

	it("start waits for the first ready message", async () => {
		const child = createFakeChild();
		const client = createClient(child);

		const startPromise = client.start();
		expect(client.isRunning).toBe(true);

		const ready = {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: "test-model",
			provider: "test-provider",
			session_id: "sess-1",
		};
		writeNdjson(child.stdout, ready);

		await expect(startPromise).resolves.toEqual(ready);
	});

	it("send writes NDJSON lines to stdin", async () => {
		const child = createFakeChild();
		const client = createClient(child);
		const startPromise = client.start();
		writeNdjson(child.stdout, {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: "m",
			provider: "p",
			session_id: null,
		});
		await startPromise;

		const chunks: string[] = [];
		child.stdin.on("data", (chunk: Buffer | string) => {
			chunks.push(chunk.toString());
		});

		client.send({ type: "prompt", content: "hello" });
		expect(chunks.join("")).toBe(
			`${JSON.stringify({ type: "prompt", content: "hello" })}\n`,
		);
	});

	it("emits message events for response_chunk and other agent messages", async () => {
		const child = createFakeChild();
		const client = createClient(child);
		const startPromise = client.start();
		writeNdjson(child.stdout, {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: "m",
			provider: "p",
			session_id: null,
		});
		await startPromise;

		const messages: unknown[] = [];
		client.on("message", (msg) => {
			messages.push(msg);
		});

		const chunk = {
			type: "response_chunk",
			response_id: "r1",
			content: "hi",
			is_thinking: false,
		};
		writeNdjson(child.stdout, chunk);

		// Allow readline to process
		await new Promise((resolve) => setImmediate(resolve));

		expect(messages).toContainEqual(chunk);
	});

	it("emits ready events and convenience helpers write protocol messages", async () => {
		const child = createFakeChild();
		const client = createClient(child);

		const readyEvents: unknown[] = [];
		client.on("ready", (msg) => {
			readyEvents.push(msg);
		});

		const startPromise = client.start();
		const ready = {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: "m",
			provider: "p",
			session_id: null,
		};
		writeNdjson(child.stdout, ready);
		await startPromise;
		expect(readyEvents).toContainEqual(ready);

		const written: string[] = [];
		child.stdin.on("data", (chunk: Buffer | string) => {
			written.push(chunk.toString());
		});

		client.hello({ clientName: "test-client", role: "controller" });
		client.init({
			thinking_level: "low",
			approval_mode: "prompt",
			history: [
				{ role: "user", content: "prior q" },
				{ role: "assistant", content: "prior a" },
			],
			append_system_prompt: "## Prior conversation\nUser: prior q",
		});
		client.seedHistory([{ role: "user", content: "seeded" }]);
		client.prompt("do work", ["file.txt"]);
		client.interrupt();
		client.cancel();
		client.shutdown();

		const joined = written.join("");
		expect(joined).toContain('"type":"hello"');
		expect(joined).toContain(
			`"protocol_version":"${HEADLESS_PROTOCOL_VERSION}"`,
		);
		expect(joined).toContain('"name":"test-client"');
		expect(joined).toContain('"role":"controller"');
		expect(joined).toContain('"type":"init"');
		expect(joined).toContain('"thinking_level":"low"');
		expect(joined).toContain('"role":"user"');
		expect(joined).toContain('"content":"prior q"');
		expect(joined).toContain('"append_system_prompt"');
		expect(joined).toContain('"content":"seeded"');
		expect(joined).toContain('"type":"prompt"');
		expect(joined).toContain('"content":"do work"');
		expect(joined).toContain('"type":"interrupt"');
		expect(joined).toContain('"type":"cancel"');
		expect(joined).toContain('"type":"shutdown"');
	});

	it("emits error on invalid JSON but keeps reading", async () => {
		const child = createFakeChild();
		const client = createClient(child);
		const startPromise = client.start();
		writeNdjson(child.stdout, {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: "m",
			provider: "p",
			session_id: null,
		});
		await startPromise;

		const errors: Error[] = [];
		const messages: unknown[] = [];
		client.on("error", (err: Error) => {
			errors.push(err);
		});
		client.on("message", (msg) => {
			messages.push(msg);
		});

		child.stdout.write("not-json\n");
		writeNdjson(child.stdout, {
			type: "status",
			message: "still alive",
		});
		await new Promise((resolve) => setImmediate(resolve));

		expect(errors.some((e) => e.message.includes("Failed to parse"))).toBe(
			true,
		);
		expect(messages).toContainEqual({
			type: "status",
			message: "still alive",
		});
	});

	it("emits stderr chunks as strings", async () => {
		const child = createFakeChild();
		const client = createClient(child);
		const startPromise = client.start();
		writeNdjson(child.stdout, {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: "m",
			provider: "p",
			session_id: null,
		});
		await startPromise;

		const stderrChunks: string[] = [];
		client.on("stderr", (chunk: string) => {
			stderrChunks.push(chunk);
		});

		child.stderr.write("warn line\n");
		await new Promise((resolve) => setImmediate(resolve));
		expect(stderrChunks.join("")).toContain("warn line");
	});

	it("stop kills the child process", async () => {
		const child = createFakeChild();
		const client = createClient(child);
		const startPromise = client.start();
		writeNdjson(child.stdout, {
			type: "ready",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			model: "m",
			provider: "p",
			session_id: null,
		});
		await startPromise;

		expect(client.isRunning).toBe(true);
		client.stop();
		expect(child.kill).toHaveBeenCalled();
		expect(client.isRunning).toBe(false);
	});

	it("start times out when ready never arrives", async () => {
		const child = createFakeChild();
		const client = createClient(child, { readyTimeoutMs: 50 });
		await expect(client.start()).rejects.toThrow(/Timed out waiting/);
		client.stop();
	});

	it("start rejects when the process exits before ready", async () => {
		const child = createFakeChild();
		const client = createClient(child, { readyTimeoutMs: 2_000 });
		const startPromise = client.start();
		// Emit exit after start attaches listeners
		await new Promise((resolve) => setImmediate(resolve));
		child.emit("exit", 1);
		await expect(startPromise).rejects.toThrow(
			/exited before ready \(code=1\)/,
		);
	});
});
