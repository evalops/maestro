/**
 * Execution Policy System - Pattern-based command approval policies.
 *
 * Ported from OpenAI Codex (MIT License):
 * https://github.com/openai/codex/tree/main/codex-rs/execpolicy
 *
 * Policies are defined in `.execpolicy` files using a Starlark-like syntax:
 *
 * ```starlark
 * prefix_rule(
 *     pattern=["git", "status"],
 *     decision="allow",
 * )
 *
 * prefix_rule(
 *     pattern=["git", ["push", "fetch"]],
 *     decision="prompt",
 *     match=[["git", "push", "origin", "main"]],
 *     not_match=[["git", "status"]],
 * )
 *
 * prefix_rule(
 *     pattern=["rm", "-rf"],
 *     decision="forbidden",
 * )
 * ```
 *
 * Configuration paths:
 * - ~/.composer/execpolicy (global)
 * - .composer/execpolicy (project - evaluated after global)
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:execpolicy");

/**
 * Decision for a command execution.
 * Based on Codex's Decision enum.
 */
export type Decision = "allow" | "prompt" | "forbidden";

/**
 * Pattern token - either a single string or alternatives.
 * Based on Codex's PatternToken.
 */
export type PatternToken =
	| { type: "single"; value: string }
	| { type: "alts"; values: string[] };

/**
 * A prefix pattern for matching commands.
 * Based on Codex's PrefixPattern.
 */
export interface PrefixPattern {
	first: string;
	rest: PatternToken[];
}

/**
 * A prefix rule that matches commands.
 * Based on Codex's PrefixRule.
 */
export interface PrefixRule {
	pattern: PrefixPattern;
	decision: Decision;
}

/**
 * A rule match result.
 * Based on Codex's RuleMatch.
 */
export type RuleMatch =
	| {
			type: "prefix";
			matchedPrefix: string[];
			decision: Decision;
	  }
	| {
			type: "heuristics";
			command: string[];
			decision: Decision;
	  };

/**
 * Policy evaluation result.
 * Based on Codex's Evaluation.
 */
export interface Evaluation {
	decision: Decision;
	matchedRules: RuleMatch[];
}

/**
 * Policy containing multiple rules indexed by program name.
 * Based on Codex's Policy.
 */
export class Policy {
	private rulesByProgram: Map<string, PrefixRule[]>;

	constructor() {
		this.rulesByProgram = new Map();
	}

	static empty(): Policy {
		return new Policy();
	}

	addRule(rule: PrefixRule): void {
		const program = rule.pattern.first;
		const existing = this.rulesByProgram.get(program) ?? [];
		existing.push(rule);
		this.rulesByProgram.set(program, existing);
	}

	addPrefixRule(
		prefix: string[],
		decision: Decision,
		match?: string[][],
		notMatch?: string[][],
	): void {
		if (prefix.length === 0) {
			throw new Error("prefix cannot be empty");
		}

		const [first, ...rest] = prefix;
		const pattern: PrefixPattern = {
			first,
			rest: rest.map((t) => ({ type: "single", value: t })),
		};
		const rule: PrefixRule = { pattern, decision };

		// Validate match examples
		if (match) {
			for (const example of match) {
				if (!this.ruleMatchesCommand(rule, example)) {
					throw new Error(
						`Rule should match [${example.join(" ")}] but doesn't`,
					);
				}
			}
		}

		// Validate not_match examples
		if (notMatch) {
			for (const example of notMatch) {
				if (this.ruleMatchesCommand(rule, example)) {
					throw new Error(
						`Rule should NOT match [${example.join(" ")}] but does`,
					);
				}
			}
		}

		this.addRule(rule);
	}

	private ruleMatchesCommand(rule: PrefixRule, cmd: string[]): boolean {
		const matched = this.matchPrefix(rule.pattern, cmd);
		return matched !== null;
	}

