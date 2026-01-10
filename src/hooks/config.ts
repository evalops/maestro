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
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import {
	expandTildePathWithHomeDir,
	getHomeDir,
} from "../utils/path-expansion.js";
import type {
	HookCommandConfig,
	HookConfig,
	HookConfiguration,
	HookEventType,
	HookInput,
	HookMatcher,
} from "./types.js";

const logger = createLogger("hooks:config");

function resolveHomeDirectory(): string {
	return getHomeDir();
}

function expandHome(path: string): string {
	return expandTildePathWithHomeDir(path, resolveHomeDirectory());
}

/**
 * Raw hook configuration from JSON files.
 */
interface RawHooksConfig {
	extends?: string | string[];
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

function applyRegisteredHooks(
	base: HookConfiguration,
	registered: HookConfiguration,
): HookConfiguration {
	const result: HookConfiguration = {};

	for (const [eventType, matchers] of Object.entries(base)) {
		if (!matchers) continue;
		result[eventType as HookEventType] = matchers.map((matcher) => ({
			matcher: matcher.matcher,
			hooks: [...matcher.hooks],
		}));
	}

	for (const [eventType, matchers] of Object.entries(registered)) {
		if (!matchers || matchers.length === 0) continue;
		const key = eventType as HookEventType;
		const current = [...(result[key] ?? [])];

		for (const matcher of matchers) {
			const matcherKey = matcher.matcher ?? "*";
			const existing = current.find(
				(entry) => (entry.matcher ?? "*") === matcherKey,
			);
			if (existing) {
				existing.hooks.push(...matcher.hooks);
			} else {
				current.push({
					matcher: matcher.matcher,
					hooks: [...matcher.hooks],
				});
			}
		}

		result[key] = current;
	}

	return result;
}

/**
 * Get the user hooks config path.
 */
export function getUserHooksConfigPath(): string {
	return join(PATHS.COMPOSER_HOME, "hooks.json");
}

/**
 * Get the project hooks config path.
 */
export function getProjectHooksConfigPath(cwd: string): string {
	return join(cwd, ".composer", "hooks.json");
}

function maybeResolveCommand(command: string, sourceDir: string): string {
	const trimmed = command.trim();
	if (trimmed !== command) return command;
	if (/\s/.test(trimmed)) return command;
	if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
		return resolve(sourceDir, trimmed);
	}
	return command;
}

/**
 * Parse raw hook config from a file into the internal format.
 */
function parseRawHooksConfig(
	raw: RawHooksConfig,
	sourceDir?: string,
): HookConfiguration {
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
					const command = sourceDir
						? maybeResolveCommand(hookDef.command, sourceDir)
						: hookDef.command;
					hooks.push({
						type: "command",
						command,
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
	return loadHooksFromFileWithExtends(path);
}

function normalizeExtends(value: RawHooksConfig["extends"]): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
	if (typeof value === "string") return [value];
	return [];
}

function resolveExtendsTarget(spec: string, baseDir: string): string | null {
	const expanded = expandHome(spec.trim());
	if (!expanded) return null;

	// Local / absolute file path
	if (
		expanded.startsWith("./") ||
		expanded.startsWith("../") ||
		expanded.startsWith("~/") ||
		isAbsolute(expanded)
	) {
		return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
	}

	const req = createRequire(import.meta.url);

	// Explicit module path (e.g., pkg/path/to/file.json)
	try {
		return req.resolve(expanded, { paths: [baseDir] });
	} catch {
		// fall through
	}

	// Package root convention: <pkg>/hooks.json
	try {
		return req.resolve(`${expanded}/hooks.json`, { paths: [baseDir] });
	} catch {
		// fall through
	}

	// Package root + manual check (works even if hooks.json isn't in exports)
	try {
		const pkgJson = req.resolve(`${expanded}/package.json`, {
			paths: [baseDir],
		});
		const candidate = join(dirname(pkgJson), "hooks.json");
		if (existsSync(candidate)) return candidate;
	} catch {
		// ignore
	}

	// Fallback for runtimes that don't fully support require.resolve({ paths }),
	// and for local test fixtures that place packages under workspaceDir/node_modules.
	const { packageName, packageSubpath } = parsePackageSpecifier(expanded);
	if (packageName) {
		const packageRoot = findPackageRoot(baseDir, packageName);
		if (packageRoot) {
			if (packageSubpath) {
				const candidate = join(packageRoot, packageSubpath);
				if (existsSync(candidate)) return candidate;
			}
			const hooksJson = join(packageRoot, "hooks.json");
			if (existsSync(hooksJson)) return hooksJson;
		}
	}

	return null;
}

function parsePackageSpecifier(spec: string): {
	packageName: string | null;
	packageSubpath: string | null;
} {
	const normalized = spec.replaceAll("\\", "/");
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length === 0) return { packageName: null, packageSubpath: null };

	if (parts[0]?.startsWith("@")) {
		if (parts.length < 2) return { packageName: null, packageSubpath: null };
		const packageName = `${parts[0]}/${parts[1]}`;
		const packageSubpath = parts.length > 2 ? parts.slice(2).join("/") : null;
		return { packageName, packageSubpath };
	}

	const packageName = parts[0] ?? null;
	const packageSubpath = parts.length > 1 ? parts.slice(1).join("/") : null;
	return { packageName, packageSubpath };
}

