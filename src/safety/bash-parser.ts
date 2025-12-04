/**
 * Bash Command Parser - Tree-sitter based shell command analysis for safety
 *
 * This module provides structured parsing of shell commands using tree-sitter,
 * enabling accurate detection of dangerous patterns that regex-based approaches
 * often miss or incorrectly flag.
 *
 * ## Why Tree-Sitter?
 *
 * Regex-based command detection is fundamentally limited:
 * - `rm -rf /` is dangerous, but `echo "rm -rf /"` is not
 * - `git push --force` is dangerous, but only in certain contexts
 * - Command substitution `$(...)` can hide dangerous commands
 *
 * Tree-sitter produces a proper AST, letting us:
 * - Distinguish command names from arguments and strings
 * - Detect pipes, redirects, and subshells structurally
 * - Unwrap shell wrappers (`bash -c "..."`) for inner analysis
 *
 * ## Lazy Initialization
 *
 * Tree-sitter requires native bindings that may not be available:
 * - Development: Usually available via npm install
 * - Production: May be stripped in minimal deployments
 * - CI/CD: May not have build tools for native compilation
 *
 * We use lazy initialization with graceful fallback:
 * 1. Try to load native modules on first use
 * 2. Cache the result (available or not)
 * 3. Fall back to regex-based checks if unavailable
 *
 * ## Parse Result Structure
 *
 * ```typescript
 * {
 *   success: true,
 *   commands: [{ program: "rm", args: ["-rf", "/tmp/foo"], raw: "rm -rf /tmp/foo" }],
 *   hasPipes: false,
 *   hasRedirects: true,
 *   hasSubshell: false,
 *   hasBackgroundJob: false,
 *   hasCommandSubstitution: false
 * }
 * ```
 *
 * @module safety/bash-parser
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:bash-parser");

// Dynamic import types - tree-sitter is loaded at runtime to handle missing bindings
type ParserType = InstanceType<typeof import("tree-sitter")>;
type SyntaxNode = import("tree-sitter").SyntaxNode;

/**
 * Parser State - Lazy initialization with singleton pattern
 *
 * We use three variables to track initialization state:
 * - parser: The tree-sitter parser instance (null if not available)
 * - parserInitialized: Whether we've attempted initialization
 * - parserAvailable: Whether initialization succeeded
 *
 * This pattern ensures we only try to load native modules once,
 * even if multiple code paths check for parser availability.
 */
let parser: ParserType | null = null;
let parserInitialized = false;
let parserAvailable = false;

/**
 * Initialize Tree-Sitter Parser
 *
 * Attempts to load tree-sitter and the bash grammar. This is async because
 * dynamic imports are promises, and we want to handle errors gracefully.
 *
 * ## Initialization Steps
 *
 * 1. Check if already initialized (return cached result)
 * 2. Dynamically import tree-sitter and tree-sitter-bash
 * 3. Create parser instance and set language
 * 4. Cache result for future calls
 *
 * ## Error Handling
 *
 * If native modules aren't available, we log a warning and set
 * parserAvailable=false. All subsequent parsing attempts will
 * return {success: false} and callers should fall back to regex.
 *
 * @returns Promise resolving to whether parser is available
 */
async function initParser(): Promise<boolean> {
	// Already initialized - return cached result
	if (parserInitialized) return parserAvailable;
	parserInitialized = true;

	try {
		// Dynamic imports for native modules - may fail if bindings missing
		const [Parser, BashLanguage] = await Promise.all([
			import("tree-sitter").then((m) => m.default),
			import("tree-sitter-bash").then((m) => m.default),
		]);
		parser = new Parser();
		// Type cast needed because tree-sitter-bash types don't perfectly align
		parser.setLanguage(
			BashLanguage as unknown as import("tree-sitter").Language,
		);
		parserAvailable = true;
		logger.debug("Tree-sitter bash parser initialized successfully");
	} catch (error) {
		// Graceful degradation - parser features will be disabled
		logger.warn(
			"Tree-sitter bash parser not available (native bindings missing)",
			{
				error: error instanceof Error ? error.message : String(error),
			},
		);
		parserAvailable = false;
	}
	return parserAvailable;
}

