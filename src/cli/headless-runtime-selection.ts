import { createLogger } from "../utils/logger.js";
import type { Args } from "./args.js";

export const LEGACY_HEADLESS_RUNTIME_FLAG = "--legacy-runtime";
export const LEGACY_HEADLESS_RUNTIME_ID = "typescript-headless-legacy";
export const LEGACY_HEADLESS_RUNTIME_EVENT = "runtime_legacy_selected";

export type HeadlessRuntimeSelection =
	| {
			kind: "current";
	  }
	| {
			kind: "legacy";
			flag: typeof LEGACY_HEADLESS_RUNTIME_FLAG;
			runtimeId: typeof LEGACY_HEADLESS_RUNTIME_ID;
			event: typeof LEGACY_HEADLESS_RUNTIME_EVENT;
	  };

export interface RuntimeSelectionLogger {
	info(message: string, context?: Record<string, unknown>): void;
}

export function selectHeadlessRuntime(
	args: Pick<Args, "legacyRuntime">,
): HeadlessRuntimeSelection {
	if (!args.legacyRuntime) {
		return { kind: "current" };
	}

	return {
		kind: "legacy",
		flag: LEGACY_HEADLESS_RUNTIME_FLAG,
		runtimeId: LEGACY_HEADLESS_RUNTIME_ID,
		event: LEGACY_HEADLESS_RUNTIME_EVENT,
	};
}

export function recordHeadlessRuntimeSelection(
	selection: HeadlessRuntimeSelection,
	logger: RuntimeSelectionLogger = createLogger("headless-runtime"),
): void {
	if (selection.kind !== "legacy") {
		return;
	}

	logger.info(selection.event, {
		flag: selection.flag,
		runtime: selection.runtimeId,
		surface: "headless",
	});
}
