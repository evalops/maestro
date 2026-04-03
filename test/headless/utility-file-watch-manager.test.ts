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
		expect(events).toEqual([{ type: "stopped", watch_id: "watch_src" }]);
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
});
