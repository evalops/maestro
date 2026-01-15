/**
 * Consolidated /safety command handler.
 *
 * Combines: /approvals, /plan-mode, /guardian, /security events
 *
 * Usage:
 *   /safety                    - Show safety settings overview
 *   /safety approvals [mode]   - Approval mode (auto|prompt|fail)
 *   /safety plan [on|off]      - Toggle plan mode
 *   /safety guardian [cmd]     - Guardian scanning (run|status|enable|disable)
 *   /safety events [N]         - Show recent N security events (default: 10)
 *   /safety threats            - Show threat level and advisories
 */

import type { CommandExecutionContext } from "../types.js";
import { isHelpRequest, parseSubcommand } from "./utils.js";
import {
	getRecentEvents,
	getEventStats,
	type SecurityEvent,
} from "../../../telemetry/security-events.js";
import {
	SecurityAdvisor,
	formatAdvisory,
} from "../../../safety/security-advisor.js";

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

			case "events":
			case "security":
			case "logs":
				showSecurityEvents(ctx, deps);
				break;

			case "threats":
			case "threat":
			case "advisory":
				showThreatLevel(deps);
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
  /safety events [N]         Show recent N security events (default: 10)
  /safety threats            Show threat level and advisories

Direct shortcuts still work: /approvals, /plan-mode, /guardian`);
}

/**
 * Format a security event for display
 */
function formatEvent(event: SecurityEvent): string {
	const severityIcon: Record<string, string> = {
		critical: "🔴",
		high: "🟠",
		medium: "🟡",
		low: "🔵",
	};
	const icon = severityIcon[event.severity] ?? "•";
	const time = new Date(event.timestamp).toLocaleTimeString();
	const tool = event.toolName ? ` [${event.toolName}]` : "";
	return `${icon} ${time}${tool} ${event.description}`;
}

/**
 * Show recent security events
 */
function showSecurityEvents(
	ctx: CommandExecutionContext,
	deps: SafetyCommandDeps,
): void {
	// Parse limit from arguments
	const args = ctx.argumentText.split(/\s+/).filter(Boolean);
	const subArg = args[1]; // Skip "events" subcommand
	const limit = subArg ? parseInt(subArg, 10) || 10 : 10;

	const events = getRecentEvents(limit);
	const stats = getEventStats();

	if (events.length === 0) {
		deps.showInfo(`Security Events:
  No security events recorded in this session.

  Stats: 0 total events

  Use /safety threats to see threat assessment.`);
		return;
	}

	const eventLines = events
		.reverse() // Most recent first
		.map((e) => `  ${formatEvent(e)}`)
		.join("\n");

	deps.showInfo(`Security Events (last ${events.length}):
${eventLines}

Stats:
  Total: ${stats.total} | Critical: ${stats.bySeverity.critical} | High: ${stats.bySeverity.high} | Medium: ${stats.bySeverity.medium} | Low: ${stats.bySeverity.low}
  Recent high-severity (1h): ${stats.recentHigh}

Use /safety threats for threat assessment.`);
}

/**
 * Show threat level and advisories
 */
function showThreatLevel(deps: SafetyCommandDeps): void {
	const advisor = new SecurityAdvisor({ enableRealtime: false });
	const threat = advisor.getThreatLevel();
	const advisories = advisor.analyze();

	const levelIcon: Record<string, string> = {
		info: "✅",
		warning: "⚠️",
		alert: "🚨",
		critical: "🔴",
	};

	let output = `Threat Assessment:
  Level: ${levelIcon[threat.level] ?? "•"} ${threat.level.toUpperCase()} (score: ${threat.score.toFixed(1)})
  ${threat.summary}
`;

	if (advisories.length > 0) {
		output += `\nActive Advisories (${advisories.length}):\n`;
		for (const adv of advisories) {
			output += `\n${formatAdvisory(adv)}\n`;
		}
	} else {
		output += `\n  No active advisories.\n`;
	}

	output += `\nUse /safety events [N] to see recent events.`;

	deps.showInfo(output);
	advisor.dispose();
}
