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

import {
	SecurityAdvisor,
	formatAdvisory,
} from "../../../safety/security-advisor.js";
import {
	type SecurityEvent,
	getEventStats,
	getRecentEvents,
} from "../../../telemetry/security-events.js";
import type { CommandExecutionContext } from "../types.js";
import { createSubcommandHandler } from "./utils.js";

export interface SafetyCommandDeps {
	handleApprovals: (ctx: CommandExecutionContext) => void;
	handlePlanMode: (ctx: CommandExecutionContext) => void;
	handleGuardian: (ctx: CommandExecutionContext) => Promise<void> | void;
	getSafetyState: () => {
		approvalMode: string;
		planMode: boolean;
		guardianEnabled: boolean;
	};
}

export function createSafetyCommandHandler(deps: SafetyCommandDeps) {
	return createSubcommandHandler({
		defaultSubcommand: "status",
		showHelp: showSafetyHelp,
		routes: [
			{
				match: ["status", "info"],
				execute: ({ ctx }) => showSafetyStatus(ctx, deps),
			},
			{
				match: ["approvals", "approval", "approve"],
				execute: ({ rewriteContext }) =>
					deps.handleApprovals(rewriteContext("approvals")),
			},
			{
				match: ["plan", "plan-mode", "planmode"],
				execute: ({ rewriteContext }) =>
					deps.handlePlanMode(rewriteContext("plan-mode")),
			},
			{
				match: ["guardian", "guard", "scan"],
				execute: ({ rewriteContext }) =>
					deps.handleGuardian(rewriteContext("guardian")),
			},
			{
				match: ["events", "security", "logs"],
				execute: ({ ctx }) => showSecurityEvents(ctx),
			},
			{
				match: ["threats", "threat", "advisory"],
				execute: ({ ctx }) => showThreatLevel(ctx),
			},
		],
	});
}

function showSafetyStatus(
	ctx: CommandExecutionContext,
	deps: SafetyCommandDeps,
): void {
	const state = deps.getSafetyState();
	ctx.showInfo(`Safety Settings:
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
function showSecurityEvents(ctx: CommandExecutionContext): void {
	// Parse limit from arguments
	const args = ctx.argumentText.split(/\s+/).filter(Boolean);
	const subArg = args[1]; // Skip "events" subcommand
	const limit = subArg ? Number.parseInt(subArg, 10) || 10 : 10;

	const events = getRecentEvents(limit);
	const stats = getEventStats();

	if (events.length === 0) {
		ctx.showInfo(`Security Events:
  No security events recorded in this session.

  Stats: 0 total events

  Use /safety threats to see threat assessment.`);
		return;
	}

	const eventLines = events
		.reverse() // Most recent first
		.map((e) => `  ${formatEvent(e)}`)
		.join("\n");

	ctx.showInfo(`Security Events (last ${events.length}):
${eventLines}

Stats:
  Total: ${stats.total} | Critical: ${stats.bySeverity.critical} | High: ${stats.bySeverity.high} | Medium: ${stats.bySeverity.medium} | Low: ${stats.bySeverity.low}
  Recent high-severity (1h): ${stats.recentHigh}

Use /safety threats for threat assessment.`);
}

/**
 * Show threat level and advisories
 */
function showThreatLevel(ctx: CommandExecutionContext): void {
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
		output += "\n  No active advisories.\n";
	}

	output += "\nUse /safety events [N] to see recent events.";

	ctx.showInfo(output);
	advisor.dispose();
}