	private matchPrefix(pattern: PrefixPattern, cmd: string[]): string[] | null {
		const patternLength = pattern.rest.length + 1;
		if (cmd.length < patternLength || cmd[0] !== pattern.first) {
			return null;
		}

		for (let i = 0; i < pattern.rest.length; i++) {
			const patternToken = pattern.rest[i];
			const cmdToken = cmd[i + 1];

			if (!this.tokenMatches(patternToken, cmdToken)) {
				return null;
			}
		}

		return cmd.slice(0, patternLength);
	}

	private tokenMatches(pattern: PatternToken, token: string): boolean {
		if (pattern.type === "single") {
			return pattern.value === token;
		}
		return pattern.values.includes(token);
	}

	check(
		cmd: string[],
		heuristicsFallback?: (cmd: string[]) => Decision,
	): Evaluation {
		const matchedRules = this.matchesForCommand(cmd, heuristicsFallback);
		return this.evaluationFromMatches(matchedRules);
	}

	checkMultiple(
		commands: string[][],
		heuristicsFallback?: (cmd: string[]) => Decision,
	): Evaluation {
		const matchedRules = commands.flatMap((cmd) =>
			this.matchesForCommand(cmd, heuristicsFallback),
		);
		return this.evaluationFromMatches(matchedRules);
	}

	private matchesForCommand(
		cmd: string[],
		heuristicsFallback?: (cmd: string[]) => Decision,
	): RuleMatch[] {
		if (cmd.length === 0) {
			return [];
		}

		const program = cmd[0];
		const rules = this.rulesByProgram.get(program) ?? [];

		const matched: RuleMatch[] = [];
		for (const rule of rules) {
			const matchedPrefix = this.matchPrefix(rule.pattern, cmd);
			if (matchedPrefix) {
				matched.push({
					type: "prefix",
					matchedPrefix,
					decision: rule.decision,
				});
			}
		}

		if (matched.length === 0 && heuristicsFallback) {
			matched.push({
				type: "heuristics",
				command: cmd,
				decision: heuristicsFallback(cmd),
			});
		}

		return matched;
	}

	private evaluationFromMatches(matchedRules: RuleMatch[]): Evaluation {
		// Decision priority: forbidden > prompt > allow
		const decisionOrder: Decision[] = ["allow", "prompt", "forbidden"];

		let highestDecision: Decision = "allow";
		for (const match of matchedRules) {
			const idx = decisionOrder.indexOf(match.decision);
			const currentIdx = decisionOrder.indexOf(highestDecision);
			if (idx > currentIdx) {
				highestDecision = match.decision;
			}
		}

		return {
			decision: highestDecision,
			matchedRules,
		};
	}

	get rules(): Map<string, PrefixRule[]> {
		return this.rulesByProgram;
	}
}

/**
 * Parse a Starlark-like policy file.
 * Supports the `prefix_rule()` function with pattern, decision, match, and not_match.
 */
export function parsePolicy(content: string, identifier: string): Policy {
	const policy = new Policy();

	// Simple regex-based parser for prefix_rule calls
	const ruleRegex =
		/prefix_rule\s*\(\s*([\s\S]*?)\s*\)\s*(?:,?\s*(?=prefix_rule|$))/g;

	for (const match of content.matchAll(ruleRegex)) {
		const args = match[1];

		try {
			const parsed = parsePrefixRuleArgs(args);

			const [first, ...rest] = parsed.pattern;
			const pattern: PrefixPattern = {
				first: getPatternString(first),
				rest: rest.map((t) => {
					if (typeof t === "string") {
						return { type: "single", value: t } as PatternToken;
					}
					if (t.length === 1) {
						return { type: "single", value: t[0] } as PatternToken;
					}
					return { type: "alts", values: t } as PatternToken;
				}),
			};

			// Handle alternatives in first token
			const firstAlternatives = getPatternAlternatives(first);
			for (const firstAlt of firstAlternatives) {
				const rule: PrefixRule = {
					pattern: { ...pattern, first: firstAlt },
					decision: parsed.decision,
				};

				// Validate match examples
				for (const example of parsed.match) {
					if (!matchesPrefix(rule.pattern, example)) {
						throw new Error(
							`Rule should match [${example.join(" ")}] but doesn't`,
						);
					}
				}

				// Validate not_match examples
				for (const example of parsed.notMatch) {
					if (matchesPrefix(rule.pattern, example)) {
						throw new Error(
							`Rule should NOT match [${example.join(" ")}] but does`,
						);
					}
				}

				policy.addRule(rule);
			}
		} catch (error) {
			logger.warn(`Failed to parse rule in ${identifier}`, {
				error: error instanceof Error ? error.message : String(error),
				args: args.slice(0, 100),
			});
		}
	}

	return policy;
}

