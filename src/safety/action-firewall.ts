import type {
	ActionApprovalContext,
	ActionFirewallVerdict,
	WorkflowStateSnapshot,
} from "../agent/action-approval.js";
export type { ActionApprovalContext } from "../agent/action-approval.js";
import { createLogger } from "../utils/logger.js";
import { checkPolicy } from "./policy.js";
import { TOOL_TAGS, looksLikeEgress } from "./workflow-state.js";

const logger = createLogger("safety:action-firewall");

export interface ActionFirewallRule {
	id: string;
	description: string;
	match: (context: ActionApprovalContext) => boolean | Promise<boolean>;
	reason?: (context: ActionApprovalContext) => string | Promise<string>;
}

const rmRfPattern =
	/\brm\s+-[^\n]*-?r[^\n]*-?f[^\n]*\s+(?:-+\w+\s+)*(["']?\/?[\w.*\-\s]*|\.)/i;
const mkfsPattern = /\bmkfs\b|\bmkfs\.[a-z0-9]+/i;
const diskZeroPattern = /dd\s+if=\/dev\/(?:zero|null)/i;
const chmodZeroPattern = /chmod\s+0{3,4}\b/i;
const untaggedEgressWarnings = new Set<string>();
export const HUMAN_EGRESS_PII_RULE_ID = "pii-redaction-before-human-egress";

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

function getWorkflowState(
	context: ActionApprovalContext,
): WorkflowStateSnapshot | null {
	return context.metadata?.workflowState ?? null;
}

function getPendingUnredactedPii(
	context: ActionApprovalContext,
): WorkflowStateSnapshot["pendingPii"] {
	const snapshot = getWorkflowState(context);
	if (!snapshot) {
		return [];
	}
	return snapshot.pendingPii.filter((artifact) => artifact.redacted !== true);
}

function warnUntaggedEgress(toolName: string): void {
	if (untaggedEgressWarnings.has(toolName)) {
		return;
	}
	untaggedEgressWarnings.add(toolName);
	logger.warn(
		"Untagged egress-like tool encountered; treating as human-facing until TOOL_TAGS is updated",
		{ toolName },
	);
}

function isHumanFacingTool(toolName: string): boolean {
	const toolTags = TOOL_TAGS[toolName];
	if (toolTags?.egress === "human") {
		return true;
	}
	if (!toolTags && looksLikeEgress(toolName)) {
		warnUntaggedEgress(toolName);
		return true;
	}
	return false;
}

function getAnnotations(context: ActionApprovalContext) {
	return context.metadata?.annotations;
}

function isMcpTool(toolName: string): boolean {
	return toolName.startsWith("mcp_");
}

export const defaultFirewallRules: ActionFirewallRule[] = [
	{
		id: "enterprise-policy",
		description: "Enforce enterprise policies on tools and dependencies",
		match: async (ctx) => {
			const result = await checkPolicy(ctx);
			// Cache result on context to avoid re-evaluating in reason()
			(ctx as any)._policyCheckResult = result;
			return !result.allowed;
		},
		reason: async (ctx) => {
			const result =
				(ctx as any)._policyCheckResult ?? (await checkPolicy(ctx));
			return result.reason ?? "Action blocked by enterprise policy";
		},
	},
	{
		id: "mcp-destructive-tool",
		description: "MCP tools marked as destructive require approval",
		match: (ctx) => {
			if (!isMcpTool(ctx.toolName)) return false;
			const annotations = getAnnotations(ctx);
			// Require approval if destructiveHint is true and readOnlyHint is not true
			return (
				annotations?.destructiveHint === true && !annotations?.readOnlyHint
			);
		},
		reason: (ctx) =>
			`MCP tool "${ctx.toolName}" is marked as destructive and requires approval`,
	},
	{
		id: "plan-mode-confirm",
		description:
			"When plan mode is enabled, require approval before mutating commands",
		match: (ctx) => {
			if (process.env.COMPOSER_PLAN_MODE !== "1") return false;
			const name = ctx.toolName;
			if (name === "write" || name === "edit" || name === "bash") return true;
			if (name === "todo") return true;
			if (name === "batch") return true;
			if (name === "gh_pr") {
				const action = getStringArg(ctx, "action");
				return !action || !["list", "view", "checks", "diff"].includes(action);
			}
			if (name === "gh_issue") {
				const action = getStringArg(ctx, "action");
				return !action || !["list", "view"].includes(action);
			}
			if (name === "background_tasks") {
				const args = getArgsObject(ctx);
				const action = args?.action;
				const shell = args?.shell === true;
				return action === "start" && shell;
			}
			return false;
		},
		reason: (ctx) =>
			`Plan mode requires confirmation before executing ${ctx.toolName}. Toggle with /plan-mode or COMPOSER_PLAN_MODE=0.`,
	},
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
	{
		id: HUMAN_EGRESS_PII_RULE_ID,
		description: "PII must be redacted before human-facing tools execute",
		match: (ctx) => {
			if (!isHumanFacingTool(ctx.toolName)) {
				return false;
			}
			const pending = getPendingUnredactedPii(ctx);
			return pending.length > 0;
		},
		reason: (ctx) => {
			const pending = getPendingUnredactedPii(ctx);
			const offenders =
				pending
					.map(
						(artifact) =>
							`${artifact.label} (artifact: ${artifact.id}, source: ${artifact.sourceToolCallId})`,
					)
					.join("; ") || "unredacted artifacts";
			return `Unredacted PII (${offenders}) detected before executing human-facing tool "${ctx.toolName}". Run your redaction tool on the listed artifacts, then retry.`;
		},
	},
];

export class ActionFirewall {
	constructor(
		private readonly rules: ActionFirewallRule[] = defaultFirewallRules,
	) {}

	async evaluate(
		context: ActionApprovalContext,
	): Promise<ActionFirewallVerdict> {
		for (const rule of this.rules) {
			if (await rule.match(context)) {
				return {
					action: "require_approval",
					ruleId: rule.id,
					reason:
						(await rule.reason?.(context)) ??
						`Action matched high-risk rule: ${rule.description}`,
				};
			}
		}
		return { action: "allow" };
	}
}

export const defaultActionFirewall = new ActionFirewall();
