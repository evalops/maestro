/**
 * Agent Modes - Different operating modes for the agent.
 *
 * This module implements a tiered model selection system inspired by Amp's
 * smart/rush/free modes. Each mode represents a different balance between
 * response quality, speed, and cost:
 *
 * - **smart**: Uses the highest capability model (opus) for complex reasoning
 *   tasks. Enables thinking/reasoning mode with extended context windows.
 *   Best for: Architecture decisions, complex refactoring, debugging.
 *
 * - **rush**: Uses mid-tier models (sonnet) for faster responses. Disables
 *   thinking mode to reduce latency. Best for: Quick fixes, simple edits,
 *   straightforward code generation.
 *
 * - **free**: Uses the most cost-effective models (haiku) with minimal
 *   features. Best for: Simple questions, file searches, documentation
 *   lookups where speed and cost matter more than depth.
 *
 * - **custom**: User-defined configuration allowing fine-tuned control
 *   over model selection and feature toggles.
 *
 * ## Architecture
 *
 * The mode system uses a two-level abstraction:
 * 1. **ModelTier** (opus/sonnet/haiku): Logical capability levels
 * 2. **ModelMapping**: Provider-specific model IDs for each tier
 *
 * This allows the same mode configuration to work across different
 * LLM providers (Anthropic, OpenAI, Google) by mapping tiers to
 * provider-specific model identifiers.
 *
 * ## Usage
 *
 * ```typescript
 * // Set mode based on task
 * setCurrentMode(suggestMode("refactor the auth module")); // → "smart"
 *
 * // Get model for current provider
 * const model = getModelForMode(getCurrentMode(), "anthropic");
 * ```
 *
 * ## Environment Variables
 *
 * - `COMPOSER_MODE`: Override the default mode at startup
 */

import { createLogger } from "../utils/logger.js";

// Logger scoped to agent modes for debugging mode transitions
const logger = createLogger("agent:modes");

/**
 * Available agent modes representing different quality/speed/cost tradeoffs.
 *
 * - "smart": Maximum capability, uses opus-class models with reasoning enabled
 * - "rush": Balanced speed, uses sonnet-class models without reasoning overhead
 * - "free": Cost-optimized, uses haiku-class models for simple operations
 * - "custom": User-defined settings for specialized workflows
 */
export type AgentMode = "smart" | "rush" | "free" | "custom";

/**
 * Model tier representing capability levels that map to provider-specific models.
 *
 * The tier abstraction allows the same configuration to work across providers:
 * - "opus": Highest capability (claude-opus, gpt-5.2, gemini-thinking)
 * - "sonnet": Balanced capability (claude-sonnet, gpt-4o, gemini-flash)
 * - "haiku": Fast/efficient (claude-haiku, gpt-4o-mini, gemini-flash-lite)
 */
export type ModelTier = "opus" | "sonnet" | "haiku";

/**
 * Mode configuration that determines model selection and behavior.
 *
 * Each mode has a complete configuration that controls:
 * - Which model tier to use (primary and fallback)
 * - Whether to enable extended reasoning/thinking
 * - Context and retry limits
 * - UI hints for cost/speed display
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
 * Default mode configurations defining the behavior of each agent mode.
 *
 * These configurations are the canonical source of truth for how each mode
 * behaves. The settings are carefully tuned based on model capabilities
 * and typical use case requirements:
 *
 * - **smart**: Full-featured for complex tasks (16k thinking budget, 3 retries)
 * - **rush**: Optimized for speed (no thinking, 2 retries, smaller context)
 * - **free**: Minimal resource usage (no thinking, 1 retry, no extended context)
 * - **custom**: Balanced defaults that users can override
 */
export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
	// Smart mode: Maximum capability for complex reasoning tasks
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
	// Rush mode: Speed-optimized for quick iterations
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
	// Free mode: Cost-optimized for simple tasks
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
	// Custom mode: User-configurable defaults (can be overridden at runtime)
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
 *
 * This lookup table maps abstract capability tiers to concrete model IDs
 * for each supported LLM provider. When adding new providers or updating
 * model versions, update this table to maintain consistent tier behavior.
 *
 * Note: Model IDs include version dates to ensure reproducibility.
 * Update these periodically as providers release improved versions.
 */
