/**
 * Bash Safety Analyzer
 *
 * Aggregates bash parsing, heuristics, and dangerous pattern detection behind a
 * single module (issue #292).
 *
 * The goal is to keep `action-firewall.ts` focused on policy wiring while this
 * module owns bash-focused analysis utilities.
 */

export {
	analyzeCommandSafety,
	isKnownSafeCommand,
	isParserAvailable,
	parseBashCommand,
	unwrapShellCommand,
} from "./bash-parser.js";

export type { BashParseResult } from "./bash-parser.js";

export {
	dangerousPatternDescriptions,
	dangerousPatterns,
} from "./dangerous-patterns.js";

export function hasUnquotedBraces(command: string): boolean {
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

export function hasRiskyBashSyntax(command: string): boolean {
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

export function hasEgressPrimitives(command: string): boolean {
	return (
		/\b(curl|wget|nc|ncat|netcat|nc6|socat|telnet|ssh|scp|sftp)\b/i.test(
			command,
		) || /\/dev\/tcp\//i.test(command)
	);
}

// Minimal tokenization that respects simple quoted segments; not a full shell parser.
export function tokenizeSimple(command: string): string[] {
	return (
		command
			.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g)
			?.filter(Boolean) ?? []
	);
}

export function isDestructiveSimpleCommand(tokens: string[]): boolean {
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
			if (!token) continue;
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
				const consumedToken = tokens[i];
				if (
					i < tokens.length &&
					consumedToken &&
					/^["']/.test(consumedToken) &&
					!/["']$/.test(consumedToken)
				) {
					while (i + 1 < tokens.length) {
						const currentToken = tokens[i];
						if (!currentToken || /["']$/.test(currentToken)) break;
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

export function isSimpleBenignBash(command: string): boolean {
	if (hasRiskyBashSyntax(command)) {
		return false;
	}
	const tokens = tokenizeSimple(command);
	if (tokens.length === 0) return true;
	// Skip leading env assignments (VAR=value)
	let idx = 0;
	while (idx < tokens.length) {
		const tok = tokens[idx];
		if (!tok || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) break;
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
	const firstToken = withoutEnv[0];
	if (!firstToken) return true;
	const first = normalizeProgram(firstToken);
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
		while (inner.length > 0) {
			const innerFirst = inner[0];
			if (
				!innerFirst ||
				!wrapperCommands.includes(normalizeProgram(innerFirst))
			)
				break;
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
			if (!head) break;
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
