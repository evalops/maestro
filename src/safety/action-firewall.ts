import type {
	ActionApprovalContext,
	ActionFirewallVerdict,
	WorkflowStateSnapshot,
} from "../agent/action-approval.js";
export type { ActionApprovalContext } from "../agent/action-approval.js";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getFirewallConfig } from "../config/firewall-config.js";
import { createLogger } from "../utils/logger.js";
import {
	dangerousPatternDescriptions,
	dangerousPatterns,
} from "./dangerous-patterns.js";
import { checkPolicy } from "./policy.js";
import { TOOL_TAGS, looksLikeEgress } from "./workflow-state.js";

import type { SemanticJudge, SemanticJudgeContext } from "./semantic-judge.js";

const logger = createLogger("safety:action-firewall");

// Type for policy check result caching
interface PolicyCheckResult {
	allowed: boolean;
	reason?: string;
}

// WeakMap for caching policy check results per context object.
// This cache relies on match() being called before reason() for the same context,
// which is guaranteed by the firewall evaluation flow in evaluateFirewall().
// WeakMap ensures entries are garbage collected when context is no longer referenced.
const policyCheckCache = new WeakMap<
	ActionApprovalContext,
	PolicyCheckResult
>();

export interface ActionFirewallRule {
	id: string;
	description: string;
	action?: "allow" | "require_approval" | "block";
	match: (context: ActionApprovalContext) => boolean | Promise<boolean>;
	reason?: (context: ActionApprovalContext) => string | Promise<string>;
	remediation?: (context: ActionApprovalContext) => string | Promise<string>;
}

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

/**
 * Generate rules from dangerous patterns
 */
const dangerousCommandRules: ActionFirewallRule[] = Object.entries(
	dangerousPatterns,
).map(([key, pattern]) => ({
	id: `command-${key}`,
	description:
		dangerousPatternDescriptions[
			key as keyof typeof dangerousPatternDescriptions
		],
	// rmRf is high risk, keep as require_approval (or block if we want to be stricter)
	// For now, require_approval is standard for dangerous commands unless policy blocks them.
	action: "require_approval",
	match: (ctx) => {
		const command = getCommandArg(ctx);
		return !!command && pattern.test(command);
	},
	reason: (ctx) => {
		const command = getCommandArg(ctx) ?? "";
		return `Detected ${dangerousPatternDescriptions[key as keyof typeof dangerousPatternDescriptions]}: ${command.trim()}`;
	},
}));

/**
 * Critical system paths to protect
 */
const SYSTEM_PATHS = [
	"/etc",
	"/usr",
	"/var",
	"/boot",
	"/sys",
	"/proc",
	"/dev",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/opt",
	// Windows
	"C:\\Windows",
	"C:\\Program Files",
	"C:\\Program Files (x86)",
];

function isSystemPath(filePath: string): boolean {
	const normalized = resolve(filePath);
	return SYSTEM_PATHS.some((sysPath) => {
		// Exact match or subdirectory
		return (
			normalized === sysPath ||
			normalized.startsWith(`${sysPath}/`) ||
			normalized.startsWith(`${sysPath}\\`)
		);
	});
}

function extractFilePaths(context: ActionApprovalContext): string[] {
	const args = getArgsObject(context);
	if (!args) return [];
	const paths: string[] = [];

	// Simple extraction for standard file tools
	// Note: deeper extraction is done in policy.ts, this is for quick system protection
	if (context.toolName === "write" || context.toolName === "edit") {
		const p =
			getStringArg(context, "file_path") || getStringArg(context, "path");
		if (p) paths.push(p);
	}
	if (context.toolName === "delete_file") {
		const p =
			getStringArg(context, "file_path") ||
			getStringArg(context, "target_file");
		if (p) paths.push(p);
	}
	return paths;
}

/**
 * Check if a path is inside the current workspace or temporary directory.
 * Returns true if the path is contained (safe), false if it escapes.
 */
function isContainedInWorkspace(filePath: string): boolean {
	const resolvedPath = resolve(filePath);
	const workspaceRoot = process.cwd();
	const tempDir = tmpdir();

	// Check if path is within workspace root
	const relToWorkspace = relative(workspaceRoot, resolvedPath);
	const isInsideWorkspace =
		!relToWorkspace.startsWith("..") && !isAbsolute(relToWorkspace);

	// Check if path is within temp dir
	// Resolve symlinks for temp dir (macOS /var vs /private/var)
	let resolvedTemp = tempDir;
	try {
		resolvedTemp = realpathSync(tempDir);
	} catch {
		// keep original if realpath fails
	}
	// Also check realpath of file path
	let realFilePath = resolvedPath;
	try {
		realFilePath = realpathSync(resolvedPath);
	} catch {
		// File might not exist yet (writing new file), so checking realpath might fail
		// In that case we rely on the logical path
	}

	const relToTemp = relative(resolvedTemp, realFilePath);
	// On macOS, temp dir might be symlinked. We check both logical and physical paths.
	const relToTempLogical = relative(tempDir, resolvedPath);

	const isInsideTemp =
		(!relToTemp.startsWith("..") && !isAbsolute(relToTemp)) ||
		(!relToTempLogical.startsWith("..") && !isAbsolute(relToTempLogical));

	if (isInsideWorkspace || isInsideTemp) {
		return true;
	}

	// Check trusted paths from config
	const config = getFirewallConfig();
	if (config.containment?.trustedPaths) {
		for (const trustedPath of config.containment.trustedPaths) {
			const resolvedTrusted = resolve(trustedPath);
			const relToTrusted = relative(resolvedTrusted, resolvedPath);
			if (!relToTrusted.startsWith("..") && !isAbsolute(relToTrusted)) {
				return true;
			}
		}
	}

	return false;
}