function getPatternString(token: string | string[]): string {
	return typeof token === "string" ? token : token[0];
}

function getPatternAlternatives(token: string | string[]): string[] {
	return typeof token === "string" ? [token] : token;
}

function matchesPrefix(pattern: PrefixPattern, cmd: string[]): boolean {
	const patternLength = pattern.rest.length + 1;
	if (cmd.length < patternLength || cmd[0] !== pattern.first) {
		return false;
	}

	for (let i = 0; i < pattern.rest.length; i++) {
		const patternToken = pattern.rest[i];
		const cmdToken = cmd[i + 1];

		if (patternToken.type === "single") {
			if (patternToken.value !== cmdToken) {
				return false;
			}
		} else {
			if (!patternToken.values.includes(cmdToken)) {
				return false;
			}
		}
	}

	return true;
}

interface ParsedPrefixRule {
	pattern: (string | string[])[];
	decision: Decision;
	match: string[][];
	notMatch: string[][];
}

function parsePrefixRuleArgs(args: string): ParsedPrefixRule {
	const result: ParsedPrefixRule = {
		pattern: [],
		decision: "allow",
		match: [],
		notMatch: [],
	};

	// Parse pattern=...
	const patternMatch = args.match(/pattern\s*=\s*(\[[\s\S]*?\])/);
	if (patternMatch) {
		result.pattern = parsePatternArray(patternMatch[1]);
	}

	// Parse decision=...
	const decisionMatch = args.match(/decision\s*=\s*"(\w+)"/);
	if (decisionMatch) {
		const d = decisionMatch[1];
		if (d === "allow" || d === "prompt" || d === "forbidden") {
			result.decision = d;
		}
	}

	// Parse match=...
	const matchMatch = args.match(/(?<![_])match\s*=\s*(\[[\s\S]*?\](?:\s*,)?)/);
	if (matchMatch) {
		result.match = parseExamplesArray(matchMatch[1]);
	}

	// Parse not_match=...
	const notMatchMatch = args.match(/not_match\s*=\s*(\[[\s\S]*?\])/);
	if (notMatchMatch) {
		result.notMatch = parseExamplesArray(notMatchMatch[1]);
	}

	if (result.pattern.length === 0) {
		throw new Error("pattern is required");
	}

	return result;
}

function parsePatternArray(str: string): (string | string[])[] {
	const result: (string | string[])[] = [];
	const content = str.slice(1, -1).trim();

	// Simple tokenizer for pattern arrays
	let i = 0;
	while (i < content.length) {
		// Skip whitespace and commas
		while (i < content.length && /[\s,]/.test(content[i])) i++;
		if (i >= content.length) break;

		if (content[i] === '"' || content[i] === "'") {
			// String token
			const quote = content[i];
			i++;
			let value = "";
			while (i < content.length && content[i] !== quote) {
				if (content[i] === "\\" && i + 1 < content.length) {
					i++;
					value += content[i];
				} else {
					value += content[i];
				}
				i++;
			}
			i++; // skip closing quote
			result.push(value);
		} else if (content[i] === "[") {
			// Alternatives array
			const start = i;
			let depth = 1;
			i++;
			while (i < content.length && depth > 0) {
				if (content[i] === "[") depth++;
				else if (content[i] === "]") depth--;
				i++;
			}
			const nestedStr = content.slice(start, i);
			const nested = parseStringArray(nestedStr);
			result.push(nested);
		}
	}

	return result;
}

