import { afterEach, describe, expect, it, vi } from "vitest";

describe("HeadlessUtilityFileWatchManager", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("../../src/tools/file-watcher.js");
	});

	it("does not leak a watch when stop races with an in-flight start", async () => {
		let resolveStart: (() => void) | undefined;
		const stop = vi.fn();
		const onFileChange = vi.fn();

		vi.doMock("../../src/tools/file-watcher.js", () => ({
			FileWatcher: class MockFileWatcher {
				onFileChange(listener: (event: unknown) => void) {
					onFileChange.mockImplementation(listener);
				}

				async start() {
					await new Promise<void>((resolve) => {
						resolveStart = resolve;
					});
				}

				stop() {
					stop();
				}
			},
		}));

		const events: Array<{ type: string; watch_id: string }> = [];
		const { HeadlessUtilityFileWatchManager } = await import(
			"../../src/headless/utility-file-watch-manager.js"
		);

		const manager = new HeadlessUtilityFileWatchManager((event) => {
			events.push({ type: event.type, watch_id: event.watch_id });
		});

		const startPromise = manager.start({
			watch_id: "watch_src",
			root_dir: process.cwd(),
		});
		await Promise.resolve();

		manager.stop("watch_src", "controller stop");
		resolveStart?.();
		await startPromise;

		expect(stop).toHaveBeenCalledTimes(1);
		expect(manager.snapshot()).toEqual([]);
		expect(events).toEqual([]);
	});

	it("rejects missing watch roots without reporting a started watch", async () => {
		const events: Array<{ type: string; watch_id: string }> = [];
		const { HeadlessUtilityFileWatchManager } = await import(
			"../../src/headless/utility-file-watch-manager.js"
		);

		const manager = new HeadlessUtilityFileWatchManager((event) => {
			events.push({ type: event.type, watch_id: event.watch_id });
		});

		const missingRoot = `${process.cwd()}/definitely-missing-headless-watch-root`;

		await expect(
			manager.start({
				watch_id: "missing_root",
				root_dir: missingRoot,
			}),
		).rejects.toThrow(
			`Utility file watch root directory does not exist: ${missingRoot}`,
		);
		expect(manager.snapshot()).toEqual([]);
		expect(events).toEqual([]);
	});

	it("disposes only file watches owned by a closing connection", async () => {
		const events: Array<Record<string, unknown>> = [];
		const { HeadlessUtilityFileWatchManager } = await import(
			"../../src/headless/utility-file-watch-manager.js"
		);

		const manager = new HeadlessUtilityFileWatchManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		await manager.start({
			watch_id: "watch_owned",
			root_dir: process.cwd(),
			owner_connection_id: "conn_owned",
		});
		await manager.start({
			watch_id: "watch_other",
			root_dir: process.cwd(),
			owner_connection_id: "conn_other",
		});

		manager.disposeOwnedByConnection(
			"conn_owned",
			"Owning connection closed while file watch was still running",
		);

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "started",
				watch_id: "watch_owned",
				owner_connection_id: "conn_owned",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "stopped",
				watch_id: "watch_owned",
				reason: "Owning connection closed while file watch was still running",
			}),
		);
		expect(manager.snapshot()).toEqual([
			expect.objectContaining({
				watch_id: "watch_other",
				owner_connection_id: "conn_other",
			}),
		]);

		manager.dispose();
	});
});
