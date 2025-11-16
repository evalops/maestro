import type {
	ActionApprovalContext,
	ActionFirewallVerdict,
} from "../agent/action-approval.js";

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
	return (
		context.toolName === "bash" && typeof context.args?.command === "string"
	);
}

export const defaultFirewallRules: ActionFirewallRule[] = [
	{
		id: "bash-rm-rf",
		description: "High-risk recursive delete",
		match: (ctx) => isBashTool(ctx) && rmRfPattern.test(ctx.args.command),
		reason: (ctx) => `Potential destructive delete: ${ctx.args.command.trim()}`,
	},
	{
		id: "bash-mkfs",
		description: "Filesystem formatting",
		match: (ctx) => isBashTool(ctx) && mkfsPattern.test(ctx.args.command),
		reason: (ctx) => `Detected mkfs invocation: ${ctx.args.command.trim()}`,
	},
	{
		id: "bash-disk-zero",
		description: "Disk zeroing",
		match: (ctx) => isBashTool(ctx) && diskZeroPattern.test(ctx.args.command),
		reason: (ctx) => `Detected disk zeroing: ${ctx.args.command.trim()}`,
	},
	{
		id: "bash-chmod-000",
		description: "Permission removal",
		match: (ctx) => isBashTool(ctx) && chmodZeroPattern.test(ctx.args.command),
		reason: (ctx) => `Detected chmod 000*: ${ctx.args.command.trim()}`,
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
