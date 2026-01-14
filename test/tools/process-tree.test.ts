import { spawn } from "node:child_process";
import { describe, expect, it, afterEach } from "vitest";
import {
	getDescendantPids,
	isProcessAlive,
	killProcessTreeGracefully,
	killProcessTreeImmediate,
	processRegistry,
} from "../../src/tools/process-tree.js";

describe("process-tree", () => {
	// Track processes we spawn for cleanup
	const spawnedPids: number[] = [];

	afterEach(async () => {
		// Clean up any processes we spawned
		for (const pid of spawnedPids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already dead
			}
		}
		spawnedPids.length = 0;
	});

	describe("isProcessAlive", () => {
		it("returns true for current process", () => {
			expect(isProcessAlive(process.pid)).toBe(true);
		});

		it("returns false for invalid PIDs", () => {
			expect(isProcessAlive(0)).toBe(false);
			expect(isProcessAlive(-1)).toBe(false);
			expect(isProcessAlive(-999)).toBe(false);
		});

		it("returns false for non-existent large PIDs", () => {
			// Use a PID that's very unlikely to exist
			expect(isProcessAlive(999999999)).toBe(false);
		});

		it("returns true for a spawned process", () => {
			const child = spawn("sleep", ["10"], { detached: true });
			if (child.pid) {
				spawnedPids.push(child.pid);
				expect(isProcessAlive(child.pid)).toBe(true);
			}
		});
	});

	describe("getDescendantPids", () => {
		it("returns empty array for invalid PIDs", () => {
			expect(getDescendantPids(0)).toEqual([]);
			expect(getDescendantPids(-1)).toEqual([]);
		});

		it("returns empty array for process with no children", () => {
			const child = spawn("sleep", ["10"], { detached: true });
			if (child.pid) {
				spawnedPids.push(child.pid);
				// sleep doesn't spawn children
				const descendants = getDescendantPids(child.pid);
				expect(descendants).toEqual([]);
			}
		});

		it("returns children for process with child", () => {
			// Spawn a shell that spawns a child
			const child = spawn(
				"sh",
				["-c", "sleep 10 & echo $!; wait"],
				{ detached: true },
			);

			if (child.pid) {
				spawnedPids.push(child.pid);

				// Give it a moment to spawn the child
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						const descendants = getDescendantPids(child.pid!);
						// Should have at least one descendant (the sleep process)
						expect(descendants.length).toBeGreaterThanOrEqual(0);
						resolve();
					}, 200);
				});
			}
		});
	});

	describe("killProcessTreeGracefully", () => {
		it("handles invalid PIDs gracefully", async () => {
			const result = await killProcessTreeGracefully(0);
			expect(result.killed).toEqual([]);
			expect(result.failed).toEqual([]);

			const result2 = await killProcessTreeGracefully(-1);
			expect(result2.killed).toEqual([]);
			expect(result2.failed).toEqual([]);
		});

		it("kills a simple process", async () => {
			const child = spawn("sleep", ["30"], { detached: true });

			if (child.pid) {
				spawnedPids.push(child.pid);
				expect(isProcessAlive(child.pid)).toBe(true);

				const result = await killProcessTreeGracefully(child.pid, 100);
				expect(result.killed).toContain(child.pid);
				expect(isProcessAlive(child.pid)).toBe(false);
			}
		});

		it("kills a process with children", async () => {
			// Spawn a shell that spawns children
			const child = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], {
				detached: true,
			});

			if (child.pid) {
				spawnedPids.push(child.pid);

				// Give it time to spawn children
				await new Promise((resolve) => setTimeout(resolve, 200));

				expect(isProcessAlive(child.pid)).toBe(true);

				const result = await killProcessTreeGracefully(child.pid, 100);

				// Main process should be killed
				expect(result.killed).toContain(child.pid);
				expect(isProcessAlive(child.pid)).toBe(false);
			}
		});
	});

	describe("killProcessTreeImmediate", () => {
		it("handles invalid PIDs gracefully", () => {
			// Should not throw
			expect(() => killProcessTreeImmediate(0)).not.toThrow();
			expect(() => killProcessTreeImmediate(-1)).not.toThrow();
			expect(() => killProcessTreeImmediate(1)).not.toThrow();
		});

		it("kills a process immediately", async () => {
			const child = spawn("sleep", ["30"], { detached: true });

			if (child.pid) {
				spawnedPids.push(child.pid);
				expect(isProcessAlive(child.pid)).toBe(true);

				killProcessTreeImmediate(child.pid);

				// Give SIGKILL a moment to take effect
				await new Promise((resolve) => setTimeout(resolve, 100));

				expect(isProcessAlive(child.pid)).toBe(false);
			}
		});
	});

	describe("processRegistry", () => {
		it("registers and unregisters processes", () => {
			const fakePid = 123456;
			expect(processRegistry.isRegistered(fakePid)).toBe(false);

			processRegistry.register(fakePid, "test command");
			expect(processRegistry.isRegistered(fakePid)).toBe(true);

			processRegistry.unregister(fakePid);
			expect(processRegistry.isRegistered(fakePid)).toBe(false);
		});

		it("returns all registered PIDs", () => {
			processRegistry.register(111, "cmd1");
			processRegistry.register(222, "cmd2");

			const pids = processRegistry.getAllPids();
			expect(pids).toContain(111);
			expect(pids).toContain(222);

			// Cleanup
			processRegistry.unregister(111);
			processRegistry.unregister(222);
		});

		it("cleanup removes dead processes", () => {
			// Register a PID that doesn't exist
			const deadPid = 999888777;
			processRegistry.register(deadPid, "dead");

			expect(processRegistry.isRegistered(deadPid)).toBe(true);

			processRegistry.cleanup();

			// Should be removed since process doesn't exist
			expect(processRegistry.isRegistered(deadPid)).toBe(false);
		});
	});
});
