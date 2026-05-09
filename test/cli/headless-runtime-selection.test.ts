import { describe, expect, it, vi } from "vitest";
import {
	LEGACY_HEADLESS_RUNTIME_EVENT,
	LEGACY_HEADLESS_RUNTIME_FLAG,
	LEGACY_HEADLESS_RUNTIME_ID,
	recordHeadlessRuntimeSelection,
	selectHeadlessRuntime,
} from "../../src/cli/headless-runtime-selection.js";

describe("headless runtime selection", () => {
	it("uses the current runtime by default", () => {
		expect(selectHeadlessRuntime({})).toEqual({ kind: "current" });
	});

	it("selects the legacy runtime for the hidden escape flag", () => {
		expect(selectHeadlessRuntime({ legacyRuntime: true })).toEqual({
			kind: "legacy",
			flag: LEGACY_HEADLESS_RUNTIME_FLAG,
			runtimeId: LEGACY_HEADLESS_RUNTIME_ID,
			event: LEGACY_HEADLESS_RUNTIME_EVENT,
		});
	});

	it("emits one measurable info event only when legacy runtime is selected", () => {
		const logger = { info: vi.fn() };

		recordHeadlessRuntimeSelection({ kind: "current" }, logger);
		expect(logger.info).not.toHaveBeenCalled();

		recordHeadlessRuntimeSelection(
			selectHeadlessRuntime({ legacyRuntime: true }),
			logger,
		);

		expect(logger.info).toHaveBeenCalledOnce();
		expect(logger.info).toHaveBeenCalledWith(LEGACY_HEADLESS_RUNTIME_EVENT, {
			flag: LEGACY_HEADLESS_RUNTIME_FLAG,
			runtime: LEGACY_HEADLESS_RUNTIME_ID,
			surface: "headless",
		});
	});
});
