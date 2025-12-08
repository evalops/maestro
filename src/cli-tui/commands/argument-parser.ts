import type { CommandArgumentDefinition, SlashCommand } from "@evalops/tui";
import chalk from "chalk";

export type CommandArgumentParseResult<T = Record<string, unknown>> =
	| { ok: true; args: T }
	| { ok: false; errors: string[] };

const HELP_TOKENS = new Set(["help", "--help", "-h", "-help"]);

export function shouldShowHelp(argumentText: string): boolean {
	const trimmed = argumentText.trim().toLowerCase();
	return trimmed.length > 0 && HELP_TOKENS.has(trimmed);
}

export function parseCommandArguments(
	argumentText: string,
	definitions: CommandArgumentDefinition[] | undefined,
): CommandArgumentParseResult {
	if (!definitions || definitions.length === 0) {
		return { ok: true, args: {} };
	}
	const tokens = argumentText.trim() ? argumentText.trim().split(/\s+/) : [];
	const args: Record<string, unknown> = {};
	for (let index = 0; index < definitions.length; index += 1) {
		const definition = definitions[index];
		if (definition.variadic) {
			const remaining = tokens.splice(0);
			if (definition.type === "number") {
				const numbers = remaining.map((token) => Number(token));
				if (numbers.some((value) => Number.isNaN(value))) {
					return {
						ok: false,
						errors: [
							`Argument "${definition.name}" must contain numeric values.`,
						],
					};
				}
				args[definition.name] = numbers;
			} else {
				args[definition.name] = remaining;
			}
			continue;
		}
		const token = tokens.shift();
		if (!token || token.length === 0) {
			if (definition.required && definition.defaultValue === undefined) {
				return {
					ok: false,
					errors: [`Missing required argument "${definition.name}".`],
				};
			}
			if (definition.defaultValue !== undefined) {
				args[definition.name] = coerceValue(
					definition,
					definition.defaultValue,
				);
			}
			continue;
		}
		const value = coerceValue(definition, token);
		if (value instanceof Error) {
			return { ok: false, errors: [value.message] };
		}
		args[definition.name] = value;
	}
	if (tokens.length > 0) {
		return {
			ok: false,
			errors: [
				`Received unexpected argument${tokens.length > 1 ? "s" : ""}: ${tokens.join(", ")}`,
			],
		};
	}
	return { ok: true, args };
}

function coerceValue(
	definition: CommandArgumentDefinition,
	value: string,
): unknown | Error {
	switch (definition.type) {
		case "number": {
			const numericValue = Number(value);
			if (Number.isNaN(numericValue)) {
				return new Error(
					`Argument "${definition.name}" must be a valid number (received "${value}").`,
				);
			}
			return numericValue;
		}
		case "boolean": {
			const normalized = value.toLowerCase();
			if (["true", "1", "yes", "on"].includes(normalized)) {
				return true;
			}
			if (["false", "0", "no", "off"].includes(normalized)) {
				return false;
			}
			return new Error(
				`Argument "${definition.name}" must be a boolean (received "${value}").`,
			);
		}
		case "enum": {
			if (!definition.choices || definition.choices.length === 0) {
				return value;
			}
			const normalized = value.toLowerCase();
			const match = definition.choices.find(
				(choice) => choice.toLowerCase() === normalized,
			);
			if (!match) {
				return new Error(
					`Argument "${definition.name}" must be one of: ${definition.choices.join(", ")}.`,
				);
			}
			return match;
		}
		default:
			return value;
	}
}

export function formatCommandHelp(command: SlashCommand): string {
	const lines: string[] = [];
	lines.push(chalk.bold(`/${command.name}`));
	if (command.description) {
		lines.push(chalk.dim(command.description));
	}
	if (command.usage) {
		lines.push("");
		lines.push(chalk.bold("Usage:"));
		lines.push(`  ${command.usage}`);
	}
	if (command.arguments && command.arguments.length > 0) {
		lines.push("");
		lines.push(chalk.bold("Arguments:"));
		for (const arg of command.arguments) {
			const requiredFlag = arg.required ? "(required)" : "(optional)";
			const description = arg.description ? ` — ${arg.description}` : "";
			const choices =
				arg.type === "enum" && arg.choices?.length
					? ` [${arg.choices.join(" | ")}]`
					: "";
			lines.push(`  ${arg.name} ${requiredFlag}${choices}${description}`);
		}
	}
	if (command.examples && command.examples.length > 0) {
		lines.push("");
		lines.push(chalk.bold("Examples:"));
		for (const example of command.examples) {
			lines.push(`  ${example}`);
		}
	}
	if (command.tags && command.tags.length > 0) {
		lines.push("");
		lines.push(chalk.dim(`Tags: ${command.tags.join(", ")}`));
	}
	return lines.join("\n");
}
