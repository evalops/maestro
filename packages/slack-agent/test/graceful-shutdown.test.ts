import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ShutdownManager,
	createShutdownManager,
	setupGracefulShutdown,
} from "../src/utils/graceful-shutdown.js";

describe("ShutdownManager", () => {
	let manager: ShutdownManager;

	beforeEach(() => {
		manager = new ShutdownManager({ exit: false });
	});

	afterEach(() => {
		manager.reset();
	});

	describe("register and unregister", () => {
		it("registers handlers", () => {
			manager.register("test1", async () => {});
			manager.register("test2", async () => {});

			expect(manager.getHandlerNames()).toEqual(["test1", "test2"]);
		});

		it("replaces handlers with same name", () => {
			let called = "";
			manager.register("test", async () => {
				called = "first";
			});
			manager.register("test", async () => {
				called = "second";
			});

			expect(manager.getHandlerNames()).toEqual(["test"]);
		});

		it("sorts handlers by priority", () => {
			manager.register("low", async () => {}, 200);
			manager.register("high", async () => {}, 50);
			manager.register("medium", async () => {}, 100);

			expect(manager.getHandlerNames()).toEqual(["high", "medium", "low"]);
		});

		it("unregisters handler by name", () => {
			manager.register("keep", async () => {});
			manager.register("remove", async () => {});

			const removed = manager.unregister("remove");
			expect(removed).toBe(true);
			expect(manager.getHandlerNames()).toEqual(["keep"]);
		});

		it("returns false when unregistering non-existent handler", () => {
			const removed = manager.unregister("nonexistent");
			expect(removed).toBe(false);
		});
	});

	describe("shutdown execution", () => {
		it("runs handlers in priority order", async () => {
			const order: string[] = [];

			manager.register(
				"third",
				async () => {
					order.push("third");
				},
				300,
			);
			manager.register(
				"first",
				async () => {
					order.push("first");
				},
				100,
			);
			manager.register(
				"second",
				async () => {
					order.push("second");
				},
				200,
			);

			await manager.shutdown();

			expect(order).toEqual(["first", "second", "third"]);
		});

		it("runs all handlers even if one fails", async () => {
			const executed: string[] = [];

			manager.register("pass1", async () => {
				executed.push("pass1");
			});
			manager.register("fail", async () => {
				executed.push("fail");
				throw new Error("Handler error");
			});
			manager.register(
				"pass2",
				async () => {
					executed.push("pass2");
				},
				150,
			);

			const result = await manager.shutdown();

			expect(executed).toEqual(["pass1", "fail", "pass2"]);
			expect(result.success).toBe(false);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].name).toBe("fail");
		});

		it("returns success true when all handlers pass", async () => {
			manager.register("ok1", async () => {});
			manager.register("ok2", async () => {});

			const result = await manager.shutdown();

			expect(result.success).toBe(true);
			expect(result.errors).toHaveLength(0);
			expect(result.duration).toBeGreaterThanOrEqual(0);
		});

		it("handles sync handlers", async () => {
			let called = false;
			manager.register("sync", () => {
				called = true;
			});

			await manager.shutdown();

			expect(called).toBe(true);
		});

		it("prevents double shutdown", async () => {
			let count = 0;
			manager.register("counter", async () => {
				count++;
			});

			// Start shutdown but don't await
			const p1 = manager.shutdown();
			const p2 = manager.shutdown();

			await Promise.all([p1, p2]);

			expect(count).toBe(1);
		});

		it("reports shutdown in progress", async () => {
			manager.register("slow", async () => {
				await new Promise((r) => setTimeout(r, 100));
			});

			expect(manager.isInProgress()).toBe(false);

			const promise = manager.shutdown();
			expect(manager.isInProgress()).toBe(true);

			await promise;
		});
	});

	describe("timeout handling", () => {
		it("times out slow handlers", async () => {
			const shortManager = new ShutdownManager({ exit: false, timeoutMs: 50 });

			shortManager.register("slow", async () => {
				await new Promise((r) => setTimeout(r, 200));
			});

			const result = await shortManager.shutdown();

			expect(result.success).toBe(false);
			expect(result.errors.some((e) => e.name === "_timeout")).toBe(true);
		});

		it("respects custom timeout", async () => {
			const customManager = new ShutdownManager({
				exit: false,
				timeoutMs: 100,
			});

			let completed = false;
			customManager.register("fast", async () => {
				await new Promise((r) => setTimeout(r, 20));
				completed = true;
			});

			const result = await customManager.shutdown();

			expect(completed).toBe(true);
			expect(result.success).toBe(true);
		});
	});

	describe("signal handling", () => {
		it("listen and unlisten manage signal handlers", () => {
			const onSpy = vi.spyOn(process, "on");
			const offSpy = vi.spyOn(process, "off");

			manager.listen();

			expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
			expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

			manager.unlisten();

			expect(offSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
			expect(offSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

			onSpy.mockRestore();
			offSpy.mockRestore();
		});

		it("listen is idempotent", () => {
			const onSpy = vi.spyOn(process, "on");

			manager.listen();
			manager.listen();
			manager.listen();

			// Should only register handlers once per signal
			expect(onSpy.mock.calls.filter((c) => c[0] === "SIGTERM")).toHaveLength(
				1,
			);
			expect(onSpy.mock.calls.filter((c) => c[0] === "SIGINT")).toHaveLength(1);

			onSpy.mockRestore();
		});

		it("supports custom signals", () => {
			const customManager = new ShutdownManager({
				exit: false,
				signals: ["SIGUSR1", "SIGUSR2"],
			});

			const onSpy = vi.spyOn(process, "on");

			customManager.listen();

			expect(onSpy).toHaveBeenCalledWith("SIGUSR1", expect.any(Function));
			expect(onSpy).toHaveBeenCalledWith("SIGUSR2", expect.any(Function));
			expect(onSpy).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));

			customManager.reset();
			onSpy.mockRestore();
		});
	});

	describe("reset", () => {
		it("clears all state", () => {
			manager.register("test", async () => {});
			manager.listen();

			manager.reset();

			expect(manager.getHandlerNames()).toEqual([]);
			expect(manager.isInProgress()).toBe(false);
		});
	});
});

describe("createShutdownManager", () => {
	it("creates manager with defaults", () => {
		const manager = createShutdownManager({ exit: false });
		expect(manager).toBeInstanceOf(ShutdownManager);
		manager.reset();
	});

	it("creates manager with custom config", () => {
		const manager = createShutdownManager({
			exit: false,
			timeoutMs: 10000,
			exitCode: 2,
		});
		expect(manager).toBeInstanceOf(ShutdownManager);
		manager.reset();
	});
});

describe("setupGracefulShutdown", () => {
	it("creates manager and registers handlers", () => {
		const onSpy = vi.spyOn(process, "on");

		const manager = setupGracefulShutdown(
			[
				{ name: "db", handler: async () => {}, priority: 50 },
				{ name: "cache", handler: async () => {}, priority: 100 },
			],
			{ exit: false },
		);

		expect(manager.getHandlerNames()).toEqual(["db", "cache"]);
		expect(onSpy).toHaveBeenCalled();

		manager.reset();
		onSpy.mockRestore();
	});

	it("uses default priority when not specified", () => {
		const manager = setupGracefulShutdown(
			[
				{ name: "first", handler: async () => {}, priority: 50 },
				{ name: "default", handler: async () => {} },
			],
			{ exit: false },
		);

		expect(manager.getHandlerNames()).toEqual(["first", "default"]);
		manager.reset();
	});
});
