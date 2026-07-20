import type { SlashCommand } from "@evalops/tui";
import type { PromptDefinition } from "../../commands/catalog.js";
import { shouldShowHelp } from "../commands/argument-parser.js";
import type {
	CommandEntry,
	CommandExecutionContext,
} from "../commands/types.js";

type CommandContextFactory = (input: {
	command: SlashCommand;
	rawInput: string;
	argumentText: string;
	parsedArgs?: Record<string, unknown>;
}) => CommandExecutionContext;

export function buildPromptTemplateSlashCommands({
	prompts,
	existingCommands,
	createContext,
	executePromptTemplate,
}: {
	prompts: PromptDefinition[];
	existingCommands: SlashCommand[];
	createContext: CommandContextFactory;
	executePromptTemplate: (
		promptName: string,
		userArgumentText: string,
		context: CommandExecutionContext,
	) => void;
}): { entries: CommandEntry[]; commands: SlashCommand[]; skipped: number } {
	const existing = new Set(
		existingCommands.map((cmd) => cmd.name.toLowerCase()),
	);

	const entries: CommandEntry[] = [];
	const commands: SlashCommand[] = [];
	let skipped = 0;

	for (const prompt of prompts) {
		const normalized = prompt.name.toLowerCase();
		if (existing.has(normalized)) {
			skipped += 1;
			continue;
		}

		const aliases = (prompt.aliases ?? []).filter(
			(alias) => !existing.has(alias.toLowerCase()),
		);

		const command: SlashCommand = {
			name: prompt.name,
			description:
				prompt.description ??
				`Custom prompt (${prompt.sourceType === "user" ? "user" : "project"})`,
			usage: `/${prompt.name}${prompt.argumentHint ? ` ${prompt.argumentHint}` : ""}`,
			tags: ["custom", "prompt"],
			aliases: aliases.length > 0 ? aliases : undefined,
		};

		const matches = buildWithArgsMatcher(prompt.name, aliases);
		const execute = (rawInput: string) => {
			const { argumentText: userArgumentText } = splitInvocation(rawInput);
			const context = createContext({
				command,
				rawInput,
				argumentText: userArgumentText,
			});
			if (shouldShowHelp(userArgumentText)) {
				context.renderHelp();
				return;
			}
			executePromptTemplate(prompt.name, userArgumentText, context);
		};

		entries.push({ command, matches, execute });
		commands.push(command);
		existing.add(normalized);
		for (const alias of aliases) {
			existing.add(alias.toLowerCase());
		}
	}

	return { entries, commands, skipped };
}

function buildWithArgsMatcher(
	name: string,
	aliases: string[],
): (input: string) => boolean {
	const accepted = [name, ...aliases];
	return (input: string) =>
		accepted.some(
			(candidate) =>
				input === `/${candidate}` || input.startsWith(`/${candidate} `),
		);
}

function splitInvocation(rawInput: string): {
	invokedName: string;
	argumentText: string;
} {
	const trimmed = rawInput.trim();
	if (!trimmed.startsWith("/")) {
		return { invokedName: "", argumentText: trimmed };
	}
	const withoutSlash = trimmed.slice(1);
	const spaceIndex = withoutSlash.indexOf(" ");
	if (spaceIndex === -1) {
		return { invokedName: withoutSlash, argumentText: "" };
	}
	return {
		invokedName: withoutSlash.slice(0, spaceIndex),
		argumentText: withoutSlash.slice(spaceIndex + 1).trim(),
	};
}
