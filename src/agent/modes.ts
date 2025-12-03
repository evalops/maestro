/**
 * Agent Modes - Different operating modes for the agent.
 *
 * Inspired by Amp's smart/rush/free modes:
 * - smart: Uses the best model for the task, balancing quality and cost
 * - rush: Uses faster models for quick responses, may sacrifice quality
 * - free: Uses the most cost-effective models available
 *
 * Each mode maps to a set of model preferences and configuration overrides.
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent:modes");

/**
 * Available agent modes.
 */
export type AgentMode = "smart" | "rush" | "free" | "custom";

/**
 * Model tier for different capability levels.
 */
export type ModelTier = "opus" | "sonnet" | "haiku";

/**
 * Mode configuration that determines model selection and behavior.
 */
export interface ModeConfig {
	/** Display name for the mode */
	displayName: string;
	/** Description of what this mode does */
	description: string;
	/** Primary model tier to use */
	primaryTier: ModelTier;
	/** Fallback model tier if primary is unavailable */
	fallbackTier: ModelTier;
	/** Whether to enable thinking/reasoning */
	enableThinking: boolean;
	/** Maximum thinking budget (tokens) */
	thinkingBudget: number;
	/** Whether to use extended context */
	useExtendedContext: boolean;
	/** Retry configuration */
	maxRetries: number;
	/** Cost multiplier hint (for UI display) */
	costMultiplier: number;
	/** Speed hint (1-10, higher is faster) */
	speedHint: number;
}

/**
 * Model mapping for different providers.
 */
export interface ModelMapping {
	anthropic: string;
	openai?: string;
	google?: string;
}

/**
 * Default mode configurations.
 */
export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
	smart: {
		displayName: "Smart",
		description: "Best quality, uses opus for complex tasks",
		primaryTier: "opus",
		fallbackTier: "sonnet",
		enableThinking: true,
		thinkingBudget: 16000,
		useExtendedContext: true,
		maxRetries: 3,
		costMultiplier: 1.0,
		speedHint: 5,
	},
	rush: {
		displayName: "Rush",
		description: "Fast responses, uses sonnet for speed",
		primaryTier: "sonnet",
		fallbackTier: "haiku",
		enableThinking: false,
		thinkingBudget: 4000,
		useExtendedContext: false,
		maxRetries: 2,
		costMultiplier: 0.5,
		speedHint: 8,
	},
	free: {
		displayName: "Free",
		description: "Most cost-effective, uses haiku",
		primaryTier: "haiku",
		fallbackTier: "haiku",
		enableThinking: false,
		thinkingBudget: 2000,
		useExtendedContext: false,
		maxRetries: 1,
		costMultiplier: 0.1,
		speedHint: 10,
	},
	custom: {
		displayName: "Custom",
		description: "User-defined configuration",
		primaryTier: "sonnet",
		fallbackTier: "haiku",
		enableThinking: true,
		thinkingBudget: 8000,
		useExtendedContext: true,
		maxRetries: 2,
		costMultiplier: 0.7,
		speedHint: 6,
	},
};

/**
 * Model mappings by tier for each provider.
 */
export const MODEL_BY_TIER: Record<ModelTier, ModelMapping> = {
	opus: {
		anthropic: "claude-opus-4-5-20251101",
		openai: "gpt-5.1",
		google: "gemini-2.0-flash-thinking-exp",
	},
	sonnet: {
		anthropic: "claude-sonnet-4-5-20250929",
		openai: "gpt-4o",
		google: "gemini-2.0-flash-exp",
	},
	haiku: {
		anthropic: "claude-haiku-4-5-20251001",
		openai: "gpt-4o-mini",
		google: "gemini-2.0-flash-lite-exp",
	},
};

/**
 * Get the model ID for a given tier and provider.
 */
export function getModelForTier(
	tier: ModelTier,
	provider: "anthropic" | "openai" | "google" = "anthropic",
): string {
	const mapping = MODEL_BY_TIER[tier];
	return mapping[provider] ?? mapping.anthropic;
}

/**
 * Get the configuration for a mode.
 */
export function getModeConfig(mode: AgentMode): ModeConfig {
	return MODE_CONFIGS[mode];
}

/**
 * Get the recommended model for a mode and provider.
 */
export function getModelForMode(
	mode: AgentMode,
	provider: "anthropic" | "openai" | "google" = "anthropic",
): string {
	const config = getModeConfig(mode);
	return getModelForTier(config.primaryTier, provider);
}

/**
 * Current agent mode state.
 */
let currentMode: AgentMode = "smart";

/**
 * Get the current agent mode.
 */
export function getCurrentMode(): AgentMode {
	return currentMode;
}

/**
 * Set the current agent mode.
 */
export function setCurrentMode(mode: AgentMode): void {
	logger.info("Setting agent mode", { mode });
	currentMode = mode;
}

/**
 * Parse mode from string (case-insensitive).
 */
export function parseMode(modeStr: string): AgentMode | null {
	const normalized = modeStr.toLowerCase().trim();
	if (normalized in MODE_CONFIGS) {
		return normalized as AgentMode;
	}
	return null;
}

/**
 * Get mode from environment variable.
 */
export function getModeFromEnv(): AgentMode {
	const envMode = process.env.COMPOSER_MODE?.toLowerCase();
	if (envMode && envMode in MODE_CONFIGS) {
		return envMode as AgentMode;
	}
	return "smart";
}

/**
 * Format mode for display.
 */
export function formatModeDisplay(mode: AgentMode): string {
	const config = getModeConfig(mode);
	return `${config.displayName} - ${config.description}`;
}

/**
 * Get all available modes with their descriptions.
 */
export function getAllModes(): Array<{ mode: AgentMode; config: ModeConfig }> {
	return (Object.entries(MODE_CONFIGS) as [AgentMode, ModeConfig][]).map(
		([mode, config]) => ({
			mode,
			config,
		}),
	);
}

/**
 * Suggest a mode based on task complexity heuristics.
 */
export function suggestMode(taskDescription: string): AgentMode {
	const lowerTask = taskDescription.toLowerCase();

	// Complex tasks → smart mode
	const complexIndicators = [
		"refactor",
		"architect",
		"design",
		"implement",
		"create",
		"build",
		"complex",
		"system",
		"full",
		"entire",
		"comprehensive",
	];

	// Simple tasks → rush mode
	const simpleIndicators = [
		"fix",
		"typo",
		"simple",
		"quick",
		"small",
		"minor",
		"rename",
		"update",
		"change",
	];

	// Information tasks → free mode
	const infoIndicators = [
		"what",
		"where",
		"explain",
		"describe",
		"list",
		"show",
		"find",
		"search",
	];

	const complexScore = complexIndicators.filter((i) =>
		lowerTask.includes(i),
	).length;
	const simpleScore = simpleIndicators.filter((i) =>
		lowerTask.includes(i),
	).length;
	const infoScore = infoIndicators.filter((i) => lowerTask.includes(i)).length;

	if (complexScore > simpleScore && complexScore > infoScore) {
		return "smart";
	}
	if (infoScore > simpleScore) {
		return "free";
	}
	if (simpleScore > 0) {
		return "rush";
	}

	return "smart";
}
