import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcClient } from "../../src/codex/app-server-client.js";
import { readPackageVersion } from "../../src/package-version.js";

interface HarnessMessage {
	id?: number | string;
	method?: string;
	params?: unknown;
}

function createHarness() {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const kill = vi.fn(() => true);
	const onceListeners = new Map<string, (...args: unknown[]) => void>();
	const requests: HarnessMessage[] = [];
	const waiters: Array<(request: HarnessMessage) => void> = [];
	const rl = createInterface({ input: stdin });
	rl.on("line", (line) => {
		const request = JSON.parse(line) as HarnessMessage;
		const waiter = waiters.shift();
		if (waiter) {
			waiter(request);
		} else {
			requests.push(request);
		}
	});

	const nextRequest = async (): Promise<HarnessMessage> => {
		const request = requests.shift();
		if (request) {
			return request;
		}
		return new Promise((resolve) => waiters.push(resolve));
	};

	const respond = (id: number | string, result: unknown): void => {
		stdout.write(`${JSON.stringify({ id, result })}\n`);
	};

	const reject = (id: number | string, message: string): void => {
		stdout.write(
			`${JSON.stringify({ id, error: { code: -32000, message } })}\n`,
		);
	};

	const notify = (method: string, params: unknown): void => {
		stdout.write(`${JSON.stringify({ method, params })}\n`);
	};

	const requestFromServer = (
		id: number | string,
		method: string,
		params: unknown,
	): void => {
		stdout.write(`${JSON.stringify({ id, method, params })}\n`);
	};

	const client = new CodexAppServerRpcClient(
		{
			stdin,
			stdout,
			stderr,
			kill,
			once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
				onceListeners.set(event, listener);
				return undefined;
			}),
			on: vi.fn(),
		},
		{ requestTimeoutMs: 100 },
	);

	return {
		client,
		nextRequest,
		respond,
		reject,
		notify,
		requestFromServer,
		exit: (code: number | null, signal: string | null = null) =>
			onceListeners.get("exit")?.(code, signal),
		kill,
		rl,
	};
}

describe("Codex app-server RPC client", () => {
	it("initializes and sends the initialized notification", async () => {
		const harness = createHarness();
		const initialize = harness.client.initialize();

		const request = await harness.nextRequest();
		expect(request).toMatchObject({
			id: 1,
			method: "initialize",
			params: {
				clientInfo: {
					name: "maestro",
					title: "Maestro",
					version: readPackageVersion(),
				},
			},
		});
		harness.respond(1, { protocolVersion: "app-server.v1" });
		await initialize;

		const initialized = await harness.nextRequest();
		expect(initialized).toMatchObject({ method: "initialized" });
		expect(initialized).not.toHaveProperty("id");

		harness.client.close();
		harness.rl.close();
	});

	it("starts ChatGPT login and waits for completion", async () => {
		const harness = createHarness();
		const login = harness.client.startChatGptLogin("browser");

		const request = await harness.nextRequest();
		expect(request).toMatchObject({
			id: 1,
			method: "account/login/start",
			params: { type: "chatgpt" },
		});
		harness.respond(1, {
			type: "chatgpt",
			loginId: "login-1",
			authUrl: "https://chatgpt.com/auth",
		});
		await expect(login).resolves.toMatchObject({
			type: "chatgpt",
			loginId: "login-1",
		});

		const completion = harness.client.waitForLoginCompletion("login-1", 100);
		harness.notify("account/login/completed", {
			loginId: "login-1",
			success: true,
			error: null,
		});
		await expect(completion).resolves.toMatchObject({ success: true });

		harness.client.close();
		harness.rl.close();
	});

	it("resolves login completion notifications received before waiting", async () => {
		const harness = createHarness();

		harness.notify("account/login/completed", {
			loginId: "login-1",
			success: true,
			error: null,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(
			harness.client.waitForLoginCompletion("login-1", 100),
		).resolves.toMatchObject({ success: true });
		harness.client.close();
		harness.rl.close();
	});

	it("rejects notification waiters when the transport exits", async () => {
		const harness = createHarness();
		const completion = harness.client.waitForLoginCompletion("login-1", 10_000);

		harness.exit(1);

		await expect(completion).rejects.toThrow(
			"Codex app-server exited with code 1",
		);
		harness.rl.close();
	});

	it("rejects JSON-RPC errors", async () => {
		const harness = createHarness();
		const status = harness.client.readAccount();

		const request = await harness.nextRequest();
		expect(request.method).toBe("account/read");
		harness.reject(request.id ?? 1, "Not initialized");

		await expect(status).rejects.toThrow("Not initialized");
		harness.client.close();
		harness.rl.close();
	});

	it("lets callers handle app-server JSON-RPC requests", async () => {
		const harness = createHarness();
		const notifications: unknown[] = [];
		harness.client.onNotification((notification) =>
			notifications.push(notification),
		);
		harness.client.onRequest((request) => {
			if (request.method !== "item/tool/call") {
				return { handled: false };
			}
			return {
				handled: true,
				result: {
					contentItems: [{ type: "inputText", text: "tool-ok" }],
					success: true,
				},
			};
		});

		harness.requestFromServer("server-1", "item/tool/call", {
			callId: "call-1",
		});

		const response = await harness.nextRequest();
		expect(response).toEqual({
			id: "server-1",
			result: {
				contentItems: [{ type: "inputText", text: "tool-ok" }],
				success: true,
			},
		});
		expect(notifications).toEqual([
			{
				method: "item/tool/call",
				params: { callId: "call-1" },
			},
		]);

		harness.client.close();
		harness.rl.close();
	});
});
