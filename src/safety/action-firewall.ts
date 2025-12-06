/**
 * Action Firewall - Rule-based safety enforcement for tool execution
 *
 * The action firewall is the central decision point for tool safety. Before
 * any tool executes, it passes through the firewall which evaluates a series
 * of rules and returns a verdict: allow, require_approval, or block.
 *
 * ## Architecture
 *
 * ```
 * Tool Call → ActionFirewall.evaluate() → Rules (sequential) → Verdict
 *                      ↓                        ↓
 *              Context Object           Match + Reason + Remediation
 * ```
 *
 * ## Verdict Types
 *
 * - **allow**: Tool executes immediately without user interaction
 * - **require_approval**: User must explicitly approve before execution
 * - **block**: Tool is prevented from executing entirely (hard block)
 *
 * ## Rule Evaluation Order
 *
 * Rules are evaluated sequentially in priority order. The first matching
 * rule determines the verdict. This means:
 *
 * 1. Enterprise policy rules (hard blocks) come first
 * 2. System path protection (hard blocks) second
 * 3. Workspace containment (soft approval) third
 * 4. Dangerous command patterns (soft approval) later
 *
 * ## Caching Strategy
 *
 * Policy checks and tree-sitter analysis can be expensive. We use WeakMaps
 * keyed by the context object to cache results within a single evaluation.
 * The WeakMap ensures entries are garbage collected when the context is
 * no longer referenced.
 *
 * ## Integration Points
 *
 * The firewall integrates with:
 * - **Enterprise Policy**: Organizational restrictions on tools/paths
 * - **Workflow State**: PII tracking for egress prevention
 * - **Bash Parser**: Structured command analysis
 * - **Semantic Judge**: LLM-based intent analysis (optional, slow path)
 *
 * @module safety/action-firewall
 */

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
	analyzeCommandSafety,
	dangerousPatternDescriptions,
	dangerousPatterns,
	isParserAvailable,
	unwrapShellCommand,
} from "./bash-safety-analyzer.js";
import { checkPolicy } from "./policy.js";
import { RuleCache } from "./rule-cache.js";
import { TOOL_TAGS, looksLikeEgress } from "./workflow-state.js";

import type { SemanticJudge, SemanticJudgeContext } from "./semantic-judge.js";

const logger = createLogger("safety:action-firewall");
// Evaluate env flags lazily to honor profile overrides set after initial import.
const isStrictUntaggedEgress = () =>
	process.env.COMPOSER_FAIL_UNTAGGED_EGRESS === "1";
const isBackgroundShellBlocked = () =>
	process.env.COMPOSER_BACKGROUND_SHELL_DISABLE === "1";
const isSafeModeEnabled = () => process.env.COMPOSER_SAFE_MODE === "1";
const isProdProfile = () =>
	process.env.COMPOSER_PROFILE === "prod" ||
	process.env.COMPOSER_WEB_PROFILE === "prod";

/**
 * Policy Check Result - Cached result of enterprise policy evaluation
 */
interface PolicyCheckResult {
	allowed: boolean;
	reason?: string;
}

/**
 * Policy Check Cache - Avoids redundant policy evaluations
 *
 * The firewall evaluation flow calls match() to check if a rule applies,
 * then reason() to get the human-readable explanation. For policy checks,
 * both need the same expensive async evaluation.
 *
 * We cache the result on match() and reuse it in reason(). The WeakMap
 * key is the context object itself, ensuring:
 * 1. Each context gets its own cached result
 * 2. Cache entries are automatically garbage collected when context is freed
 * 3. No memory leaks from long-running processes
 */
const policyCheckCache = new RuleCache<
	ActionApprovalContext,
	PolicyCheckResult
>();

/**
 * Action Firewall Rule Interface
 *
 * Defines the structure of a firewall rule. Rules are the building blocks
 * of the firewall; each rule checks for a specific condition and returns
 * a verdict if matched.
 *
 * ## Rule Anatomy
 *
 * - **id**: Unique identifier for logging and debugging
 * - **description**: Human-readable explanation of what the rule checks
 * - **action**: What happens if rule matches (default: require_approval)
 * - **match()**: Predicate that returns true if rule applies
 * - **reason()**: Optional function returning why rule matched
 * - **remediation()**: Optional function suggesting how to fix the issue
 *
 * ## Match Evaluation
 *
 * The match function receives the full tool context including:
 * - toolName: Name of the tool being called
 * - args: Arguments passed to the tool
 * - metadata: Additional context (workflow state, annotations)
 * - user/session: Authentication context
 *
 * Rules can be sync or async. Async rules are awaited during evaluation.
 */