// Kick off initialization eagerly but don't block module loading
// This way the parser may be ready by the time we need it
initParser().catch((err) => {
	logger.debug("Parser initialization failed", {
		error: err instanceof Error ? err.message : String(err),
	});
});

/**
 * Ensure the parser is ready. Call this before using parser functions in tests.
 * Returns true if parser is available, false otherwise.
 */
export async function ensureParserReady(): Promise<boolean> {
	return initParser();
}

/**
 * Check if the parser is available (for sync checks).
 */
export function isParserAvailable(): boolean {
	return parserAvailable;
}

export interface ParsedCommand {
	program: string;
	args: string[];
	raw: string;
}

export interface BashParseResult {
	success: boolean;
	commands: ParsedCommand[];
	hasPipes: boolean;
	hasRedirects: boolean;
	hasSubshell: boolean;
	hasBackgroundJob: boolean;
	hasCommandSubstitution: boolean;
	error?: string;
}

/**
 * Safe Command Allowlist - Read-only commands that don't modify system state
 *
 * These commands are considered safe for autonomous execution without approval
 * because they only read data, never write. This enables the agent to explore
 * the filesystem and gather information freely.
 *
 * ## Criteria for inclusion
 *
 * 1. Command is purely read-only by default
 * 2. No common flags that enable writing (or we check for them separately)
 * 3. Cannot be used to exfiltrate sensitive data in dangerous ways
 *
 * ## Notable edge cases
 *
 * - `sed`: Listed here because it's read-only without -i flag. We check for
 *   -i separately in analyzeCommandSafety().
 * - `tee`: Can write to files, but primarily used for reading in pipelines.
 *   Included because blocking it breaks common patterns.
 * - `xargs`: Executes other commands, but the executed command is analyzed.
 */
const SAFE_COMMANDS = new Set([
	// File reading
	"cat",
	"head",
	"tail",
	"less",
	"more",
	// Search and filtering
	"grep",
	"rg",
	"find",
	// Directory listing
	"ls",
	"pwd",
	"tree",
	// Output formatting
	"echo",
	"printf",
	// Text processing (read-only)
	"wc",
	"sort",
	"uniq",
	"diff",
	"cut",
	"tr",
	"awk",
	"sed", // read-only when not using -i
	// File metadata
	"file",
	"stat",
	"du",
	"df",
	// Command lookup
	"which",
	"whereis",
	"type",
	// Documentation
	"man",
	"help",
	// System info
	"date",
	"cal",
	"whoami",
	"id",
	"groups",
	"hostname",
	"uname",
	"env",
	"printenv",
	// Modern tools
	"bat",
	"jq",
	"yq",
	// Pipeline utilities
	"tee",
	"xargs",
]);

/**
 * Safe Git Subcommands - Read-only git operations
 *
 * These git subcommands don't modify repository state and are safe for
 * autonomous execution. The agent can freely explore git history.
 */
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status", // Working tree status
	"log", // Commit history
	"diff", // Changes between commits/trees
	"show", // Show objects
	"branch", // List branches (without -d/-D)
	"tag", // List tags (without -d)
	"remote", // List remotes
	"config", // Read config values
	"describe", // Find tag/commit description
	"rev-parse", // Parse revision specifications
	"ls-files", // List tracked files
	"ls-tree", // List tree contents
	"blame", // Show line-by-line authorship
	"shortlog", // Summarize log output
	"reflog", // Reference logs
	"stash", // When just listing (stash list)
]);

/**
 * Dangerous Git Subcommands - Operations that modify repository state
 *
 * These require approval because they can lose work or affect remote state.
 */
const DANGEROUS_GIT_SUBCOMMANDS = new Set([
	"reset", // Can lose uncommitted changes
	"clean", // Removes untracked files
	"rm", // Removes files from working tree
	"push", // Modifies remote repository
	"rebase", // Rewrites history
	"merge", // Creates merge commits
	"cherry-pick", // Applies commits
]);

