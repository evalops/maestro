import {
	type ModelProvider,
	type ModelTier,
	type ReasoningEffort,
	getModelForTier,
} from "./modes.js";
import type { SubagentType } from "./subagent-specs.js";

export const AGENT_PROFILE_LEVELS = ["low", "medium", "high", "ultra"] as const;

export type AgentProfileLevel = (typeof AGENT_PROFILE_LEVELS)[number];

export interface ModelInvocationProfile {
	provider: string;
	model: string;
	reasoningEffort: ReasoningEffort;
	readOnly?: boolean;
}

export interface AgentProfileBudgets {
	maxAttempts: number;
	maxToolCalls: number;
	maxCostUsd?: number;
}

export interface AgentProfile {
	id: string;
	version: number;
	level: AgentProfileLevel;
	description: string;
	primary: ModelInvocationProfile;
	oracle: ModelInvocationProfile;
	specialists: Partial<Record<SubagentType, ModelInvocationProfile>>;
	fallbackLevels: AgentProfileLevel[];
	budgets: AgentProfileBudgets;
}

interface AgentProfileTemplate {
	description: string;
	primaryTier: ModelTier;
	primaryReasoningEffort: ReasoningEffort;
	oracleProvider: ModelProvider;
	oracleTier: ModelTier;
	oracleReasoningEffort: ReasoningEffort;
	specialists: Partial<
		Record<
			SubagentType,
			{
				provider?: ModelProvider;
				tier: ModelTier;
				reasoningEffort: ReasoningEffort;
			}
		>
	>;
	fallbackLevels: AgentProfileLevel[];
	budgets: AgentProfileBudgets;
}

const LEGACY_LEVEL_ALIASES: Readonly<Record<string, AgentProfileLevel>> =
	Object.freeze({
		free: "low",
		rush: "low",
		smart: "medium",
		custom: "medium",
		frontier: "ultra",
	});

const PROFILE_TEMPLATES: Readonly<
	Record<AgentProfileLevel, AgentProfileTemplate>
> = Object.freeze({
	low: {
		description: "Bounded, obvious, and reversible work",
		primaryTier: "haiku",
		primaryReasoningEffort: "low",
		oracleProvider: "openai-codex",
		oracleTier: "opus",
		oracleReasoningEffort: "medium",
		specialists: {
			explorer: { tier: "haiku", reasoningEffort: "low" },
			coder: { tier: "haiku", reasoningEffort: "low" },
			reviewer: { tier: "sonnet", reasoningEffort: "low" },
		},
		fallbackLevels: [],
		budgets: { maxAttempts: 1, maxToolCalls: 15 },
	},
	medium: {
		description: "Ordinary repository work with moderate uncertainty",
		primaryTier: "opus",
		primaryReasoningEffort: "medium",
		oracleProvider: "anthropic",
		oracleTier: "opus",
		oracleReasoningEffort: "medium",
		specialists: {
			explorer: { tier: "haiku", reasoningEffort: "low" },
			planner: { tier: "sonnet", reasoningEffort: "medium" },
			coder: {
				provider: "openai-codex",
				tier: "opus",
				reasoningEffort: "medium",
			},
			reviewer: { tier: "sonnet", reasoningEffort: "medium" },
		},
		fallbackLevels: ["low"],
		budgets: { maxAttempts: 2, maxToolCalls: 30 },
	},
	high: {
		description: "Ambiguous or cross-cutting work where misses are expensive",
		primaryTier: "opus",
		primaryReasoningEffort: "xhigh",
		oracleProvider: "anthropic",
		oracleTier: "opus",
		oracleReasoningEffort: "high",
		specialists: {
			explorer: { tier: "sonnet", reasoningEffort: "medium" },
			planner: { tier: "opus", reasoningEffort: "high" },
			coder: {
				provider: "openai-codex",
				tier: "opus",
				reasoningEffort: "xhigh",
			},
			reviewer: {
				provider: "anthropic",
				tier: "opus",
				reasoningEffort: "high",
			},
		},
		fallbackLevels: ["medium", "low"],
		budgets: { maxAttempts: 2, maxToolCalls: 45 },
	},
	ultra: {
		description: "Migrations, architecture, and discovery-heavy work",
		primaryTier: "opus",
		primaryReasoningEffort: "xhigh",
		oracleProvider: "openai-codex",
		oracleTier: "opus",
		oracleReasoningEffort: "xhigh",
		specialists: {
			explorer: { tier: "sonnet", reasoningEffort: "high" },
			planner: { tier: "opus", reasoningEffort: "xhigh" },
			coder: { tier: "opus", reasoningEffort: "xhigh" },
			reviewer: {
				provider: "openai-codex",
				tier: "opus",
				reasoningEffort: "xhigh",
			},
		},
		fallbackLevels: ["high", "medium"],
		budgets: { maxAttempts: 3, maxToolCalls: 60 },
	},
});

function deepFreeze<T>(value: T): Readonly<T> {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
	}
	return value;
}

function invocation(
	provider: ModelProvider,
	tier: ModelTier,
	reasoningEffort: ReasoningEffort,
	readOnly = false,
): ModelInvocationProfile {
	return {
		provider,
		model: getModelForTier(tier, provider),
		reasoningEffort,
		...(readOnly ? { readOnly: true } : {}),
	};
}

function buildProfile(
	level: AgentProfileLevel,
	provider: ModelProvider,
): AgentProfile {
	const template = PROFILE_TEMPLATES[level];
	const specialists = Object.fromEntries(
		Object.entries(template.specialists).map(([type, specialist]) => {
			const specialistProvider = specialist.provider ?? provider;
			return [
				type,
				invocation(
					specialistProvider,
					specialist.tier,
					specialist.reasoningEffort,
				),
			];
		}),
	) as Partial<Record<SubagentType, ModelInvocationProfile>>;
	return deepFreeze({
		id: `${level}-v1`,
		version: 1,
		level,
		description: template.description,
		primary: invocation(
			provider,
			template.primaryTier,
			template.primaryReasoningEffort,
		),
		oracle: invocation(
			template.oracleProvider,
			template.oracleTier,
			template.oracleReasoningEffort,
			true,
		),
		specialists,
		fallbackLevels: [...template.fallbackLevels],
		budgets: { ...template.budgets },
	}) as AgentProfile;
}

export function parseAgentProfileLevel(
	input: string,
): AgentProfileLevel | null {
	const normalized = input.trim().toLowerCase();
	if (AGENT_PROFILE_LEVELS.includes(normalized as AgentProfileLevel)) {
		return normalized as AgentProfileLevel;
	}
	return LEGACY_LEVEL_ALIASES[normalized] ?? null;
}

export function resolveAgentProfile(
	input: string,
	provider: ModelProvider = "openai-codex",
): AgentProfile {
	const level = parseAgentProfileLevel(input);
	if (!level) throw new Error(`Unknown agent profile: ${input}`);
	return buildProfile(level, provider);
}

export const AGENT_PROFILES: Readonly<Record<AgentProfileLevel, AgentProfile>> =
	deepFreeze(
		Object.fromEntries(
			AGENT_PROFILE_LEVELS.map((level) => [
				level,
				buildProfile(level, "openai-codex"),
			]),
		) as Record<AgentProfileLevel, AgentProfile>,
	);
