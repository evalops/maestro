/**
 * Hook configuration loader.
 *
 * Loads hook configurations from multiple sources:
 * - Environment variables (COMPOSER_HOOKS_*)
 * - User config file (~/.composer/hooks.json)
 * - Project config file (.composer/hooks.json)
 * - Programmatic registration
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import type {
	HookCommandConfig,
	HookConfig,
	HookConfiguration,
	HookEventType,
	HookInput,
	HookMatcher,
} from "./types.js";

const logger = createLogger("hooks:config");

/**
 * Raw hook configuration from JSON files.
 */
interface RawHooksConfig {
	hooks?: Partial<
		Record<
			HookEventType,
			Array<{
				matcher?: string;
				hooks: Array<{
					type?: "command" | "prompt" | "agent";
					command?: string;
					prompt?: string;
					timeout?: number;
				}>;
			}>
		>
	>;
}

/**
 * Cache for loaded configuration, keyed by cwd.
 */
interface CacheEntry {
	config: HookConfiguration;
	loadedAt: number;
}
const configCache = new Map<string, CacheEntry>();
const CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Programmatically registered hooks (for session-specific hooks).
 */
const registeredHooks: HookConfiguration = {};

/**
 * Get the user hooks config path.
 */
export function getUserHooksConfigPath(): string {
	return join(homedir(), ".composer", "hooks.json");
}

/**
 * Get the project hooks config path.
 */
export function getProjectHooksConfigPath(cwd: string): string {
	return join(cwd, ".composer", "hooks.json");
}

/**
 * Parse raw hook config from a file into the internal format.
 */
function parseRawHooksConfig(raw: RawHooksConfig): HookConfiguration {
	const result: HookConfiguration = {};

	if (!raw.hooks) {
		return result;
	}

	for (const [eventType, matchers] of Object.entries(raw.hooks)) {
		if (!Array.isArray(matchers)) {
			logger.warn(
				`Invalid hooks config for event ${eventType}: expected array`,
			);
			continue;
		}

		const parsedMatchers: HookMatcher[] = [];

		for (const matcher of matchers) {
			const hooks: HookConfig[] = [];

			if (!Array.isArray(matcher.hooks)) {
				logger.warn("Invalid matcher config: hooks must be an array");
				continue;
			}

			for (const hookDef of matcher.hooks) {
				if (hookDef.type === "command" || hookDef.command) {
					if (!hookDef.command) {
						logger.warn("Command hook missing command field");
						continue;
					}
					hooks.push({
						type: "command",
						command: hookDef.command,
						timeout: hookDef.timeout,
					} satisfies HookCommandConfig);
				} else if (hookDef.type === "prompt" || hookDef.prompt) {
					if (!hookDef.prompt) {
						logger.warn("Prompt hook missing prompt field");
						continue;
					}
					hooks.push({
						type: "prompt",
						prompt: hookDef.prompt,
					});
				}
				// Agent hooks are not loaded from config files (security)
			}

			if (hooks.length > 0) {
				parsedMatchers.push({
					matcher: matcher.matcher,
					hooks,
				});
			}
		}

		if (parsedMatchers.length > 0) {
			result[eventType as HookEventType] = parsedMatchers;
		}
	}

	return result;
}

/**
 * Load hooks configuration from a JSON file.
 */