export const defaultFirewallRules: ActionFirewallRule[] = [
	{
		id: "enterprise-policy",
		description: "Enforce enterprise policies on tools and dependencies",
		action: "block", // HARD BLOCK for policy violations
		match: async (ctx) => {
			const result = await checkPolicy(ctx);
			// Cache result to avoid re-evaluating in reason()
			policyCheckCache.set(ctx, result);
			return !result.allowed;
		},
		reason: async (ctx) => {
			const cached = policyCheckCache.get(ctx);
			const result = cached ?? (await checkPolicy(ctx));
			return result.reason ?? "Action blocked by enterprise policy";
		},
	},
	{
		id: "system-path-protection",
		description: "Prevent modification of critical system directories",
		action: "block", // HARD BLOCK for system paths
		match: (ctx) => {
			// Only check file mutation tools
			if (
				!["write", "edit", "delete_file", "move_file", "copy_file"].includes(
					ctx.toolName,
				)
			) {
				return false;
			}
			const paths = extractFilePaths(ctx);
			// We check system paths first, but if it's in temp (safe), we should allow it.
			// System paths like /var include /var/folders (temp on mac), so we need to exclude safe temp paths from system path blocking
			// if they are legitimately inside the temp dir.

			// Filter out paths that are inside the temp directory (which is safe)
			const unsafePaths = paths.filter((p) => !isContainedInWorkspace(p));

			// Only check remaining paths against system blocklist
			return unsafePaths.some(isSystemPath);
		},
		reason: (ctx) =>
			"Modification of critical system directories is blocked for safety.",
		remediation: () =>
			"Do not modify critical system paths. If you need to write a file, use the current workspace directory or a temporary folder.",
	},
	{
		id: "workspace-containment",
		description:
			"Require approval for file modifications outside the workspace",
		action: "require_approval",
		match: (ctx) => {
			// Only check file mutation tools
			if (
				!["write", "edit", "delete_file", "move_file", "copy_file"].includes(
					ctx.toolName,
				)
			) {
				return false;
			}
			const paths = extractFilePaths(ctx);
			// Return true (match rule) if ANY path is NOT contained
			return paths.some((p) => !isContainedInWorkspace(p));
		},
		reason: (ctx) => {
			const paths = extractFilePaths(ctx);
			const outsidePaths = paths.filter((p) => !isContainedInWorkspace(p));
			return `File modification outside workspace detected: ${outsidePaths.join(", ")}. This requires explicit approval.`;
		},
		remediation: () =>
			"The file path is outside the allowed workspace. Please use a path within the current project or a temporary directory, or ask the user to add this path to 'containment.trustedPaths' in ~/.composer/firewall.json.",
	},
	{
		id: "mcp-destructive-tool",
		description: "MCP tools marked as destructive require approval",
		action: "require_approval",
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
		action: "require_approval",
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
	...dangerousCommandRules,
	{
		id: "background-shell-mode",
		description: "Shell mode background tasks",
		action: "require_approval",
		match: (ctx) => isBackgroundTaskShellStart(ctx),
		reason: () =>
			"Background task shell mode requires manual approval (pipes, redirects, and globbing are high risk)",
	},
	{
		id: HUMAN_EGRESS_PII_RULE_ID,
		description: "PII must be redacted before human-facing tools execute",
		action: "require_approval",
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
	private semanticJudge?: SemanticJudge;

	constructor(
		private readonly rules: ActionFirewallRule[] = defaultFirewallRules,
	) {}

	setSemanticJudge(judge: SemanticJudge) {
		this.semanticJudge = judge;
	}

	async evaluate(
		context: ActionApprovalContext,
	): Promise<ActionFirewallVerdict> {
		for (const rule of this.rules) {
			if (await rule.match(context)) {
				const action = rule.action ?? "require_approval";
				const reason =
					(await rule.reason?.(context)) ??
					`Action matched rule: ${rule.description}`;
				const remediation = await rule.remediation?.(context);

				if (action === "allow") {
					return { action: "allow" };
				}

				if (action === "block") {
					return {
						action,
						ruleId: rule.id,
						reason,
						remediation,
					};
				}

				return {
					action,
					ruleId: rule.id,
					reason,
				};
			}
		}

		// 2. Run semantic judge if available (slow path)
		if (this.semanticJudge && context.userIntent) {
			const SENSITIVE_TOOLS = [
				"bash",
				"write",
				"edit",
				"delete_file",
				"background_tasks",
			];
			if (SENSITIVE_TOOLS.includes(context.toolName)) {
				const judgment = await this.semanticJudge.evaluate({
					userIntent: context.userIntent,
					toolName: context.toolName,
					toolArgs: context.args,
				});

				if (!judgment.safe) {
					return {
						action: "require_approval",
						ruleId: "semantic-judge",
						reason: judgment.reason,
					};
				}
			}
		}

		return { action: "allow" };
	}
}

export const defaultActionFirewall = new ActionFirewall();
