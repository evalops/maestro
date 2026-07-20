/**
 * Framework command handler.
 *
 * Usage:
 *   /framework           - Show current framework
 *   /framework list      - List available frameworks
 *   /framework <name>    - Set default framework
 *   /framework none      - Clear framework preference
 *   /framework -w <name> - Set workspace-scoped framework
 */

import {
	getFrameworkSummary,
	listFrameworks,
	resolveFrameworkPreference,
	setDefaultFramework,
	setWorkspaceFramework,
} from "../../config/framework.js";
import type { CommandExecutionContext } from "./types.js";

export interface FrameworkCommandDeps {
	showInfo: (message: string) => void;
	showError: (message: string) => void;
	showSuccess: (message: string) => void;
}

export function handleFrameworkCommand(
	context: CommandExecutionContext,
	deps: FrameworkCommandDeps,
): void {
	const parts = context.argumentText
		.split(/\s+/)
		.map((p) => p.trim())
		.filter(Boolean);

	const flags = new Set(parts.filter((p) => p.startsWith("-")));
	const value = parts.find((p) => !p.startsWith("-"));
	const targetWorkspace = flags.has("--workspace") || flags.has("-w");
	const targetLabel = targetWorkspace ? "workspace" : "user";

	if (!value) {
		const pref = resolveFrameworkPreference();
		const current = pref.id ?? "none";
		const scopeHint = targetWorkspace ? "(workspace) " : "";
		deps.showInfo(
			`${scopeHint}Default framework: ${current} (source: ${pref.source})`,
		);
		return;
	}

	const normalized = value.toLowerCase();
	if (normalized === "list") {
		const items = listFrameworks()
			.map((f) => `${f.id} — ${f.summary}`)
			.join("\n");
		deps.showInfo(`Available frameworks:\n${items}`);
		return;
	}

	const setter = targetWorkspace ? setWorkspaceFramework : setDefaultFramework;

	if (normalized === "none" || normalized === "off") {
		try {
			setter(null);
			deps.showSuccess(`Default framework cleared for ${targetLabel} scope`);
		} catch (error) {
			deps.showError(error instanceof Error ? error.message : String(error));
		}
		return;
	}

	const info = getFrameworkSummary(normalized);
	try {
		setter(normalized);
		const summary =
			info?.summary ?? `Preferred framework set to ${normalized}.`;
		deps.showSuccess(`${summary} (scope: ${targetLabel})`);
	} catch (error) {
		deps.showError(error instanceof Error ? error.message : String(error));
	}
}