function loadHooksFromFile(path: string): HookConfiguration {
	if (!existsSync(path)) {
		return {};
	}

	try {
		const content = readFileSync(path, "utf-8");
		const raw = JSON.parse(content) as RawHooksConfig;
		return parseRawHooksConfig(raw);
	} catch (error) {
		logger.warn(`Failed to load hooks from ${path}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return {};
	}
}

/**
 * Load hooks from environment variables.
 *
 * Format: COMPOSER_HOOKS_<EVENT_TYPE>=<command>
 * Example: COMPOSER_HOOKS_PRE_TOOL_USE="my-validator.sh"
 */
function loadHooksFromEnv(): HookConfiguration {
	const result: HookConfiguration = {};
	const envPrefix = "COMPOSER_HOOKS_";

	const eventTypeMap: Record<string, HookEventType> = {
		PRE_TOOL_USE: "PreToolUse",
		POST_TOOL_USE: "PostToolUse",
		POST_TOOL_USE_FAILURE: "PostToolUseFailure",
		SESSION_START: "SessionStart",
		SESSION_END: "SessionEnd",
		SUBAGENT_START: "SubagentStart",
		USER_PROMPT_SUBMIT: "UserPromptSubmit",
		NOTIFICATION: "Notification",
		PRE_COMPACT: "PreCompact",
		PERMISSION_REQUEST: "PermissionRequest",
	};

	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith(envPrefix) || !value) {
			continue;
		}

		const envEventType = key.slice(envPrefix.length);
		const eventType = eventTypeMap[envEventType];

		if (!eventType) {
			continue;
		}

		// Support multiple commands separated by newlines
		const commands = value.split("\n").filter((cmd) => cmd.trim());

		if (commands.length > 0) {
			result[eventType] = [
				{
					matcher: "*",
					hooks: commands.map((cmd) => ({
						type: "command" as const,
						command: cmd.trim(),
					})),
				},
			];
		}
	}

	return result;
}

/**
 * Merge multiple hook configurations together.
 * Later configurations take precedence for the same event/matcher.
 */
function mergeHookConfigs(...configs: HookConfiguration[]): HookConfiguration {
	const result: HookConfiguration = {};

	for (const config of configs) {
		for (const [eventType, matchers] of Object.entries(config)) {
			const existing = result[eventType as HookEventType] ?? [];
			result[eventType as HookEventType] = [...existing, ...(matchers ?? [])];
		}
	}

	return result;
}

/**
 * Load all hook configurations from all sources.
 */
export function loadHookConfiguration(cwd: string): HookConfiguration {
	const now = Date.now();

	// Return cached config if still valid for this cwd
	const cached = configCache.get(cwd);
	if (cached && now - cached.loadedAt < CONFIG_CACHE_TTL_MS) {
		return mergeHookConfigs(cached.config, registeredHooks);
	}

	// Load from all sources
	const envHooks = loadHooksFromEnv();
	const userHooks = loadHooksFromFile(getUserHooksConfigPath());
	const projectHooks = loadHooksFromFile(getProjectHooksConfigPath(cwd));

	// Merge in order of precedence (project > user > env)
	const config = mergeHookConfigs(envHooks, userHooks, projectHooks);
	configCache.set(cwd, { config, loadedAt: now });

	logger.debug("Loaded hook configuration", {
		cwd,
		eventTypes: Object.keys(config),
		envHookCount: Object.keys(envHooks).length,
		userHookCount: Object.keys(userHooks).length,
		projectHookCount: Object.keys(projectHooks).length,
	});

	return mergeHookConfigs(config, registeredHooks);
}

/**
 * Clear the configuration cache (useful for testing).
 */
export function clearHookConfigCache(): void {
	configCache.clear();
}

/**
 * Register a hook programmatically (for session-specific hooks).
 */
export function registerHook(
	eventType: HookEventType,
	hook: HookConfig,
	matcher?: string,
): () => void {
	if (!registeredHooks[eventType]) {
		registeredHooks[eventType] = [];
	}

	const hookMatcher: HookMatcher = {
		matcher,
		hooks: [hook],
	};

	registeredHooks[eventType]?.push(hookMatcher);

	// Return unregister function
	return () => {
		const matchers = registeredHooks[eventType];
		if (matchers) {
			const index = matchers.indexOf(hookMatcher);
			if (index >= 0) {
				matchers.splice(index, 1);
			}
		}
	};
}

/**
 * Clear all programmatically registered hooks.
 */
export function clearRegisteredHooks(): void {
	for (const key of Object.keys(registeredHooks) as HookEventType[]) {
		delete registeredHooks[key];
	}
}

/**
 * Check if a matcher pattern matches a target string.
 *
 * Supports:
 * - "*" matches everything
 * - "name1|name2|name3" matches any of the names
 * - Regular expressions (if pattern contains regex special chars)
 */
export function matchesPattern(target: string, pattern?: string): boolean {
	// No pattern or "*" matches everything
	if (!pattern || pattern === "*") {
		return true;
	}

	// Check for pipe-separated alternatives
	if (/^[a-zA-Z0-9_|]+$/.test(pattern)) {
		if (pattern.includes("|")) {
			const alternatives = pattern.split("|").map((s) => s.trim());
			return alternatives.includes(target);
		}
		// Simple exact match
		return target === pattern;
	}

	// Try as regex
	try {
		return new RegExp(pattern).test(target);
	} catch {
		logger.warn(`Invalid regex pattern in hook matcher: ${pattern}`);
		return false;
	}
}

/**
 * Get the match target from hook input based on event type.
 */
export function getMatchTarget(input: HookInput): string | undefined {
	switch (input.hook_event_name) {
		case "PreToolUse":
		case "PostToolUse":
		case "PostToolUseFailure":
		case "PermissionRequest":
			return input.tool_name;
		case "SessionStart":
			return input.source;
		case "PreCompact":
			return input.trigger;
		case "Notification":
			return input.notification_type;
		case "SessionEnd":
			return input.reason;
		case "SubagentStart":
			return input.agent_type;
		case "UserPromptSubmit":
			return undefined; // Always matches
		default:
			return undefined;
	}
}

/**
 * Get matching hooks for a given input.
 */
export function getMatchingHooks(
	config: HookConfiguration,
	input: HookInput,
): HookConfig[] {
	const eventType = input.hook_event_name;
	const matchers = config[eventType];

	if (!matchers || matchers.length === 0) {
		return [];
	}

	const target = getMatchTarget(input);
	const matchedHooks: HookConfig[] = [];

	for (const matcher of matchers) {
		if (matchesPattern(target ?? "", matcher.matcher)) {
			matchedHooks.push(...matcher.hooks);
		}
	}

	// Deduplicate by command (for command hooks) or reference
	const seen = new Set<string>();
	return matchedHooks.filter((hook) => {
		if (hook.type === "command") {
			if (seen.has(hook.command)) {
				return false;
			}
			seen.add(hook.command);
		}
		return true;
	});
}
