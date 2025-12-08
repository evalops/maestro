import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoaderStageManager } from "../../src/cli-tui/loader/loader-stage-manager.js";
import { STAGE_DISPLAY_LABELS } from "../../src/cli-tui/utils/stage-labels.js";

vi.mock("../../src/telemetry.js", () => ({
	recordLoaderStage: vi.fn(),
}));

describe("LoaderStageManager dreaming stage", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	function createManager() {
		const stageLabels: string[] = [];
		const footerStages: Array<string | null> = [];
		const hints: Array<string | null> = [];
		const manager = new LoaderStageManager({
			setFooterStage: (label) => footerStages.push(label),
			setFooterHint: (hint) => hints.push(hint),
			onStageChanged: (label) => stageLabels.push(label),
			onProgressChanged: () => {},
		});
		return { manager, stageLabels, footerStages, hints };
	}

	it("switches to Dreaming after five seconds of Thinking", () => {
		const { manager, stageLabels, footerStages, hints } = createManager();
		manager.start();
		expect(stageLabels.at(-1)).toBe(STAGE_DISPLAY_LABELS.thinking);
		vi.advanceTimersByTime(5100);
		expect(stageLabels.at(-1)).toBe(STAGE_DISPLAY_LABELS.dreaming);
		expect(footerStages.at(-1)).toBe(STAGE_DISPLAY_LABELS.dreaming);
		expect(hints.at(-1)).toBe("composer is pondering a haiku…");
	});

	it("clears Dreaming state when progressing to a tool stage", () => {
		const { manager, stageLabels, hints } = createManager();
		manager.start();
		vi.advanceTimersByTime(5100);
		manager.registerToolStage("tool-1", "search");
		expect(stageLabels.at(-1)).toContain("Working · search");
		expect(hints.at(-1)).toBeNull();
	});
});