type RuleOutcome = { allowed: boolean; reason?: string; remediation?: string };

export interface ActionFirewallRule {
	/** Optional legacy identifier used in existing logs/tests */
	id?: string;
	/** Optional name for logging */
	name?: string;
	/** Human-readable description */
	description: string;
	/** Verdict override */
	action?: "allow" | "require_approval" | "block";
	/** Modern evaluation hook (preferred) */
	evaluate?: (
		context: ActionApprovalContext,
	) => RuleOutcome | Promise<RuleOutcome>;
	/** Optional remediation helper */
	remediation?: (context: ActionApprovalContext) => string | Promise<string>;
	/** Legacy match/reason hooks kept for backward compatibility */
	match?: (context: ActionApprovalContext) => boolean | Promise<boolean>;
	reason?: (context: ActionApprovalContext) => string | Promise<string>;
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
 * Generate rules from dangerous patterns (regex-based)
 */
const dangerousCommandRules: ActionFirewallRule[] = Object.entries(
	dangerousPatterns,
).map(([key, pattern]) => ({
	name: `command-${key}`,
	description:
		dangerousPatternDescriptions[
			key as keyof typeof dangerousPatternDescriptions
		],
	action: "require_approval",
	evaluate: (ctx) => {
		const command = getCommandArg(ctx);
		if (!command || !pattern.test(command)) {
			return { allowed: true };
		}
		return {
			allowed: false,
			reason: `Detected ${dangerousPatternDescriptions[key as keyof typeof dangerousPatternDescriptions]}: ${command.trim()}`,
		};
	},
}));

const isBashStrict = () => process.env.COMPOSER_BASH_STRICT === "1";
const isBashGuardEnabled = () => {
	const flag = process.env.COMPOSER_BASH_GUARD?.toLowerCase?.();
	if (flag) {
		return !["0", "off", "false", "disabled", "no"].includes(flag);
	}
	// Default: guard ON (previous behavior). Explicitly set COMPOSER_BASH_GUARD=0 to YOLO.
	if (isSafeModeEnabled() || isProdProfile()) {
		return true;
	}
	return true;
};

function hasRiskyBashSyntax(command: string): boolean {
	return (
		/[|;&`]/.test(command) ||
		/>>|<</.test(command) ||
		/[<>]/.test(command) ||
		/[()]/.test(command) ||
		hasUnquotedBraces(command) ||
		/\$[A-Za-z_0-9{@*?!$-]/.test(command) ||
		/\$\(/.test(command) ||
		/[\n\r\t]/.test(command)
	);
}

function hasUnquotedBraces(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
		} else if (!inSingle && !inDouble && (ch === "{" || ch === "}")) {
			return true;
		}
	}
	return false;
}

// Minimal tokenization that respects simple quoted segments; not a full shell parser.
function tokenizeSimple(command: string): string[] {
	return (
		command
			.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g)
			?.filter(Boolean) ?? []
	);
}

function isDestructiveSimpleCommand(tokens: string[]): boolean {
	const rawProgram = tokens[0] ?? "";
	const stripped = rawProgram
		.replace(/^["'\\]+/, "")
		.replace(/["'\\]+$/, "")
		.trim();
	const firstWord = stripped.split(/\s+/)[0]?.replace(/["']/g, "") ?? stripped;
	const program =
		firstWord.replace(/\\+/g, "/").split("/").pop() || firstWord || rawProgram;
	if (!program) return false;
	if (/\$[A-Za-z_0-9{@*?!$-]/.test(program)) {
		return true;
	}
	if (["exec", "eval"].includes(program)) {
		return true;
	}
	if (
		[
			"sudo",
			"rm",
			"rmdir",
			"shred",
			"fdisk",
			"parted",
			"source",
			".",
			"xargs",
			"find",
			"perl",
			"python",
			"python3",
			"ruby",
			"lua",
			"wget",
			"curl",
			"tar",
			"zip",
			"unzip",
			"chmod",
			"chown",
			"dd",
			"mkfs",
			"shutdown",
			"reboot",
			"halt",
			"poweroff",
			"init",
			"kill",
			"killall",
			"pkill",
			"systemctl",
			"service",
		].includes(program)
	) {
		return true;
	}
	if (tokens.some((t) => t.includes("${"))) {
		return true;
	}
	if (program === "git") {
		let sub: string | undefined;
		for (let i = 1; i < tokens.length; i += 1) {
			const token = tokens[i];
			// git flags that take a value; skip the following token as well
			const flagConsumesNext =
				token === "-C" ||
				token === "--work-tree" ||
				token === "--git-dir" ||
				token === "-c" ||
				token === "--namespace";
			if (flagConsumesNext) {
				i += 1;
				// If the consumed value starts a quoted string, skip until the closing quote
				if (
					i < tokens.length &&
					/^["']/.test(tokens[i]) &&
					!/["']$/.test(tokens[i])
				) {
					while (i + 1 < tokens.length && !/["']$/.test(tokens[i])) {
						i += 1;
					}
				}
				continue;
			}
			if (token.startsWith("-")) {
				if (token.includes("=")) {
					const parts = token.split("=", 2);
					const maybeSub = parts[1];
					if (
						maybeSub &&
						!maybeSub.startsWith("-") &&
						[
							"push",
							"reset",
							"clean",
							"rebase",
							"merge",
							"cherry-pick",
							"rm",
						].includes(maybeSub)
					) {
						return true;
					}
				}
				continue;
			}
			if (!sub) {
				sub = token;
			}
		}
		if (
			sub &&
			[
				"push",
				"reset",
				"clean",
				"rebase",
				"merge",
				"cherry-pick",
				"rm",
			].includes(sub)
		) {
			return true;
		}
	}
	return false;
}

function isSimpleBenignBash(command: string): boolean {
	if (hasRiskyBashSyntax(command)) {
		return false;
	}
	const tokens = tokenizeSimple(command);
	if (tokens.length === 0) return true;
	// Skip leading env assignments (VAR=value)
	let idx = 0;
	while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
		idx += 1;
	}
	const withoutEnv = tokens.slice(idx);
	if (withoutEnv.length === 0) return true;
	const normalizeProgram = (tok: string) =>
		tok
			.replace(/\\+/g, "/")
			.replace(/^["'\\]+/, "")
			.replace(/["'\\]+$/, "")
			.split("/")
			.pop() || tok;
	const first = normalizeProgram(withoutEnv[0]);
	const wrapperCommands = [
		"env",
		"nice",
		"nohup",
		"time",
		"timeout",
		"command",
	];
	// Wrapper commands that execute another program
	if (wrapperCommands.includes(first)) {
		if (withoutEnv.length === 1) return true; // nothing to run
		let inner = withoutEnv.slice(1);
		while (
			inner.length > 0 &&
			wrapperCommands.includes(normalizeProgram(inner[0]))
		) {
			inner = inner.slice(1);
		}
		const flagConsumesNext = (flag: string) =>
			[
				"-u",
				"-S",
				"--split-string",
				"-C",
				"--chdir",
				"--cwd",
				"-n",
				"--adjustment",
				"-s",
				"--signal",
				"-k",
				"--kill-after",
				"--pid",
			].includes(flag);
		while (inner.length > 0) {
			const head = inner[0];
			// numeric arguments like `timeout 10 cmd` or `nice 5 cmd`
			if (/^\d+$/.test(head) && inner.length > 1) {
				inner = inner.slice(1);
				continue;
			}
			if (head.startsWith("-")) {
				// Assume flags consume the next argument if present
				if (flagConsumesNext(head) && inner.length > 1) {
					inner = inner.slice(2);
					continue;
				}
				inner = inner.slice(1);
				continue;
			}
			break;
		}
		return !isDestructiveSimpleCommand(inner);
	}
	return !isDestructiveSimpleCommand(withoutEnv);
}

/**
 * Tree-sitter based command safety rule.
 * Provides more accurate analysis than regex patterns.
 */
const treeSitterCommandRule: ActionFirewallRule = {
	name: "command-treesitter-analysis",
	description: "Tree-sitter based command safety analysis",
	action: "require_approval",
	evaluate: (ctx) => {
		if (!isBashGuardEnabled()) {
			return { allowed: true };
		}
		if (ctx.toolName !== "bash" && !isBackgroundTaskShellStart(ctx)) {
			return { allowed: true };
		}
		let command = getCommandArg(ctx);
		if (!command) return { allowed: true };

		// Try to unwrap bash -c "..." style commands
		const unwrapped = unwrapShellCommand(command);
		if (unwrapped) {
			command = unwrapped;
		}

		const simpleTokens = tokenizeSimple(command);
		if (isDestructiveSimpleCommand(simpleTokens)) {
			return {
				allowed: false,
				reason:
					"Command requires approval (destructive or mutating operation detected)",
			};
		}

		if (!isBashStrict() && isSimpleBenignBash(command)) {
			return { allowed: true };
		}

		// Only run tree-sitter if the parser is available; otherwise fall back to approval
		if (!isParserAvailable()) {
			return {
				allowed: false,
				reason:
					"Command requires approval (bash parser unavailable; unable to fully analyze)",
			};
		}

		const analysis = analyzeCommandSafety(command);
		if (analysis.safe) {
			return { allowed: true };
		}
		return {
			allowed: false,
			reason: analysis.reason ?? "Command failed tree-sitter safety analysis",
		};
	},
};

/**
 * Critical System Paths - Directories that should never be modified
 *
 * These paths are protected with a HARD BLOCK (not just approval required).
 * Modifying files in these directories can:
 * - Break the operating system
 * - Compromise system security
 * - Affect other users on the system
 *
 * ## Linux Paths
 *
 * - /etc: System configuration
 * - /usr: System programs and libraries
 * - /var: Variable data (logs, databases)
 * - /boot: Bootloader and kernel
 * - /sys, /proc: Kernel virtual filesystems
 * - /dev: Device files
 * - /bin, /sbin: Essential system binaries
 * - /lib, /lib64: Shared libraries
 * - /opt: Optional/third-party software
 *
 * ## Windows Paths
 *
 * - C:\Windows: Operating system
 * - C:\Program Files: Installed applications
 *
 * Note: /var/folders (macOS temp) and /tmp are explicitly allowed
 * through the isContainedInWorkspace check before system path blocking.
 */
const SYSTEM_PATHS = [
	// Linux system directories
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
	// Windows system directories
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
 * Workspace Containment Check - Determines if a path is in a "safe zone"
 *
 * The firewall uses containment to prevent accidental writes outside the
 * project directory. This function checks if a file path is within one of
 * the allowed zones.
 *
 * ## Safe Zones (in order of check)
 *
 * 1. **Workspace root**: Current working directory and subdirectories
 * 2. **System temp directory**: /tmp, /var/folders, etc.
 * 3. **Trusted paths**: User-configured paths in firewall.json
 *
 * ## Path Resolution Complexity
 *
 * We must handle several path edge cases:
 *
 * - **Symlinks**: macOS /tmp → /private/tmp, so we resolve real paths
 * - **Non-existent files**: Can't realpath a file being created, use logical path
 * - **Relative paths**: Convert to absolute before comparison
 * - **Path traversal**: Detect ../ escapes using relative() output
 *
 * ## Detection Method
 *
 * For each safe zone, we compute relative(zone, targetPath). If the result:
 * - Starts with ".." → path escapes the zone (unsafe)
 * - Is an absolute path → completely outside (unsafe)
 * - Otherwise → contained within zone (safe)
 *
 * @param filePath - The path to check (may be relative or absolute)
 * @returns true if path is contained in a safe zone, false otherwise
 */
function isContainedInWorkspace(filePath: string): boolean {
	// Resolve to absolute path for consistent comparison
	const resolvedPath = resolve(filePath);
	const workspaceRoot = process.cwd();
	const tempDir = tmpdir();

	// Check 1: Is path within the current working directory?
	const relToWorkspace = relative(workspaceRoot, resolvedPath);
	const isInsideWorkspace =
		!relToWorkspace.startsWith("..") && !isAbsolute(relToWorkspace);

	// Check 2: Is path within the system temp directory?
	// Handle symlinks: on macOS, /var/folders is the real path for $TMPDIR
	let resolvedTemp = tempDir;
	try {
		resolvedTemp = realpathSync(tempDir);
	} catch {
		// Keep original if realpath fails (shouldn't happen for temp dir)
	}

	// Also try to resolve the target file's real path
	let realFilePath = resolvedPath;
	try {
		realFilePath = realpathSync(resolvedPath);
	} catch {
		// File might not exist yet (creating new file), use logical path
		// This is expected and not an error
	}

	// Check both the resolved real path and the logical path
	// This handles cases where temp is symlinked
	const relToTemp = relative(resolvedTemp, realFilePath);
	const relToTempLogical = relative(tempDir, resolvedPath);

	const isInsideTemp =
		(!relToTemp.startsWith("..") && !isAbsolute(relToTemp)) ||
		(!relToTempLogical.startsWith("..") && !isAbsolute(relToTempLogical));

	if (isInsideWorkspace || isInsideTemp) {
		return true;
	}

	// Check 3: Is path within a user-configured trusted path?
	// Users can add paths to ~/.composer/firewall.json containment.trustedPaths
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

	// Path is outside all safe zones
	return false;
}

export const defaultFirewallRules: ActionFirewallRule[] = [
	{
		name: "enterprise-policy",
		description: "Enforce enterprise policies on tools and dependencies",
		action: "block", // HARD BLOCK for policy violations
		evaluate: async (ctx) => {
			const cached = policyCheckCache.get(ctx);
			if (cached) {
				return cached.allowed
					? { allowed: true }
					: {
							allowed: false,
							reason: cached.reason ?? "Action blocked by enterprise policy",
						};
			}
			const result = await checkPolicy(ctx);
			policyCheckCache.set(ctx, result);
			if (result.allowed) return { allowed: true };
			return {
				allowed: false,
				reason: result.reason ?? "Action blocked by enterprise policy",
			};
		},
	},
	{
		name: "system-path-protection",
		description: "Prevent modification of critical system directories",
		action: "block", // HARD BLOCK for system paths
		evaluate: (ctx) => {
			// Only check file mutation tools
			if (
				!["write", "edit", "delete_file", "move_file", "copy_file"].includes(
					ctx.toolName,
				)
			) {
				return { allowed: true };
			}
			const paths = extractFilePaths(ctx);
			// We check system paths first, but if it's in temp (safe), we should allow it.
			// System paths like /var include /var/folders (temp on mac), so we need to exclude safe temp paths from system path blocking
			// if they are legitimately inside the temp dir.

			// Filter out paths that are inside the temp directory (which is safe)
			const unsafePaths = paths.filter((p) => !isContainedInWorkspace(p));

			// Only check remaining paths against system blocklist
			if (unsafePaths.some(isSystemPath)) {
				return {
					allowed: false,
					reason:
						"Modification of critical system directories is blocked for safety.",
				};
			}
			return { allowed: true };
		},
		remediation: () =>
			"Do not modify critical system paths. If you need to write a file, use the current workspace directory or a temporary folder.",
	},
	{
		name: "workspace-containment",
		description:
			"Require approval for file modifications outside the workspace",
		action: "require_approval",
		evaluate: (ctx) => {
			// Only check file mutation tools
			if (
				!["write", "edit", "delete_file", "move_file", "copy_file"].includes(
					ctx.toolName,
				)
			) {
				return { allowed: true };
			}
			const paths = extractFilePaths(ctx);
			// Return true (match rule) if ANY path is NOT contained
			const outsidePaths = paths.filter((p) => !isContainedInWorkspace(p));
			if (outsidePaths.length === 0) return { allowed: true };
			return {
				allowed: false,
				reason: `File modification outside workspace detected: ${outsidePaths.join(", ")}. This requires explicit approval.`,
			};
		},
		remediation: () =>
			"The file path is outside the allowed workspace. Please use a path within the current project or a temporary directory, or ask the user to add this path to 'containment.trustedPaths' in ~/.composer/firewall.json.",
	},
	{
		id: "untagged-human-egress",
		description:
			"Block human-facing tool calls without explicit TOOL_TAGS annotations when strict mode is enabled",
		action: "block",
		match: (ctx) => {
			if (!isStrictUntaggedEgress()) {
				return false;
			}
			if (!isHumanFacingTool(ctx.toolName)) {
				return false;
			}
			return TOOL_TAGS[ctx.toolName] === undefined;
		},
		reason: () =>
			"Human-facing tool is missing TOOL_TAGS; annotate the tool or disable strict mode via COMPOSER_FAIL_UNTAGGED_EGRESS=0.",
		remediation: () =>
			"Add TOOL_TAGS entry marking egress intent (human/http) before invoking the tool.",
	},
	{
		id: "background-shell-block",
		description: "Block shell-based background tasks when disabled by policy",
		action: "block",
		match: (ctx) =>
			isBackgroundShellBlocked() && isBackgroundTaskShellStart(ctx) === true,
		reason: () =>
			"Starting background_tasks with shell=true is disabled by policy. Set COMPOSER_BACKGROUND_SHELL_DISABLE=0 to allow.",
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
	treeSitterCommandRule,
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
			const evaluation: RuleOutcome = rule.evaluate
				? await rule.evaluate(context)
				: (await rule.match?.(context))
					? {
							allowed: false,
							reason:
								(await rule.reason?.(context)) ??
								`Action matched rule: ${rule.description}`,
						}
					: { allowed: true };

			if (!evaluation.allowed) {
				const action = rule.action ?? "require_approval";
				const reason =
					evaluation.reason ??
					`Action matched rule: ${rule.description ?? rule.name}`;
				const remediation =
					evaluation.remediation ?? (await rule.remediation?.(context));
				const ruleId =
					(rule as { id?: string }).id ?? rule.name ?? "unknown-rule";

				if (action === "allow") {
					return { action: "allow" };
				}

				if (action === "block") {
					return {
						action,
						ruleId,
						reason,
						remediation,
					};
				}

				return {
					action,
					ruleId,
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
