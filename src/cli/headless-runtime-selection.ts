import { createLogger } from "../utils/logger.js";

export const LEGACY_HEADLESS_RUNTIME_ENV = "MAESTRO_INTERNAL_HEADLESS_RUNTIME";
export const LEGACY_HEADLESS_RUNTIME_ENV_VALUE = "legacy";
export const LEGACY_HEADLESS_RUNTIME_ID = "typescript-headless-legacy";
export const LEGACY_HEADLESS_RUNTIME_EVENT = "runtime_legacy_selected";

export type HeadlessRuntimeSelection =
	| {
			kind: "current";
	  }
	| {
			kind: "legacy";
			source: typeof LEGACY_HEADLESS_RUNTIME_ENV;
			runtimeId: typeof LEGACY_HEADLESS_RUNTIME_ID;
			event: typeof LEGACY_HEADLESS_RUNTIME_EVENT;
	  };

export interface RuntimeSelectionLogger {
	info(message: string, context?: Record<string, unknown>): void;
}

type HeadlessModeArgs = {
	headless?: boolean;
	mode?: string;
};

type HeadlessDispatchArgs = HeadlessModeArgs & {
	command?: string;
};

export function isHeadlessModeRequested(args: HeadlessModeArgs): boolean {
	return args.headless === true || args.mode === "headless";
}

export function willDispatchHeadlessRuntime(
	args: HeadlessDispatchArgs,
): boolean {
	return (
		isHeadlessModeRequested(args) &&
		(args.command === undefined || args.command === "exec")
	);
}

export function isLegacyHeadlessRuntimeRequested(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[LEGACY_HEADLESS_RUNTIME_ENV] === LEGACY_HEADLESS_RUNTIME_ENV_VALUE;
}

export function selectHeadlessRuntime(
	env: NodeJS.ProcessEnv = process.env,
	options: { allowLegacy?: boolean } = {},
): HeadlessRuntimeSelection {
	if (options.allowLegacy !== true || !isLegacyHeadlessRuntimeRequested(env)) {
		return { kind: "current" };
	}

	return {
		kind: "legacy",
		source: LEGACY_HEADLESS_RUNTIME_ENV,
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
		runtime: selection.runtimeId,
		source: selection.source,
		surface: "headless",
	});
}
