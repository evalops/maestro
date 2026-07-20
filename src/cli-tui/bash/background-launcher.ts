import { backgroundTaskManager } from "../../tools/background-tasks.js";

export type BackgroundLaunchSource = "prefix" | "suffix";

export interface BackgroundLaunchOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv | Record<string, string>;
	useShell?: boolean;
}

export interface BackgroundLaunchResult {
	id: string;
	command: string;
}

export function parseBackgroundPrefixCommand(input: string): string | null {
	if (!input.startsWith("!&")) {
		return null;
	}
	const command = input.slice(2).trim();
	return command.length > 0 ? command : null;
}

export function stripBackgroundSuffix(command: string): string | null {
	let candidate = command.trimEnd();
	if (!candidate.endsWith("&")) {
		return null;
	}
	if (candidate.endsWith("&&")) {
		return null;
	}
	const lastIndex = candidate.length - 1;
	if (lastIndex > 0 && candidate[lastIndex - 1] === "\\") {
		return null;
	}
	candidate = candidate.slice(0, -1).trimEnd();
	return candidate.length > 0 ? candidate : null;
}

export function startBackgroundTask(
	command: string,
	options: BackgroundLaunchOptions,
): BackgroundLaunchResult {
	if (!command.trim()) {
		throw new Error("Background command cannot be empty.");
	}
	const task = backgroundTaskManager.start(command, {
		cwd: options.cwd,
		env: normalizeEnv(options.env),
		useShell: options.useShell ?? true,
	});
	return {
		id: task.id,
		command: task.command,
	};
}

function normalizeEnv(
	env?: NodeJS.ProcessEnv | Record<string, string>,
): Record<string, string> | undefined {
	if (!env) {
		return undefined;
	}
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") {
			normalized[key] = value;
		}
	}
	return normalized;
}
