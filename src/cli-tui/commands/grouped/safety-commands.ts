/**
 * Consolidated /safety command handler.
 *
 * Combines: /approvals, /plan-mode, /guardian
 *
 * Usage:
 *   /safety                    - Show safety settings overview
 *   /safety approvals [mode]   - Approval mode (auto|prompt|fail)
 *   /safety plan [on|off]      - Toggle plan mode
 *   /safety guardian [cmd]     - Guardian scanning (run|status|enable|disable)
 */

import type { CommandExecutionContext } from "../types.js";
import { isHelpRequest, parseSubcommand } from "./utils.js";

export interface SafetyCommandDeps {
	handleApprovals: (ctx: CommandExecutionContext) => void;
	handlePlanMode: (ctx: CommandExecutionContext) => void;
	handleGuardian: (ctx: CommandExecutionContext) => Promise<void> | void;
	showInfo: (message: string) => void;
	getSafetyState: () => {
		approvalMode: string;
		planMode: boolean;
		guardianEnabled: boolean;
	};
}

export function createSafetyCommandHandler(deps: SafetyCommandDeps) {
	return async function handleSafetyCommand(
		ctx: CommandExecutionContext,
	): Promise<void> {
		const { subcommand, rewriteContext } = parseSubcommand(ctx, "status");

		switch (subcommand) {
			case "status":
			case "info":
				showSafetyStatus(deps);
				break;

			case "approvals":
			case "approval":
			case "approve":
				deps.handleApprovals(rewriteContext("approvals"));
				break;

			case "plan":
			case "plan-mode":
			case "planmode":
				deps.handlePlanMode(rewriteContext("plan-mode"));
				break;

			case "guardian":
			case "guard":
			case "scan":
				await deps.handleGuardian(rewriteContext("guardian"));
				break;

			default:
				if (isHelpRequest(subcommand)) {
					showSafetyHelp(ctx);
				} else {
					ctx.showError(`Unknown subcommand: ${subcommand}`);
					showSafetyHelp(ctx);
				}
		}
	};
}

function showSafetyStatus(deps: SafetyCommandDeps): void {
	const state = deps.getSafetyState();
	deps.showInfo(`Safety Settings:
  Approval Mode: ${state.approvalMode}
  Plan Mode: ${state.planMode ? "on" : "off"}
  Guardian: ${state.guardianEnabled ? "enabled" : "disabled"}

Use /safety <setting> to change a setting.`);
}

function showSafetyHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Safety Commands:
  /safety                    Show safety settings
  /safety approvals [mode]   Set approval mode (auto|prompt|fail)
  /safety plan [on|off]      Toggle plan mode (ask before mutations)
  /safety guardian [cmd]     Guardian scanning:
                             - run: scan staged files
                             - status: show last scan
                             - enable/disable: toggle enforcement

Direct shortcuts still work: /approvals, /plan-mode, /guardian`);
}