/**
 * Dangerous Commands - Operations that should always require approval
 *
 * These commands can cause data loss, system damage, or security issues.
 * They require explicit user approval before execution.
 *
 * ## Categories
 *
 * - **Destructive**: rm, rmdir, shred - delete files/directories
 * - **Disk operations**: mkfs, dd, fdisk, parted, format - modify disks
 * - **Permissions**: chmod, chown - modify file access controls
 * - **Process control**: kill, killall, pkill - terminate processes
 * - **System control**: reboot, shutdown, halt, poweroff, init - system state
 * - **Service management**: systemctl, service - modify running services
 */
const DANGEROUS_COMMANDS = new Set([
	// Destructive file operations
	"rm",
	"rmdir",
	"shred",
	// Low-level disk operations
	"mkfs",
	"dd",
	"fdisk",
	"parted",
	"format",
	// Permission modifications
	"chmod",
	"chown",
	// Process termination
	"kill",
	"killall",
	"pkill",
	// System control
	"reboot",
	"shutdown",
	"halt",
	"poweroff",
	"init",
	"systemctl",
	"service",
]);

/**
 * Parse a bash command string into structured components.
 * Returns a result indicating parser unavailability if tree-sitter isn't loaded.
 */
export function parseBashCommand(command: string): BashParseResult {
	if (!parser || !parserAvailable) {
		return {
			success: false,
			commands: [],
			hasPipes: false,
			hasRedirects: false,
			hasSubshell: false,
			hasBackgroundJob: false,
			hasCommandSubstitution: false,
			error: "Parser not available",
		};
	}

	try {
		const tree = parser.parse(command);
		const root = tree.rootNode;

		if (root.hasError) {
			return {
				success: false,
				commands: [],
				hasPipes: false,
				hasRedirects: false,
				hasSubshell: false,
				hasBackgroundJob: false,
				hasCommandSubstitution: false,
				error: "Parse error in command",
			};
		}

		const result: BashParseResult = {
			success: true,
			commands: [],
			hasPipes: false,
			hasRedirects: false,
			hasSubshell: false,
			hasBackgroundJob: false,
			hasCommandSubstitution: false,
		};

		// Walk the tree to extract information
		// Using 'any' here since the SyntaxNode type comes from dynamic import
		const walk = (node: SyntaxNode) => {
			switch (node.type) {
				case "pipeline":
					result.hasPipes = true;
					break;
				case "redirected_statement":
				case "file_redirect":
				case "heredoc_redirect":
					result.hasRedirects = true;
					break;
				case "subshell":
					result.hasSubshell = true;
					break;
				case "command_substitution":
					result.hasCommandSubstitution = true;
					break;
				case "command": {
					const parsed = extractCommand(node, command);
					if (parsed) {
						result.commands.push(parsed);
					}
					break;
				}
			}

			// Check for background job (&)
			if (node.type === "list" && command.includes("&")) {
				result.hasBackgroundJob = true;
			}

			for (const child of node.children) {
				walk(child);
			}
		};

		walk(root);
		return result;
	} catch (error) {
		return {
			success: false,
			commands: [],
			hasPipes: false,
			hasRedirects: false,
			hasSubshell: false,
			hasBackgroundJob: false,
			hasCommandSubstitution: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Extract command name and arguments from a command node.
 */
function extractCommand(
	node: SyntaxNode,
	source: string,
): ParsedCommand | null {
	const nameNode = node.childForFieldName("name");
	if (!nameNode) return null;

	const program = source.slice(nameNode.startIndex, nameNode.endIndex);
	const args: string[] = [];

	for (const child of node.children) {
		if (
			child.type === "word" ||
			child.type === "string" ||
			child.type === "raw_string"
		) {
			if (child !== nameNode) {
				args.push(source.slice(child.startIndex, child.endIndex));
			}
		}
	}

	return {
		program,
		args,
		raw: source.slice(node.startIndex, node.endIndex),
	};
}

/**
 * Analyze a command for safety.
 */
export function analyzeCommandSafety(command: string): {
	safe: boolean;
	reason?: string;
	parsed: BashParseResult;
} {
	const parsed = parseBashCommand(command);

	if (!parsed.success) {
		return {
			safe: false,
			reason: parsed.error || "Failed to parse command",
			parsed,
		};
	}

	// Check for dangerous constructs
	if (parsed.hasCommandSubstitution) {
		return {
			safe: false,
			reason: "Command contains command substitution ($(...)  or backticks)",
			parsed,
		};
	}

	// Analyze each command in the pipeline
	for (const cmd of parsed.commands) {
		const program = cmd.program.split("/").pop() || cmd.program;

		// Check for sudo prefix
		if (program === "sudo") {
			return {
				safe: false,
				reason: "Command uses sudo (elevated privileges)",
				parsed,
			};
		}

		// Check for dangerous commands
		if (DANGEROUS_COMMANDS.has(program)) {
			// Special case: rm without -r or -f might be okay for single files
			if (program === "rm") {
				const hasRecursive = cmd.args.some(
					(a) => a.includes("-r") || a.includes("-R") || a === "-rf",
				);
				const hasForce = cmd.args.some((a) => a.includes("-f") || a === "-rf");
				if (hasRecursive || hasForce) {
					return {
						safe: false,
						reason: `Dangerous rm command with ${hasRecursive ? "recursive" : ""}${hasRecursive && hasForce ? " and " : ""}${hasForce ? "force" : ""} flags`,
						parsed,
					};
				}
			} else {
				return {
					safe: false,
					reason: `Potentially dangerous command: ${program}`,
					parsed,
				};
			}
		}

		// Check git commands
		if (program === "git" && cmd.args.length > 0) {
			const subcommand = cmd.args[0];
			if (DANGEROUS_GIT_SUBCOMMANDS.has(subcommand)) {
				return {
					safe: false,
					reason: `Git ${subcommand} can modify repository state`,
					parsed,
				};
			}
		}
	}

	// If we have pipes or redirects with non-safe commands, flag it
	if (parsed.hasPipes || parsed.hasRedirects) {
		const allSafe = parsed.commands.every((cmd) => {
			const program = cmd.program.split("/").pop() || cmd.program;
			return SAFE_COMMANDS.has(program) || program === "git";
		});

		if (!allSafe) {
			return {
				safe: false,
				reason: "Command pipeline contains potentially unsafe commands",
				parsed,
			};
		}
	}

	return { safe: true, parsed };
}

/**
 * Check if a command is known to be safe (read-only).
 */
export function isKnownSafeCommand(command: string): boolean {
	const parsed = parseBashCommand(command);

	if (!parsed.success || parsed.commands.length === 0) {
		return false;
	}

	// Command substitution is never safe
	if (parsed.hasCommandSubstitution) {
		return false;
	}

	// Check each command
	for (const cmd of parsed.commands) {
		const program = cmd.program.split("/").pop() || cmd.program;

		// Check if it's a known safe command
		if (SAFE_COMMANDS.has(program)) {
			continue;
		}

		// Check if it's a safe git command
		if (program === "git" && cmd.args.length > 0) {
			const subcommand = cmd.args[0];
			if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
				continue;
			}
		}

		// Not a known safe command
		return false;
	}

	return true;
}

/**
 * Extract the inner command from bash -c or similar wrappers.
 */
export function unwrapShellCommand(command: string): string | null {
	const parsed = parseBashCommand(command);

	if (!parsed.success || parsed.commands.length !== 1) {
		return null;
	}

	const cmd = parsed.commands[0];
	const program = cmd.program.split("/").pop() || cmd.program;

	// Check for bash/sh/zsh with -c flag
	if (["bash", "sh", "zsh"].includes(program)) {
		const cIndex = cmd.args.findIndex((a) => a === "-c" || a === "-lc");
		if (cIndex !== -1 && cIndex + 1 < cmd.args.length) {
			// Return the command string (removing quotes if present)
			let innerCmd = cmd.args[cIndex + 1];
			if (
				(innerCmd.startsWith('"') && innerCmd.endsWith('"')) ||
				(innerCmd.startsWith("'") && innerCmd.endsWith("'"))
			) {
				innerCmd = innerCmd.slice(1, -1);
			}
			return innerCmd;
		}
	}

	return null;
}
