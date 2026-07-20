import { afterEach, describe, expect, it, vi } from "vitest";
import { RunController } from "../../src/cli-tui/run/run-controller.js";

describe("RunController", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("waits for renderer shutdown before exiting on double Ctrl-C", async () => {
		const calls: string[] = [];
		vi.spyOn(process, "exit").mockImplementation(((
			code?: number | string | null,
		) => {
			calls.push(`exit-${code}`);
			return undefined as never;
		}) as typeof process.exit);
		const controller = new RunController({
			loaderView: {} as never,
			ui: { requestRender: vi.fn() } as never,
			setEditorDisabled: vi.fn(),
			focusEditor: () => {
				calls.push("focus");
			},
			clearEditor: () => {
				calls.push("clear");
			},
			stopRenderer: async () => {
				calls.push("stop-start");
				await Promise.resolve();
				calls.push("stop-finished");
			},
			refreshFooterHint: vi.fn(),
			notifyFileChanges: vi.fn(),
			inMinimalMode: () => false,
		});

		await controller.handleCtrlC();
		await controller.handleCtrlC();

		expect(calls).toEqual([
			"clear",
			"focus",
			"stop-start",
			"stop-finished",
			"exit-0",
		]);
	});
});
