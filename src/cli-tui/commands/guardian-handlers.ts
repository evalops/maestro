/**
 * Guardian command handler.
 *
 * Usage:
 *   /guardian           - Run guardian scan on staged files
 *   /guardian enable    - Enable guardian
 *   /guardian disable   - Disable guardian
 *   /guardian status    - Show guardian status and last run
 *   /guardian all       - Scan all files (not just staged)
 */

import {
	formatGuardianResult,
	loadGuardianState,
	runGuardian,
	setGuardianEnabled,
} from "../../guardian/index.js";
import type { CommandExecutionContext } from "./types.js";

export interface GuardianCommandDeps {
	showSuccess: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	addContent: (content: string) => void;
	requestRender: () => void;
}

export async function handleGuardianCommand(
	context: CommandExecutionContext,
	deps: GuardianCommandDeps,
): Promise<void> {
	const arg = context.argumentText.trim().toLowerCase();

	if (arg.startsWith("enable")) {
		setGuardianEnabled(true);
		deps.showSuccess(
			"Composer Guardian enabled (Semgrep + secrets before commit/push).",
		);
		return;
	}

	if (arg.startsWith("disable")) {
		setGuardianEnabled(false);
		deps.showWarning(
			"Composer Guardian disabled. Set COMPOSER_GUARDIAN=1 to force on.",
		);
		return;
	}

	if (arg.startsWith("status") || arg.startsWith("last")) {
		const state = loadGuardianState();
		const statusLine = `Guardian is ${state.enabled ? "enabled" : "disabled"}.`;
		const runSummary = state.lastRun
			? formatGuardianResult(state.lastRun)
			: "No Guardian run recorded yet.";
		deps.addContent([statusLine, "", runSummary].join("\n"));
		deps.requestRender();
		return;
	}

	const target = arg.includes("all") ? "all" : "staged";
	const result = await runGuardian({
		target,
		trigger: "/guardian",
	});

	deps.addContent(`### Guardian\n${formatGuardianResult(result)}`);
	deps.requestRender();

	if (result.status === "failed" || result.status === "error") {
		deps.showError(
			"Composer Guardian found issues. Resolve findings or set COMPOSER_GUARDIAN=0 to override (not recommended).",
		);
	} else if (result.status === "passed") {
		deps.showSuccess("Guardian passed.");
	}
}
