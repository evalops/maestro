import type { SlashCommand } from "@evalops/tui";
import { createCommandRegistry } from "../../commands/registry.js";
import type {
	CommandEntry,
	CommandRegistryOptions,
} from "../../commands/types.js";

export type { CommandRegistryOptions } from "../../commands/types.js";

export function buildCommandRegistry(opts: CommandRegistryOptions): {
	entries: CommandEntry[];
	commands: SlashCommand[];
} {
	const entries = createCommandRegistry(opts);
	return {
		entries,
		commands: entries.map((entry) => entry.command),
	};
}
