/**
 * Startup probe for the native maestro-tui binary used by web/headless paths.
 *
 * Web SSE/WS chat, automations, hosted headless, and prompt suggestion require
 * `maestro-tui --headless`. Call this from `startWebServer` so a missing binary
 * is visible at boot (error log; product paths fail closed without a binary).
 */

import {
	type ResolveMaestroTuiBinaryOptions,
	resolveMaestroTuiBinary,
} from "../cli/native-tui-launcher.js";

export type MaestroTuiBootCheckResult =
	| { status: "ok"; binary: string }
	| { status: "missing"; message: string };

const MISSING_HINT =
	"Published npm packages ship vendor/maestro-tui/<platform>-<arch>/maestro-tui. " +
	"One-line install also places maestro-tui on PATH next to maestro. " +
	"Override with MAESTRO_TUI_BIN, or build packages/tui-rs (bun run tui-rs:build).";

/**
 * Resolve maestro-tui for native web/headless. Always probes (native-only).
 */
export function checkMaestroTuiBinaryForWebServer(
	env: NodeJS.ProcessEnv = process.env,
	options: ResolveMaestroTuiBinaryOptions = {},
): MaestroTuiBootCheckResult {
	try {
		const binary = resolveMaestroTuiBinary({
			...options,
			env: options.env ?? env,
		});
		return { status: "ok", binary };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			status: "missing",
			message,
		};
	}
}

export type MaestroTuiBootLogger = {
	warn: (message: string, context?: Record<string, unknown>) => void;
	error: (message: string, context?: Record<string, unknown>) => void;
};

/**
 * Log a missing binary at error (fail-closed). No soft warn path — native is
 * required for all product agent surfaces.
 * No-op when resolution succeeded.
 */
export function logMaestroTuiBootCheck(
	result: MaestroTuiBootCheckResult,
	log: MaestroTuiBootLogger,
): void {
	if (result.status !== "missing") {
		return;
	}
	log.error(
		"maestro-tui binary not found; native web/headless will fail — install or build maestro-tui",
		{
			error: result.message,
			hint: MISSING_HINT,
		},
	);
}
