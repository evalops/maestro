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

function isBashTool(context: ActionApprovalContext): boolean {
	const command =
		context.args &&
		typeof context.args === "object" &&
		"command" in context.args &&
		typeof (context.args as { command?: unknown }).command === "string"
			? (context.args as { command: string }).command
			: null;
	return context.toolName === "bash" && Boolean(command);
}

function getCommandArg(context: ActionApprovalContext): string | null {
	if (
		context.args &&
		typeof context.args === "object" &&
		"command" in context.args &&
		typeof (context.args as { command?: unknown }).command === "string"
	) {
		return (context.args as { command: string }).command;
	}
	return null;
}

export const defaultFirewallRules: ActionFirewallRule[] = [
	{
		id: "bash-rm-rf",
		description: "High-risk recursive delete",
		match: (ctx) => {
			const command = getCommandArg(ctx);
			return isBashTool(ctx) && !!command && rmRfPattern.test(command);
		},
		reason: (ctx) => {
			const command = getCommandArg(ctx) ?? "";
			return `Potential destructive delete: ${command.trim()}`;
		},
	},
	{
		id: "bash-mkfs",
		description: "Filesystem formatting",
		match: (ctx) => {
			const command = getCommandArg(ctx);
			return isBashTool(ctx) && !!command && mkfsPattern.test(command);
		},
		reason: (ctx) => {
			const command = getCommandArg(ctx) ?? "";
			return `Detected mkfs invocation: ${command.trim()}`;
		},
	},
	{
		id: "bash-disk-zero",
		description: "Disk zeroing",
		match: (ctx) => {
			const command = getCommandArg(ctx);
			return isBashTool(ctx) && !!command && diskZeroPattern.test(command);
		},
		reason: (ctx) => {
			const command = getCommandArg(ctx) ?? "";
			return `Detected disk zeroing: ${command.trim()}`;
		},
	},
	{
		id: "bash-chmod-000",
		description: "Permission removal",
		match: (ctx) => {
			const command = getCommandArg(ctx);
			return isBashTool(ctx) && !!command && chmodZeroPattern.test(command);
		},
		reason: (ctx) => {
			const command = getCommandArg(ctx) ?? "";
			return `Detected chmod 000*: ${command.trim()}`;
		},
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