export const MODEL_BY_TIER: Record<ModelTier, ModelMapping> = {
	// Opus tier: Highest capability models with advanced reasoning
	opus: {
		anthropic: "claude-opus-4-6",
		openai: "gpt-5.2",
		google: "gemini-2.0-flash-thinking-exp",
	},
	// Sonnet tier: Balanced performance models for general use
	sonnet: {
		anthropic: "claude-sonnet-4-5-20250929",
		openai: "gpt-4o",
		google: "gemini-2.0-flash-exp",
	},
	// Haiku tier: Fast, efficient models for simple tasks
	haiku: {
		anthropic: "claude-haiku-4-5-20251001",
		openai: "gpt-4o-mini",
		google: "gemini-2.0-flash-lite-exp",
	},
};

/**
 * Get the model ID for a given tier and provider.
 *
 * @param tier - The capability tier (opus/sonnet/haiku)
 * @param provider - The LLM provider (defaults to anthropic)
 * @returns The concrete model ID string for the provider
 *
 * Falls back to the Anthropic model if the requested provider
 * doesn't have a mapping for the tier.
 */
export function getModelForTier(
	tier: ModelTier,
	provider: "anthropic" | "openai" | "google" = "anthropic",
): string {
	const mapping = MODEL_BY_TIER[tier];
	// Fall back to Anthropic if provider doesn't have a mapping
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
 * Current agent mode state (module-level singleton).
 *
 * This tracks the active mode for the current process. In multi-session
 * scenarios, each session should manage its own mode state rather than
 * relying on this global.
 */
let currentMode: AgentMode = "smart";

/**
 * Get the current agent mode.
 *
 * @returns The currently active agent mode
 */
export function getCurrentMode(): AgentMode {
	return currentMode;
}

/**
 * Set the current agent mode.
 *
 * This updates the global mode state and logs the transition for debugging.
 * Mode changes take effect immediately for subsequent operations.
 *
 * @param mode - The new mode to activate
 */
export function setCurrentMode(mode: AgentMode): void {
	logger.info("Setting agent mode", { mode });
	currentMode = mode;
}

/**
 * Parse mode from string (case-insensitive).
 *
 * Validates user input and converts to a valid AgentMode type.
 *
 * @param modeStr - User-provided mode string (e.g., "Smart", "RUSH")
 * @returns The parsed AgentMode, or null if invalid
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
 *
 * Reads COMPOSER_MODE from environment and validates it.
 * Defaults to "smart" if not set or invalid.
 *
 * @returns The configured mode or "smart" as default
 */
export function getModeFromEnv(): AgentMode {
	const envMode = process.env.COMPOSER_MODE?.toLowerCase();
	if (envMode && envMode in MODE_CONFIGS) {
		return envMode as AgentMode;
	}
	// Default to smart mode for best quality when not specified
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
 *
 * This function analyzes the task description to recommend an appropriate
 * mode based on keyword matching. It uses a scoring system to determine
 * task complexity:
 *
 * **Scoring Algorithm:**
 * 1. Count matches against complex/simple/info indicator word lists
 * 2. Compare scores to determine dominant category
 * 3. Return mode matching the highest score
 *
 * **Keyword Categories:**
 * - Complex (→ smart): refactor, architect, design, implement, build...
 * - Simple (→ rush): fix, typo, rename, update, small changes...
 * - Info (→ free): what, where, explain, find, search queries...
 *
 * @param taskDescription - The user's task description to analyze
 * @returns The recommended AgentMode based on task complexity
 *
 * @example
 * suggestMode("refactor the authentication module") // → "smart"
 * suggestMode("fix typo in README") // → "rush"
 * suggestMode("what does this function do?") // → "free"
 */
export function suggestMode(taskDescription: string): AgentMode {
	const lowerTask = taskDescription.toLowerCase();

	// Complex tasks → smart mode (require deep reasoning)
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

	// Simple tasks → rush mode (straightforward modifications)
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

	// Information tasks → free mode (queries, not modifications)
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

	// Calculate match scores for each category
	const complexScore = complexIndicators.filter((i) =>
		lowerTask.includes(i),
	).length;
	const simpleScore = simpleIndicators.filter((i) =>
		lowerTask.includes(i),
	).length;
	const infoScore = infoIndicators.filter((i) => lowerTask.includes(i)).length;

	// Determine mode based on highest scoring category
	if (complexScore > simpleScore && complexScore > infoScore) {
		return "smart";
	}
	if (infoScore > simpleScore) {
		return "free";
	}
	if (simpleScore > 0) {
		return "rush";
	}

	// Default to smart mode when no clear indicators found
	// (better to over-estimate complexity than under-estimate)
	return "smart";
}
