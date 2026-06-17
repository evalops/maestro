import { describe, expect, it } from "vitest";
import {
	IPC_PROTOCOL_VERSION,
	makeRequest,
} from "../../src/agent/ipc-envelope.js";
import {
	IpcHandlerError,
	createIpcHandlerRegistry,
	makeHelloParams,
} from "../../src/agent/ipc-handler-registry.js";

describe("agent/ipc-handler-registry", () => {
	describe("register / has / methods / unregister", () => {
		it("registers and exposes a handler by method", () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			expect(r.has("mission.list")).toBe(false);
			r.register("mission.list", () => ({ ok: true }));
			expect(r.has("mission.list")).toBe(true);
			expect(r.methods()).toEqual(["mission.list"]);
		});

		it("methods() returns sorted method names", () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			r.register("b", () => 1);
			r.register("a", () => 2);
			r.register("c", () => 3);
			expect(r.methods()).toEqual(["a", "b", "c"]);
		});

		it("throws when registering the same method twice", () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			r.register("a", () => 1);
			expect(() => r.register("a", () => 2)).toThrow(/already registered/);
		});

		it("throws on blank method names", () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			expect(() => r.register("  ", () => 1)).toThrow(/method is required/);
		});

		it("unregister returns true when a handler was removed", () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			r.register("a", () => 1);
			expect(r.unregister("a")).toBe(true);
			expect(r.has("a")).toBe(false);
			expect(r.unregister("a")).toBe(false);
		});
	});

	describe("dispatch", () => {
		it("calls the handler and wraps the result in a success response", async () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			r.register("greet", (params) => ({ ok: true, you: params }));
			const response = await r.dispatch(
				makeRequest("req-1", "greet", { name: "ada" }),
			);
			expect(response.kind).toBe("response");
			if (response.ok) {
				expect(response.id).toBe("req-1");
				expect(response.result).toEqual({ ok: true, you: { name: "ada" } });
			} else {
				throw new Error("expected ok response");
			}
		});

		it("passes the request id and method as context", async () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			let seenCtx: { requestId: string; method: string } | undefined;
			r.register("noop", (_params, ctx) => {
				seenCtx = ctx;
				return null;
			});
			await r.dispatch(makeRequest("req-7", "noop"));
			expect(seenCtx).toEqual({ requestId: "req-7", method: "noop" });
		});

		it("returns an unknown-method error when no handler is registered", async () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			const response = await r.dispatch(makeRequest("req-1", "ghost"));
			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error.code).toBe("unknown-method");
				expect(response.error.message).toMatch(/no handler registered/);
				expect(response.error.details).toEqual({ method: "ghost" });
			}
		});

		it("translates a thrown IpcHandlerError into the matching error response", async () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			r.register("boom", () => {
				throw new IpcHandlerError("bad-input", "missing field x", {
					field: "x",
				});
			});
			const response = await r.dispatch(makeRequest("req-1", "boom"));
			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error.code).toBe("bad-input");
				expect(response.error.message).toBe("missing field x");
				expect(response.error.details).toEqual({ field: "x" });
			}
		});

		it("translates a thrown plain Error into handler-failed", async () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			r.register("boom", () => {
				throw new Error("oh no");
			});
			const response = await r.dispatch(makeRequest("req-1", "boom"));
			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error.code).toBe("handler-failed");
				expect(response.error.message).toBe("oh no");
			}
		});

		it("translates a thrown non-Error value into handler-failed with stringified message", async () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			r.register("boom", () => {
				throw 42 as unknown;
			});
			const response = await r.dispatch(makeRequest("req-1", "boom"));
			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error.code).toBe("handler-failed");
				expect(response.error.message).toBe("42");
			}
		});

		it("awaits async handlers", async () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			r.register("slow", async () => {
				await Promise.resolve();
				return { done: true };
			});
			const response = await r.dispatch(makeRequest("req-1", "slow"));
			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.result).toEqual({ done: true });
			}
		});
	});

	describe("built-in hello handler", () => {
		it("auto-registers the hello handler by default", () => {
			const r = createIpcHandlerRegistry();
			expect(r.has("hello")).toBe(true);
		});

		it("dispatches hello to negotiate protocol + advertise methods + channels", async () => {
			const r = createIpcHandlerRegistry({
				channels: ["mission.updated", "log"],
				daemonBuild: "maestro-daemon/0.42.0",
			});
			r.register("ping", () => "pong");
			const response = await r.dispatch(
				makeRequest("req-1", "hello", makeHelloParams({ client: "tui" })),
			);
			expect(response.ok).toBe(true);
			if (response.ok) {
				expect(response.result).toMatchObject({
					protocolVersion: IPC_PROTOCOL_VERSION,
					daemonBuild: "maestro-daemon/0.42.0",
					methods: ["hello", "ping"],
					channels: ["log", "mission.updated"],
				});
			}
		});

		it("returns a fresh channels snapshot for each hello response", async () => {
			const r = createIpcHandlerRegistry({
				channels: ["mission.updated", "log"],
			});
			const first = await r.dispatch(
				makeRequest("req-1", "hello", makeHelloParams({ client: "tui" })),
			);
			expect(first.ok).toBe(true);
			if (!first.ok) {
				throw new Error("expected ok response");
			}
			first.result.channels.push("mutated");

			const second = await r.dispatch(
				makeRequest("req-2", "hello", makeHelloParams({ client: "tui" })),
			);
			expect(second.ok).toBe(true);
			if (!second.ok) {
				throw new Error("expected ok response");
			}
			expect(second.result.channels).toEqual(["log", "mission.updated"]);
		});

		it("returns bad-params when hello is called without params", async () => {
			const r = createIpcHandlerRegistry();
			const response = await r.dispatch(makeRequest("req-1", "hello"));
			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error.code).toBe("bad-params");
			}
		});

		it("rejects clients on a higher protocol version", async () => {
			const r = createIpcHandlerRegistry();
			const response = await r.dispatch(
				makeRequest(
					"req-1",
					"hello",
					makeHelloParams({ client: "tui", protocolVersion: 999 }),
				),
			);
			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.error.code).toBe("protocol-version-rejected");
				expect(response.error.details).toEqual({ requestedVersion: 999 });
			}
		});

		it("skips the built-in hello when withHelloHandler=false", () => {
			const r = createIpcHandlerRegistry({ withHelloHandler: false });
			expect(r.has("hello")).toBe(false);
		});
	});

	describe("makeHelloParams", () => {
		it("defaults protocolVersion to IPC_PROTOCOL_VERSION", () => {
			expect(makeHelloParams({ client: "tui" })).toEqual({
				client: "tui",
				protocolVersion: IPC_PROTOCOL_VERSION,
			});
		});

		it("includes channels when provided", () => {
			expect(makeHelloParams({ client: "x", channels: ["a"] })).toEqual({
				client: "x",
				protocolVersion: IPC_PROTOCOL_VERSION,
				channels: ["a"],
			});
		});

		it("does not set a channels key when omitted", () => {
			const params = makeHelloParams({ client: "x" });
			expect("channels" in params).toBe(false);
		});
	});
});
