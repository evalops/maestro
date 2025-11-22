import type {
	ActionApprovalContext,
	ActionFirewallVerdict,
} from "../agent/action-approval.js";
export type { ActionApprovalContext } from "../agent/action-approval.js";

export interface ActionFirewallRule {
	id: string;
	description: string;
	match: (context: ActionApprovalContext) => boolean;
	reason?: (context: ActionApprovalContext) => string;
}

const rmRfPattern =
	/\brm\s+-[^\n]*-?r[^\n]*-?f[^\n]*\s+(?:-+\w+\s+)*(["']?\/?[\w.*\-\s]*|\.)/i;
const mkfsPattern = /\bmkfs\b|\bmkfs\.[a-z0-9]+/i;
const diskZeroPattern = /dd\s+if=\/dev\/(?:zero|null)/i;
const chmodZeroPattern = /chmod\s+0{3,4}\b/i;

function getArgsObject(
	context: ActionApprovalContext,
): Record<string, unknown> | null {
	return context.args && typeof context.args === "object"
		? (context.args as Record<string, unknown>)
		: null;
}

function getStringArg(
	context: ActionApprovalContext,
	key: string,
): string | null {
	const args = getArgsObject(context);
	if (!args) {
		return null;
	}
	const value = args[key];
	return typeof value === "string" ? value : null;
}

function getBooleanArg(
	context: ActionApprovalContext,
	key: string,
): boolean | null {
	const args = getArgsObject(context);
	if (!args) {
		return null;
	}
	const value = args[key];
	return typeof value === "boolean" ? value : null;
}

function getCommandArg(context: ActionApprovalContext): string | null {
	return getStringArg(context, "command");
}

function isBackgroundTaskShellStart(context: ActionApprovalContext): boolean {
	if (context.toolName !== "background_tasks") {
		return false;
	}
	const action = getStringArg(context, "action");
	if (action !== "start") {
		return false;
	}
	return getBooleanArg(context, "shell") === true;
}

export const defaultFirewallRules: ActionFirewallRule[] = [
	{
		id: "command-rm-rf",
		description: "High-risk recursive delete",
		match: (ctx) => {
			const command = getCommandArg(ctx);
			return !!command && rmRfPattern.test(command);
		},
		reason: (ctx) => {
			const command = getCommandArg(ctx) ?? "";
			return `Potential destructive delete: ${command.trim()}`;
		},
	},
	{
		id: "command-mkfs",
		description: "Filesystem formatting",
		match: (ctx) => {
			const command = getCommandArg(ctx);
			return !!command && mkfsPattern.test(command);
		},
		reason: (ctx) => {
			const command = getCommandArg(ctx) ?? "";
			return `Detected mkfs invocation: ${command.trim()}`;
		},
	},
	{
		id: "command-disk-zero",
		description: "Disk zeroing",
		match: (ctx) => {
			const command = getCommandArg(ctx);
			return !!command && diskZeroPattern.test(command);
		},
		reason: (ctx) => {
			const command = getCommandArg(ctx) ?? "";
			return `Detected disk zeroing: ${command.trim()}`;
		},
	},
	{
		id: "command-chmod-000",
		description: "Permission removal",
		match: (ctx) => {
			const command = getCommandArg(ctx);
			return !!command && chmodZeroPattern.test(command);
		},
		reason: (ctx) => {
			const command = getCommandArg(ctx) ?? "";
			return `Detected chmod 000*: ${command.trim()}`;
		},
	},
	{
		id: "background-shell-mode",
		description: "Shell mode background tasks",
		match: (ctx) => isBackgroundTaskShellStart(ctx),
		reason: () =>
			"Background task shell mode requires manual approval (pipes, redirects, and globbing are high risk)",
	},
];

export class ActionFirewall {
	constructor(
		private readonly rules: ActionFirewallRule[] = defaultFirewallRules,
	) {}

	evaluate(context: ActionApprovalContext): ActionFirewallVerdict {
		for (const rule of this.rules) {
			if (rule.match(context)) {
				return {
					action: "require_approval",
					ruleId: rule.id,
					reason:
						rule.reason?.(context) ??
						`Action matched high-risk rule: ${rule.description}`,
				};
			}
		}
		return { action: "allow" };
	}
}

export const defaultActionFirewall = new ActionFirewall();
