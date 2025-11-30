/**
 * Bash command parser using tree-sitter for accurate safety analysis.
 * Provides structured parsing of shell commands to detect dangerous patterns.
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:bash-parser");

// Dynamic import types - use typeof for the default export class
type ParserType = InstanceType<typeof import("tree-sitter")>;
type SyntaxNode = import("tree-sitter").SyntaxNode;

// Initialize parser lazily to handle missing native bindings
let parser: ParserType | null = null;
let parserInitialized = false;
let parserAvailable = false;

async function initParser(): Promise<boolean> {
	if (parserInitialized) return parserAvailable;
	parserInitialized = true;

	try {
		const [Parser, BashLanguage] = await Promise.all([
			import("tree-sitter").then((m) => m.default),
			import("tree-sitter-bash").then((m) => m.default),
		]);
		parser = new Parser();
		parser.setLanguage(
			BashLanguage as unknown as import("tree-sitter").Language,
		);
		parserAvailable = true;
		logger.debug("Tree-sitter bash parser initialized successfully");
	} catch (error) {
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

// Eagerly try to init but don't block
initParser().catch(() => {});

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

// Known safe read-only commands
const SAFE_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"grep",
	"rg",
	"find",
	"ls",
	"pwd",
	"echo",
	"printf",
	"wc",
	"sort",
	"uniq",
	"diff",
	"file",
	"stat",
	"du",
	"df",
	"which",
	"whereis",
	"type",
	"man",
	"help",
	"date",
	"cal",
	"whoami",
	"id",
	"groups",
	"hostname",
	"uname",
	"env",
	"printenv",
	"tree",
	"bat",
	"jq",
	"yq",
	"awk",
	"sed", // read-only when not using -i
	"cut",
	"tr",
	"tee",
	"xargs",
]);

// Git read-only subcommands
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"tag",
	"remote",
	"config",
	"describe",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"blame",
	"shortlog",
	"reflog",
	"stash", // listing
]);

// Dangerous git subcommands
const DANGEROUS_GIT_SUBCOMMANDS = new Set([
	"reset",
	"clean",
	"rm",
	"push",
	"rebase",
	"merge",
	"cherry-pick",
]);

// Commands that are always dangerous
const DANGEROUS_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mkfs",
	"dd",
	"fdisk",
	"parted",
	"format",
	"shred",
	"chmod",
	"chown",
	"kill",
	"killall",
	"pkill",
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