function parseStringArray(str: string): string[] {
	const result: string[] = [];
	const content = str.slice(1, -1).trim();

	let i = 0;
	while (i < content.length) {
		while (i < content.length && /[\s,]/.test(content[i])) i++;
		if (i >= content.length) break;

		if (content[i] === '"' || content[i] === "'") {
			const quote = content[i];
			i++;
			let value = "";
			while (i < content.length && content[i] !== quote) {
				if (content[i] === "\\" && i + 1 < content.length) {
					i++;
					value += content[i];
				} else {
					value += content[i];
				}
				i++;
			}
			i++;
			result.push(value);
		}
	}

	return result;
}

function parseExamplesArray(str: string): string[][] {
	const result: string[][] = [];
	const content = str.slice(1, -1).trim();

	let i = 0;
	while (i < content.length) {
		while (i < content.length && /[\s,]/.test(content[i])) i++;
		if (i >= content.length) break;

		if (content[i] === "[") {
			const start = i;
			let depth = 1;
			i++;
			while (i < content.length && depth > 0) {
				if (content[i] === "[") depth++;
				else if (content[i] === "]") depth--;
				i++;
			}
			const nestedStr = content.slice(start, i);
			result.push(parseStringArray(nestedStr));
		} else if (content[i] === '"' || content[i] === "'") {
			// Shell command string that needs to be split
			const quote = content[i];
			i++;
			let value = "";
			while (i < content.length && content[i] !== quote) {
				if (content[i] === "\\" && i + 1 < content.length) {
					i++;
					value += content[i];
				} else {
					value += content[i];
				}
				i++;
			}
			i++;
			// Simple shell-like split
			const tokens = value.split(/\s+/).filter(Boolean);
			if (tokens.length > 0) {
				result.push(tokens);
			}
		}
	}

	return result;
}

// ─────────────────────────────────────────────────────────────
// Policy Loading
// ─────────────────────────────────────────────────────────────

let cachedPolicy: Policy | null = null;
let cachedWorkspaceDir: string | null = null;

/**
 * Load policy from execpolicy files.
 */
