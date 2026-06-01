import { describe, expect, it, vi } from "vitest";
import {
	LEGACY_HEADLESS_RUNTIME_ENV,
	LEGACY_HEADLESS_RUNTIME_ENV_VALUE,
	LEGACY_HEADLESS_RUNTIME_EVENT,
	LEGACY_HEADLESS_RUNTIME_ID,
	isHeadlessModeRequested,
	recordHeadlessRuntimeSelection,
	selectHeadlessRuntime,
	willDispatchHeadlessRuntime,
} from "../../src/cli/headless-runtime-selection.js";

describe("headless runtime selection", () => {
	it("uses the current runtime by default", () => {
		expect(selectHeadlessRuntime({})).toEqual({ kind: "current" });
	});

	it("selects the legacy runtime for the internal cutover gate", () => {
		expect(
			selectHeadlessRuntime(
				{
					[LEGACY_HEADLESS_RUNTIME_ENV]: LEGACY_HEADLESS_RUNTIME_ENV_VALUE,
				},
				{ allowLegacy: true },
			),
		).toEqual({
			kind: "legacy",
			source: LEGACY_HEADLESS_RUNTIME_ENV,
			runtimeId: LEGACY_HEADLESS_RUNTIME_ID,
			event: LEGACY_HEADLESS_RUNTIME_EVENT,
		});
	});

	it("ignores the internal cutover gate until headless dispatch allows it", () => {
		expect(
			selectHeadlessRuntime({
				[LEGACY_HEADLESS_RUNTIME_ENV]: LEGACY_HEADLESS_RUNTIME_ENV_VALUE,
			}),
		).toEqual({ kind: "current" });
	});

	it("emits one measurable info event only when legacy runtime is selected", () => {
		const logger = { info: vi.fn() };
		const recorder = vi.fn();

		recordHeadlessRuntimeSelection({ kind: "current" }, logger, recorder);
		expect(logger.info).not.toHaveBeenCalled();
		expect(recorder).not.toHaveBeenCalled();

		recordHeadlessRuntimeSelection(
			selectHeadlessRuntime(
				{
					[LEGACY_HEADLESS_RUNTIME_ENV]: LEGACY_HEADLESS_RUNTIME_ENV_VALUE,
				},
				{ allowLegacy: true },
			),
			logger,
			recorder,
		);

		expect(logger.info).toHaveBeenCalledOnce();
		expect(logger.info).toHaveBeenCalledWith(LEGACY_HEADLESS_RUNTIME_EVENT, {
			runtime: LEGACY_HEADLESS_RUNTIME_ID,
			source: LEGACY_HEADLESS_RUNTIME_ENV,
			surface: "headless",
		});
		expect(recorder).toHaveBeenCalledWith("internal_gate_used", {
			surfaceId: "internal-gate:headless-runtime-selector",
			surfaceType: "internal_gate",
			owner: "headless-runtime",
			source: LEGACY_HEADLESS_RUNTIME_ENV,
			metadata: {
				runtime: LEGACY_HEADLESS_RUNTIME_ID,
				event: LEGACY_HEADLESS_RUNTIME_EVENT,
			},
		});
	});

	it("matches the CLI paths that really dispatch headless runtime", () => {
		expect(willDispatchHeadlessRuntime({ mode: "headless" })).toBe(true);
		expect(willDispatchHeadlessRuntime({ headless: true })).toBe(true);
		expect(
			willDispatchHeadlessRuntime({ command: "exec", mode: "headless" }),
		).toBe(true);
		expect(
			willDispatchHeadlessRuntime({ command: "web", mode: "headless" }),
		).toBe(false);
		expect(
			willDispatchHeadlessRuntime({ command: "agents", mode: "headless" }),
		).toBe(false);
	});

	it("distinguishes requested headless mode from actual dispatch", () => {
		expect(isHeadlessModeRequested({ mode: "headless" })).toBe(true);
		expect(isHeadlessModeRequested({ headless: true })).toBe(true);
		expect(isHeadlessModeRequested({ mode: "json" })).toBe(false);
	});
});
