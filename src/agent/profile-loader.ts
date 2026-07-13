import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import YAML from "yaml";
import { PATHS } from "../config/constants.js";
import { isRecord } from "../utils/json.js";
import type { ReasoningEffort } from "./modes.js";
import {
	type AgentProfile,
	type AgentProfileBudgets,
	type AgentProfileLevel,
	type ModelInvocationProfile,
	parseAgentProfileLevel,
} from "./profiles.js";
import { parseSubagentType } from "./subagent-specs.js";

const REASONING_EFFORTS = new Set<ReasoningEffort>([
	"low",
	"medium",
	"high",
	"xhigh",
]);

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value.trim();
}

function positiveInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${path} must be a positive integer`);
	}
	return value;
}

function invocation(
	value: unknown,
	path: string,
	options: { requireReadOnly?: boolean } = {},
): ModelInvocationProfile {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const reasoningEffort = requiredString(
		value.reasoningEffort,
		`${path}.reasoningEffort`,
	) as ReasoningEffort;
	if (!REASONING_EFFORTS.has(reasoningEffort)) {
		throw new Error(`${path}.reasoningEffort is invalid`);
	}
	if (options.requireReadOnly && value.readOnly !== true) {
		throw new Error(`${path}.readOnly must be true`);
	}
	return Object.freeze({
		provider: requiredString(value.provider, `${path}.provider`),
		model: requiredString(value.model, `${path}.model`),
		reasoningEffort,
		...(value.readOnly === true ? { readOnly: true } : {}),
	});
}

function parseProfile(value: unknown, source: string): AgentProfile {
	if (!isRecord(value)) throw new Error(`${source} must contain an object`);
	const parsedLevel = parseAgentProfileLevel(
		requiredString(value.level, `${source}.level`),
	);
	if (!parsedLevel) throw new Error(`${source}.level is invalid`);
	const version = positiveInteger(value.version, `${source}.version`);
	const fallbackLevels = Array.isArray(value.fallbackLevels)
		? value.fallbackLevels.map((entry, index) => {
				const level = parseAgentProfileLevel(
					requiredString(entry, `${source}.fallbackLevels[${index}]`),
				);
				if (!level) {
					throw new Error(`${source}.fallbackLevels[${index}] is invalid`);
				}
				return level;
			})
		: [];
	if (!isRecord(value.budgets)) {
		throw new Error(`${source}.budgets must be an object`);
	}
	const budgets: AgentProfileBudgets = Object.freeze({
		maxAttempts: positiveInteger(
			value.budgets.maxAttempts,
			`${source}.budgets.maxAttempts`,
		),
		maxToolCalls: positiveInteger(
			value.budgets.maxToolCalls,
			`${source}.budgets.maxToolCalls`,
		),
		...(typeof value.budgets.maxCostUsd === "number"
			? { maxCostUsd: value.budgets.maxCostUsd }
			: {}),
	});
	const specialists: AgentProfile["specialists"] = {};
	if (isRecord(value.specialists)) {
		for (const [rawType, config] of Object.entries(value.specialists)) {
			const type = parseSubagentType(rawType);
			if (!type) throw new Error(`${source}.specialists.${rawType} is invalid`);
			specialists[type] = invocation(
				config,
				`${source}.specialists.${rawType}`,
			);
		}
	}
	return Object.freeze({
		id: requiredString(value.id, `${source}.id`),
		version,
		level: parsedLevel as AgentProfileLevel,
		description: requiredString(value.description, `${source}.description`),
		primary: invocation(value.primary, `${source}.primary`),
		oracle: invocation(value.oracle, `${source}.oracle`, {
			requireReadOnly: true,
		}),
		specialists: Object.freeze(specialists),
		fallbackLevels: Object.freeze(fallbackLevels) as AgentProfileLevel[],
		budgets,
	});
}

export function loadAgentProfilesFromDirectory(
	directory: string,
): AgentProfile[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((file) => [".yaml", ".yml"].includes(extname(file).toLowerCase()))
		.sort()
		.map((file) => {
			const path = join(directory, file);
			return parseProfile(YAML.parse(readFileSync(path, "utf8")), path);
		});
}

export function loadAgentProfiles(
	options: {
		workspaceDir?: string;
		homeDir?: string;
	} = {},
): AgentProfile[] {
	const workspaceDir = options.workspaceDir ?? process.cwd();
	const homeDir = options.homeDir ?? PATHS.MAESTRO_HOME;
	const profiles = new Map<string, AgentProfile>();
	for (const profile of loadAgentProfilesFromDirectory(
		join(homeDir, "agent-profiles"),
	)) {
		profiles.set(profile.id, profile);
	}
	for (const profile of loadAgentProfilesFromDirectory(
		join(workspaceDir, ".maestro", "agent-profiles"),
	)) {
		profiles.set(profile.id, profile);
	}
	return Array.from(profiles.values()).sort((a, b) => a.id.localeCompare(b.id));
}