export function loadPolicy(workspaceDir: string): Policy {
	if (cachedPolicy && cachedWorkspaceDir === workspaceDir) {
		return cachedPolicy;
	}

	const policy = new Policy();

	const globalPath = join(PATHS.COMPOSER_HOME, "execpolicy");
	const projectPath = join(workspaceDir, ".composer", "execpolicy");

	// Load global policy
	if (existsSync(globalPath)) {
		try {
			const content = readFileSync(globalPath, "utf-8");
			const parsed = parsePolicy(content, globalPath);
			for (const [program, rules] of parsed.rules) {
				for (const rule of rules) {
					policy.addRule(rule);
				}
			}
			logger.debug("Loaded global execpolicy", { path: globalPath });
		} catch (error) {
			logger.warn("Failed to load global execpolicy", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Load project policy (evaluated after global, so takes precedence)
	if (existsSync(projectPath)) {
		try {
			const content = readFileSync(projectPath, "utf-8");
			const parsed = parsePolicy(content, projectPath);
			for (const [program, rules] of parsed.rules) {
				for (const rule of rules) {
					policy.addRule(rule);
				}
			}
			logger.debug("Loaded project execpolicy", { path: projectPath });
		} catch (error) {
			logger.warn("Failed to load project execpolicy", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	cachedPolicy = policy;
	cachedWorkspaceDir = workspaceDir;
	return policy;
}

/**
 * Clear policy cache.
 */
export function clearPolicyCache(): void {
	cachedPolicy = null;
	cachedWorkspaceDir = null;
}

/**
 * Append an allow rule to the project's execpolicy file.
 * Based on Codex's amend.rs blocking_append_allow_prefix_rule.
 */
export function appendAllowPrefixRule(
	policyPath: string,
	prefix: string[],
): void {
	if (prefix.length === 0) {
		throw new Error("prefix cannot be empty");
	}

	const tokens = prefix.map((t) => JSON.stringify(t));
	const pattern = `[${tokens.join(", ")}]`;
	const rule = `prefix_rule(pattern=${pattern}, decision="allow")`;

	const dir = dirname(policyPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Ensure file ends with newline before appending
	if (existsSync(policyPath)) {
		const content = readFileSync(policyPath, "utf-8");
		if (content.length > 0 && !content.endsWith("\n")) {
			appendFileSync(policyPath, "\n");
		}
		appendFileSync(policyPath, `${rule}\n`);
	} else {
		writeFileSync(policyPath, `${rule}\n`);
	}

	// Clear cache since policy changed
	clearPolicyCache();

	logger.debug("Appended allow rule", { path: policyPath, prefix });
}

// ─────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────

/**
 * Parse a command string into tokens.
 */
export function parseCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuotes = false;
	let quoteChar = "";
	let isEscaped = false;

	for (const char of command) {
		if (isEscaped) {
			current += char;
			isEscaped = false;
			continue;
		}

		if (char === "\\") {
			isEscaped = true;
			continue;
		}

		if (!inQuotes && (char === '"' || char === "'")) {
			inQuotes = true;
			quoteChar = char;
			continue;
		}

		if (inQuotes && char === quoteChar) {
			inQuotes = false;
			quoteChar = "";
			continue;
		}

		if (!inQuotes && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Check a command and return the evaluation result.
 */
export function checkCommand(
	command: string,
	workspaceDir: string,
	heuristicsFallback?: (cmd: string[]) => Decision,
): Evaluation {
	const policy = loadPolicy(workspaceDir);
	const tokens = parseCommand(command);
	return policy.check(tokens, heuristicsFallback);
}

/**
 * Check if a command is allowed without prompting.
 */
export function isCommandAllowed(
	command: string,
	workspaceDir: string,
): boolean {
	const result = checkCommand(command, workspaceDir);
	return result.decision === "allow";
}

/**
 * Check if a command is forbidden.
 */
export function isCommandForbidden(
	command: string,
	workspaceDir: string,
): boolean {
	const result = checkCommand(command, workspaceDir);
	return result.decision === "forbidden";
}

/**
 * Whitelist a command by adding an allow rule to the project policy.
 */
export function whitelistCommand(workspaceDir: string, command: string): void {
	const tokens = parseCommand(command);
	const policyPath = join(workspaceDir, ".composer", "execpolicy");
	appendAllowPrefixRule(policyPath, tokens);
}

/**
 * Get policy summary for display.
 */
export function getPolicySummary(workspaceDir: string): string {
	const policy = loadPolicy(workspaceDir);
	const lines: string[] = [];

	let totalRules = 0;
	for (const [_program, rules] of policy.rules) {
		totalRules += rules.length;
	}

	lines.push(`Execution Policy (${totalRules} rules)`);
	lines.push("");

	if (totalRules === 0) {
		lines.push("No rules defined. All commands will be prompted.");
		lines.push("");
		lines.push("Create ~/.composer/execpolicy or .composer/execpolicy");
		lines.push("to define command approval policies.");
	} else {
		let count = 0;
		for (const [program, rules] of policy.rules) {
			if (count >= 10) {
				lines.push(`... and ${totalRules - 10} more rules`);
				break;
			}
			for (const rule of rules) {
				if (count >= 10) break;
				const pattern = [
					rule.pattern.first,
					...rule.pattern.rest.map((t) =>
						t.type === "single" ? t.value : `[${t.values.join("|")}]`,
					),
				].join(" ");
				lines.push(`  ${rule.decision.toUpperCase()}: ${pattern}`);
				count++;
			}
		}
	}

	return lines.join("\n");
}
