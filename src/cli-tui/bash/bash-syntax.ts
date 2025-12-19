import { isAbsolute } from "node:path";
import chalk from "chalk";

/**
 * Simple syntax highlighting for bash commands.
 * Colorizes commands, arguments, flags, strings, and variables.
 */

const COMMAND_COLOR = "#7dd3fc"; // cyan-ish
const FLAG_COLOR = "#fbbf24"; // amber
const STRING_COLOR = "#a5d6a7"; // green
const VARIABLE_COLOR = "#ce93d8"; // purple
const OPERATOR_COLOR = "#94a3b8"; // gray
const PATH_COLOR = "#e2e8f0"; // light

/**
 * Shell operators and redirections.
 */
const OPERATORS = new Set(["|", "&&", "||", ";", ">", ">>", "<", "<<", "&"]);

/**
 * Tokenize and highlight a bash command string.
 */
export function highlightBashCommand(command: string): string {
	const tokens = tokenize(command);
	let result = "";
	let isFirstWord = true;

	for (const token of tokens) {
		if (token.type === "whitespace") {
			result += token.value;
			continue;
		}

		if (token.type === "operator") {
			result += chalk.hex(OPERATOR_COLOR)(token.value);
			isFirstWord = true;
			continue;
		}

		if (token.type === "string") {
			result += chalk.hex(STRING_COLOR)(token.value);
			continue;
		}

		if (token.type === "variable") {
			result += chalk.hex(VARIABLE_COLOR)(token.value);
			continue;
		}

		if (token.type === "word") {
			if (isFirstWord) {
				result += chalk.hex(COMMAND_COLOR).bold(token.value);
				isFirstWord = false;
			} else if (token.value.startsWith("-")) {
				result += chalk.hex(FLAG_COLOR)(token.value);
			} else if (looksLikePath(token.value)) {
				result += chalk.hex(PATH_COLOR)(token.value);
			} else {
				result += token.value;
			}
			continue;
		}

		result += token.value;
	}

	return result;
}

interface Token {
	type: "whitespace" | "operator" | "string" | "variable" | "word";
	value: string;
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < input.length) {
		const char = input[i];

		// Whitespace
		if (/\s/.test(char)) {
			let ws = "";
			while (i < input.length && /\s/.test(input[i])) {
				ws += input[i];
				i++;
			}
			tokens.push({ type: "whitespace", value: ws });
			continue;
		}

		// Multi-char operators
		const twoChar = input.slice(i, i + 2);
		if (["&&", "||", ">>", "<<"].includes(twoChar)) {
			tokens.push({ type: "operator", value: twoChar });
			i += 2;
			continue;
		}

		// Single-char operators
		if (OPERATORS.has(char)) {
			tokens.push({ type: "operator", value: char });
			i++;
			continue;
		}

		// Double-quoted string
		if (char === '"') {
			let str = '"';
			i++;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < input.length) {
					str += input[i] + input[i + 1];
					i += 2;
				} else {
					str += input[i];
					i++;
				}
			}
			if (i < input.length) {
				str += '"';
				i++;
			}
			tokens.push({ type: "string", value: str });
			continue;
		}

		// Single-quoted string
		if (char === "'") {
			let str = "'";
			i++;
			while (i < input.length && input[i] !== "'") {
				str += input[i];
				i++;
			}
			if (i < input.length) {
				str += "'";
				i++;
			}
			tokens.push({ type: "string", value: str });
			continue;
		}

		// Variable
		if (char === "$") {
			let varName = "$";
			i++;
			if (i < input.length && input[i] === "{") {
				varName += "{";
				i++;
				while (i < input.length && input[i] !== "}") {
					varName += input[i];
					i++;
				}
				if (i < input.length) {
					varName += "}";
					i++;
				}
			} else {
				while (i < input.length && /[\w]/.test(input[i])) {
					varName += input[i];
					i++;
				}
			}
			tokens.push({ type: "variable", value: varName });
			continue;
		}

		// Word (command, argument, path)
		let word = "";
		while (
			i < input.length &&
			!/\s/.test(input[i]) &&
			!OPERATORS.has(input[i]) &&
			input[i] !== '"' &&
			input[i] !== "'" &&
			input[i] !== "$"
		) {
			word += input[i];
			i++;
		}
		if (word) {
			tokens.push({ type: "word", value: word });
		}
	}

	return tokens;
}

function looksLikePath(value: string): boolean {
	return (
		isAbsolute(value) ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith("~/") ||
		value.includes("/") ||
		value.includes("\\")
	);
}
