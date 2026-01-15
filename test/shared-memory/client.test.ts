import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defaultCapabilities = {
	supports_sync: true,
	supports_gzip: false,
	max_body_bytes: 1024 * 1024,
	max_events_batch: 50,
	max_event_payload_bytes: 1024 * 64,
	max_event_type_length: 128,
	max_event_id_length: 128,
} as const;

const createCapabilitiesResponse = (
	overrides: Partial<typeof defaultCapabilities> = {},
): Response =>
	new Response(JSON.stringify({ ...defaultCapabilities, ...overrides }), {
		status: 200,
	});

describe("shared-memory client", () => {
	let homeDir: string;

	beforeEach(() => {
		vi.useFakeTimers();
		homeDir = mkdtempSync(join(tmpdir(), "composer-shared-memory-"));
		vi.stubEnv("COMPOSER_HOME", homeDir);
		vi.stubEnv("COMPOSER_SHARED_MEMORY_BASE", "https://memory.test");
		vi.stubEnv("COMPOSER_SHARED_MEMORY_API_KEY", "");
		vi.stubEnv("COMPOSER_SHARED_MEMORY_SESSION_ID", "");
		vi.resetModules();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		rmSync(homeDir, { recursive: true, force: true });
	});

	it("retries flush without dropping state when config is missing", async () => {
		let syncBody: unknown = null;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/capabilities")) {
				return createCapabilitiesResponse();
			}
			if (url.includes("/sync")) {
				syncBody = init?.body ?? null;
				return new Response("", { status: 200 });
			}
			return new Response("", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const { queueSharedMemoryUpdate } = await import(
			"../../src/shared-memory/client.js"
		);
		queueSharedMemoryUpdate({
			sessionId: "session-a",
			state: { foo: "bar" },
		});

		vi.stubEnv("COMPOSER_SHARED_MEMORY_BASE", "");
		await vi.advanceTimersByTimeAsync(200);
		expect(fetchMock).toHaveBeenCalledTimes(0);

		vi.stubEnv("COMPOSER_SHARED_MEMORY_BASE", "https://memory.test");
		await vi.advanceTimersByTimeAsync(1500);

		expect(fetchMock).toHaveBeenCalled();
		const parsed = syncBody ? JSON.parse(String(syncBody)) : null;
		expect(parsed?.state?.composer?.foo).toBe("bar");
	});

	it("uses session override for event ids", async () => {
		let syncBody: unknown = null;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/capabilities")) {
				return createCapabilitiesResponse();
			}
			if (url.includes("/sync")) {
				syncBody = init?.body ?? null;
				return new Response("", { status: 200 });
			}
			return new Response("", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.stubEnv("COMPOSER_SHARED_MEMORY_SESSION_ID", "override-session");

		const { queueSharedMemoryUpdate } = await import(
			"../../src/shared-memory/client.js"
		);
		queueSharedMemoryUpdate({
			sessionId: "original-session",
			event: { type: "demo.event", payload: { ok: true } },
		});

		await vi.advanceTimersByTimeAsync(1000);

		const parsed = syncBody ? JSON.parse(String(syncBody)) : null;
		const eventId = parsed?.events?.[0]?.id as string | undefined;
		expect(eventId).toBeTruthy();
		expect(eventId?.startsWith("composer-override-session-")).toBe(true);
	});

	it("merges state updates within a flush window", async () => {
		let syncBody: unknown = null;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/capabilities")) {
				return createCapabilitiesResponse();
			}
			if (url.includes("/sync")) {
				syncBody = init?.body ?? null;
				return new Response("", { status: 200 });
			}
			return new Response("", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const { queueSharedMemoryUpdate } = await import(
			"../../src/shared-memory/client.js"
		);
		queueSharedMemoryUpdate({
			sessionId: "session-a",
			state: { foo: "bar" },
		});
		queueSharedMemoryUpdate({
			sessionId: "session-a",
			state: { baz: "qux" },
		});

		await vi.advanceTimersByTimeAsync(1000);

		const parsed = syncBody ? JSON.parse(String(syncBody)) : null;
		expect(parsed?.state?.composer?.foo).toBe("bar");
		expect(parsed?.state?.composer?.baz).toBe("qux");
	});

	it("backs off with retry-after on rate limiting", async () => {
		let syncCalls = 0;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/capabilities")) {
				return createCapabilitiesResponse();
			}
			if (url.includes("/sync")) {
				syncCalls += 1;
				return new Response("rate limit", {
					status: 429,
					headers: { "Retry-After": "1" },
				});
			}
			return new Response("", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(Math, "random").mockReturnValue(0);

		const { queueSharedMemoryUpdate } = await import(
			"../../src/shared-memory/client.js"
		);
		queueSharedMemoryUpdate({
			sessionId: "session-a",
			state: { foo: "bar" },
		});

		await vi.advanceTimersByTimeAsync(200);
		expect(syncCalls).toBe(1);

		await vi.advanceTimersByTimeAsync(900);
		expect(syncCalls).toBe(1);

		await vi.advanceTimersByTimeAsync(200);
		expect(syncCalls).toBe(2);
	});

	it("backs off exponentially after transient failures", async () => {
		let syncCalls = 0;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/capabilities")) {
				return createCapabilitiesResponse();
			}
			if (url.includes("/sync")) {
				syncCalls += 1;
				return new Response("fail", { status: 500 });
			}
			return new Response("", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(Math, "random").mockReturnValue(0);

		const { queueSharedMemoryUpdate } = await import(
			"../../src/shared-memory/client.js"
		);
		queueSharedMemoryUpdate({
			sessionId: "session-a",
			state: { foo: "bar" },
		});

		await vi.advanceTimersByTimeAsync(200);
		expect(syncCalls).toBe(1);

		await vi.advanceTimersByTimeAsync(299);
		expect(syncCalls).toBe(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(syncCalls).toBe(2);
	});

	it("trims oversized state payloads before sync", async () => {
		let syncBody: unknown = null;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/capabilities")) {
				return createCapabilitiesResponse();
			}
			if (url.includes("/sync")) {
				syncBody = init?.body ?? null;
				return new Response("", { status: 200 });
			}
			return new Response("", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const { queueSharedMemoryUpdate } = await import(
			"../../src/shared-memory/client.js"
		);
		queueSharedMemoryUpdate({
			sessionId: "session-a",
			state: { content: "x".repeat(300_000), keep: "ok" },
		});

		await vi.advanceTimersByTimeAsync(1000);

		const parsed = syncBody ? JSON.parse(String(syncBody)) : null;
		expect(parsed?.state?.composer?.content).toBeUndefined();
		expect(parsed?.state?.composer?.keep).toBe("ok");
	});

	it("trims oversized event payloads before sync", async () => {
		let syncBody: unknown = null;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/capabilities")) {
				return createCapabilitiesResponse({ max_event_payload_bytes: 256 });
			}
			if (url.includes("/sync")) {
				syncBody = init?.body ?? null;
				return new Response("", { status: 200 });
			}
			return new Response("", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const { queueSharedMemoryUpdate } = await import(
			"../../src/shared-memory/client.js"
		);
		queueSharedMemoryUpdate({
			sessionId: "session-a",
			event: {
				type: "demo.event",
				payload: { content: "y".repeat(10_000), keep: "ok" },
			},
		});

		await vi.advanceTimersByTimeAsync(1000);

		const parsed = syncBody ? JSON.parse(String(syncBody)) : null;
		const payload = parsed?.events?.[0]?.payload;
		expect(payload?.content).toBeUndefined();
		expect(payload?.keep).toBe("ok");
	});
});
