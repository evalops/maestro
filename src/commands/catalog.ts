import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../config/constants.js";
import { buildDirectoriesFingerprint } from "./filesystem-catalog-cache.js";

// Re-export prompts module
export {
	type ParsedPromptArgs,
	type PromptDefinition,
	findPrompt,
	formatPromptListItem,
	getPromptUsageHint,
	loadPrompts,
	parsePromptArgs,
	renderPrompt,
	validatePromptArgs,
} from "./prompts.js";

export interface CommandDefinition {
	name: string;
	description?: string;
	prompt: string;
	args?: Array<{ name: string; required?: boolean }>;
}

export interface ResolvedCommand extends CommandDefinition {
	source: string;
}

const commandCatalogCache = new Map<
	string,
	{ signature: string; catalog: ResolvedCommand[] }
>();

const getHomeCommandsDir = (): string => join(PATHS.MAESTRO_HOME, "commands");

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
		return readdirSync(dir)
			.filter((f: string) => f.endsWith(".json"))
			.map((f: string) => join(dir, f));
	} catch {
		return [];
	}
}

export function parseCommandArgs(tokens: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (const token of tokens) {
		const eqIndex = token.indexOf("=");
		if (eqIndex <= 0) continue; // skip missing key or value-less tokens
		const key = token.slice(0, eqIndex);
		const value = token.slice(eqIndex + 1);
		args[key] = value;
	}
	return args;
}

export function loadCommandCatalog(workspaceDir: string): ResolvedCommand[] {
	const homeDir = getHomeCommandsDir();
	const sources: string[] = [];
	const workspaceCommandsDir = join(workspaceDir, ".maestro", "commands");
	const signature = buildDirectoriesFingerprint(
		[homeDir, workspaceCommandsDir],
		(entry) => entry.endsWith(".json"),
	);
	const cached = commandCatalogCache.get(workspaceDir);
	if (cached?.signature === signature) {
		return cached.catalog;
	}
	sources.push(...listCommandFiles(homeDir));
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
	const resolved = Array.from(deduped.values());
	commandCatalogCache.set(workspaceDir, {
		signature,
		catalog: resolved,
	});
	return resolved;
}

export function renderCommandPrompt(
	command: ResolvedCommand,
	args: Record<string, string>,
): string {
	let prompt = command.prompt;
	for (const [key, value] of Object.entries(args)) {
		const pattern = new RegExp(`{{${escapeRegExp(key)}}}`, "g");
		prompt = prompt.replace(pattern, value);
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
