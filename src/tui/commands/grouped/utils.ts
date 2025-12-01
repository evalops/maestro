/**
 * Shared utilities for grouped command handlers.
 *
 * Provides consistent argument parsing and context rewriting
 * across all grouped command implementations.
 */

import type { CommandExecutionContext } from "../types.js";

/**
 * Result of parsing subcommand arguments.
 */
export interface ParsedSubcommand {
	/** The subcommand name (first argument, lowercased) */
	subcommand: string;
	/** All arguments split by whitespace */
	args: string[];
	/** Creates a new context for delegating to another command */
	rewriteContext: (cmd: string) => CommandExecutionContext;
	/** Creates a context with custom raw input and argument text */
	customContext: (
		rawInput: string,
		argumentText: string,
	) => CommandExecutionContext;
}

/**
 * Parse subcommand arguments from a context with a default subcommand.
 *
 * @example
 * ```ts
 * const { subcommand, args, rewriteContext } = parseSubcommand(ctx, "status");
 * switch (subcommand) {
 *   case "status":
 *     deps.handleStatus();
 *     break;
 *   case "start":
 *     await deps.handleStart(rewriteContext("start"));
 *     break;
 * }
 * ```
 */
export function parseSubcommand(
	ctx: CommandExecutionContext,
	defaultSubcommand: string,
): ParsedSubcommand {
	const args = ctx.argumentText.trim().split(/\s+/);
	const subcommand = args[0]?.toLowerCase() || defaultSubcommand;

	const rewriteContext = (cmd: string): CommandExecutionContext => ({
		...ctx,
		rawInput: `/${cmd} ${args.slice(1).join(" ")}`.trim(),
		argumentText: args.slice(1).join(" "),
	});

	const customContext = (
		rawInput: string,
		argumentText: string,
	): CommandExecutionContext => ({
		...ctx,
		rawInput,
		argumentText,
	});

	return { subcommand, args, rewriteContext, customContext };
}

/**
 * Check if a string matches common help aliases.
 */
export function isHelpRequest(subcommand: string): boolean {
	return ["help", "?", "-h", "--help"].includes(subcommand);
}

/**
 * Check if a string looks like a numeric argument.
 */
export function isNumericArg(value: string): boolean {
	return /^\d+$/.test(value);
}

/**
 * Check if a string looks like a session ID (hex string or number).
 */
export function isSessionId(value: string): boolean {
	return /^[a-f0-9-]+$/i.test(value) || /^\d+$/.test(value);
}

/**
 * Common aliases for subcommands across handlers.
 */
export const COMMON_ALIASES = {
	status: ["status", "st", "info"],
	list: ["list", "ls", "all"],
	help: ["help", "?", "-h", "--help"],
	enable: ["enable", "on", "yes", "true", "1"],
	disable: ["disable", "off", "no", "false", "0"],
} as const;

/**
 * Check if a subcommand matches any of the given aliases.
 */
export function matchesAlias(
	subcommand: string,
	aliases: readonly string[],
): boolean {
	return aliases.includes(subcommand.toLowerCase());
}
