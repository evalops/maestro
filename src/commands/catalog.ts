import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CommandDefinition {
	name: string;
	description?: string;
	prompt: string;
	args?: Array<{ name: string; required?: boolean }>;
}

export interface ResolvedCommand extends CommandDefinition {
	source: string;
}

const HOME_DIR = join(homedir(), ".composer", "commands");

function readJsonIfExists(path: string): unknown | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function listCommandFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		const { readdirSync } = require("node:fs");
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => join(dir, f));
	} catch {
		return [];
	}
}

export function loadCommandCatalog(workspaceDir: string): ResolvedCommand[] {
	const sources: string[] = [];
	const workspaceCommandsDir = join(workspaceDir, ".composer", "commands");
	sources.push(...listCommandFiles(HOME_DIR));
	sources.push(...listCommandFiles(workspaceCommandsDir));

	const catalog: ResolvedCommand[] = [];
	for (const file of sources) {
		const json = readJsonIfExists(file);
		if (!json || typeof json !== "object") continue;
		const def = json as Partial<CommandDefinition>;
		if (!def.name || !def.prompt) continue;
		catalog.push({
			name: def.name,
			description: def.description,
			prompt: def.prompt,
			args: def.args ?? [],
			source: file,
		});
	}

	// workspace definitions override home by name
	const deduped = new Map<string, ResolvedCommand>();
	for (const def of catalog) {
		deduped.set(def.name, def);
	}
	return Array.from(deduped.values());
}

export function renderCommandPrompt(
	command: ResolvedCommand,
	args: Record<string, string>,
): string {
	let prompt = command.prompt;
	for (const [key, value] of Object.entries(args)) {
		prompt = prompt.replace(new RegExp(`{{${key}}}`, "g"), value);
	}
	return prompt;
}

export function validateCommandArgs(
	command: ResolvedCommand,
	args: Record<string, string>,
): string | null {
	if (!command.args) return null;
	for (const arg of command.args) {
		if (arg.required && !args[arg.name]) {
			return `Missing required arg: ${arg.name}`;
		}
	}
	return null;
}