function findPackageRoot(startDir: string, packageName: string): string | null {
	let current = resolve(startDir);
	for (;;) {
		const candidate = join(current, "node_modules", packageName);
		if (existsSync(candidate)) return candidate;
		const next = dirname(current);
		if (next === current) break;
		current = next;
	}
	return null;
}

function loadHooksFromFileWithExtends(
	path: string,
	state: { stack: string[]; seen: Set<string> } = {
		stack: [],
		seen: new Set(),
	},
): HookConfiguration {
	if (!existsSync(path)) {
		return {};
	}

	try {
		const resolvedPath = resolve(path);
		const identity = `file:${resolvedPath}`;
		if (state.stack.includes(identity)) {
			logger.warn("Circular hooks config extends detected", {
				chain: [...state.stack, identity],
			});
			return {};
		}
		if (state.seen.has(identity)) {
			return {};
		}

		state.seen.add(identity);
		const nextState = {
			stack: [...state.stack, identity],
			seen: state.seen,
		};

		const content = readFileSync(path, "utf-8");
		const raw = JSON.parse(content) as RawHooksConfig;
		const sourceDir = dirname(resolvedPath);

		const extended = normalizeExtends(raw.extends);
		const resolvedExtends: HookConfiguration[] = [];
		for (const spec of extended) {
			const target = resolveExtendsTarget(spec, sourceDir);
			if (!target) {
				logger.warn("Unable to resolve hooks config extends entry", {
					spec,
					from: resolvedPath,
				});
				continue;
			}
			if (!existsSync(target)) {
				logger.warn("Hooks config extends target does not exist", {
					spec,
					target,
					from: resolvedPath,
				});
				continue;
			}
			resolvedExtends.push(loadHooksFromFileWithExtends(target, nextState));
		}

		const self = parseRawHooksConfig(raw, sourceDir);
		return mergeHookConfigs(...resolvedExtends, self);
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
		EVAL_GATE: "EvalGate",
		SESSION_START: "SessionStart",
		SESSION_END: "SessionEnd",
		SESSION_BEFORE_TREE: "SessionBeforeTree",
		SESSION_TREE: "SessionTree",
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
			const current = result[eventType as HookEventType] ?? [];
			const merged = new Map<string, HookMatcher>();

			const upsert = (matcher: HookMatcher) => {
				const key = matcher.matcher ?? "*";
				if (merged.has(key)) merged.delete(key);
				merged.set(key, matcher);
			};

			for (const matcher of current) {
				upsert(matcher);
			}

			for (const matcher of matchers ?? []) {
				upsert(matcher);
			}

			result[eventType as HookEventType] = Array.from(merged.values());
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
		return applyRegisteredHooks(cached.config, registeredHooks);
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

	return applyRegisteredHooks(config, registeredHooks);
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

	const matcherKey = matcher ?? "*";
	const existing = registeredHooks[eventType]?.find(
		(entry) => (entry.matcher ?? "*") === matcherKey,
	);

	if (existing) {
		existing.hooks.push(hook);
	} else {
		registeredHooks[eventType]?.push({
			matcher,
			hooks: [hook],
		});
	}

	// Return unregister function
	return () => {
		const matchers = registeredHooks[eventType];
		if (!matchers) return;
		const group = matchers.find(
			(entry) => (entry.matcher ?? "*") === matcherKey,
		);
		if (!group) return;
		const index = group.hooks.indexOf(hook);
		if (index >= 0) {
			group.hooks.splice(index, 1);
		}
		if (group.hooks.length === 0) {
			const groupIndex = matchers.indexOf(group);
			if (groupIndex >= 0) matchers.splice(groupIndex, 1);
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
		case "EvalGate":
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

	// Deduplicate by command (command hooks), preferring later entries so higher
	// precedence configs can override lower precedence ones.
	const seen = new Set<string>();
	const dedupedReversed: HookConfig[] = [];
	for (let i = matchedHooks.length - 1; i >= 0; i--) {
		const hook = matchedHooks[i];
		if (!hook) continue;
		if (hook.type === "command") {
			if (seen.has(hook.command)) continue;
			seen.add(hook.command);
		}
		dedupedReversed.push(hook);
	}
	return dedupedReversed.reverse();
}
