/**
 * Unified Thinking Level Abstraction
 *
 * Issue #853: Unified thinking level abstraction across providers
 *
 * This module provides a unified abstraction for thinking/reasoning levels
 * across different LLM providers. Instead of consumers needing to know
 * provider-specific parameters (Anthropic's budget_tokens, OpenAI's reasoning_effort,
 * Google's thinkingBudget), they can use a single ThinkingLevel enum.
 *
 * ## Design Principles
 *
 * 1. **Simple API**: Single enum works across all providers
 * 2. **Model switching**: Changing providers doesn't require config changes
 * 3. **User control**: Single slider/dropdown for thinking intensity
 * 4. **Progressive levels**: Each level provides incrementally more thinking
 *
 * ## Mapping Strategy
 *
 * | Level    | Anthropic Budget | OpenAI Effort | Google Budget | Description |
 * |----------|------------------|---------------|---------------|-------------|
 * | off      | disabled         | disabled      | disabled      | No extended thinking |
 * | minimal  | 1024 tokens      | low           | 1024 tokens   | Brief hints |
 * | low      | 2048 tokens      | low           | 2048 tokens   | Short steps |
 * | medium   | 4096 tokens      | medium        | 8192 tokens   | Moderate depth (default) |
 * | high     | 8192 tokens      | high          | 16384 tokens  | Thorough reasoning |
 * | ultra    | 16384 tokens     | high          | 32768 tokens  | Very deep thinking |
 * | max      | 32768 tokens     | high          | 65536 tokens  | Maximum depth |
 *
 * ## Usage
 *
 * ```typescript
 * import { mapThinkingLevelToAnthropicBudget } from './thinking-level-mapper';
 *
 * const budget = mapThinkingLevelToAnthropicBudget('high');
 * // budget = 8192
 * ```
 *
 * @module agent/thinking-level-mapper
 */

import type { ThinkingLevel } from "./types.js";

/**
 * Maps ThinkingLevel to Anthropic's budget_tokens parameter.
 *
 * Anthropic models (Claude 3.5+) support extended thinking via budget tokens.
 * Higher budgets allow more reasoning tokens before generating the final response.
 *
 * Note: Claude 4.6+ also supports adaptive effort ("low", "medium", "high"),
 * but budget tokens remain the primary control mechanism.
 *
 * @param level - The unified thinking level
 * @returns Budget tokens for Anthropic's thinking parameter, or undefined if thinking is disabled
 *
 * @example
 * ```typescript
 * const budget = mapThinkingLevelToAnthropicBudget('medium');
 * // Returns: 4096
 *
 * // In Anthropic API request:
 * {
 *   "thinking": {
 *     "type": "enabled",
 *     "budget_tokens": budget
 *   }
 * }
 * ```
 */
export function mapThinkingLevelToAnthropicBudget(
	level: ThinkingLevel | undefined,
): number | undefined {
	if (!level || level === "off") {
		return undefined;
	}

	const budgetMap: Record<Exclude<ThinkingLevel, "off">, number> = {
		minimal: 1024,
		low: 2048,
		medium: 4096,
		high: 8192,
		ultra: 16384,
		max: 32768,
	};

	return budgetMap[level];
}

/**
 * Maps ThinkingLevel to OpenAI's reasoning_effort parameter.
 *
 * OpenAI reasoning models (o1, o1-mini, o3) support reasoning effort
 * strings: "low", "medium", "high". These control the amount of
 * chain-of-thought reasoning the model performs.
 *
 * Note: OpenAI's API only supports up to "high", so "ultra" and "max"
 * levels map to "high" as well.
 *
 * @param level - The unified thinking level
 * @returns Reasoning effort string for OpenAI's API, or undefined if thinking is disabled
 *
 * @example
 * ```typescript
 * const effort = mapThinkingLevelToOpenAIEffort('high');
 * // Returns: "high"
 *
 * // In OpenAI API request:
 * {
 *   "reasoning_effort": effort
 * }
 * ```
 */
export function mapThinkingLevelToOpenAIEffort(
	level: ThinkingLevel | undefined,
): "low" | "medium" | "high" | undefined {
	if (!level || level === "off") {
		return undefined;
	}

	const effortMap: Record<Exclude<ThinkingLevel, "off">, string> = {
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		ultra: "high", // OpenAI max is "high"
		max: "high", // OpenAI max is "high"
	};

	return effortMap[level] as "low" | "medium" | "high";
}

/**
 * Maps ThinkingLevel to Google Gemini's thinkingBudget parameter.
 *
 * Google Gemini models (2.0+, especially 2.5 Flash Thinking) support
 * thinking budgets that control how many tokens the model can use for
 * internal reasoning before generating the response.
 *
 * Google's implementation allows for larger budgets than Anthropic,
 * particularly at higher thinking levels.
 *
 * @param level - The unified thinking level
 * @returns Thinking budget tokens for Google's API, or undefined if thinking is disabled
 *
 * @example
 * ```typescript
 * const budget = mapThinkingLevelToGoogleBudget('high');
 * // Returns: 16384
 *
 * // In Google Gemini API request:
 * {
 *   "thinkingConfig": {
 *     "includeThoughts": true,
 *     "thinkingBudget": budget
 *   }
 * }
 * ```
 */
export function mapThinkingLevelToGoogleBudget(
	level: ThinkingLevel | undefined,
): number | undefined {
	if (!level || level === "off") {
		return undefined;
	}

	const budgetMap: Record<Exclude<ThinkingLevel, "off">, number> = {
		minimal: 1024,
		low: 2048,
		medium: 8192, // Google uses higher budgets for medium+
		high: 16384,
		ultra: 32768,
		max: 65536, // Google supports very large budgets
	};

	return budgetMap[level];
}

/**
 * Validates that a thinking level is supported.
 *
 * This function can be used to check if a ThinkingLevel value is valid
 * before attempting to map it to provider-specific parameters.
 *
 * @param level - The thinking level to validate
 * @returns True if the level is a valid ThinkingLevel
 *
 * @example
 * ```typescript
 * if (isValidThinkingLevel(userInput)) {
 *   const budget = mapThinkingLevelToAnthropicBudget(userInput);
 * }
 * ```
 */
export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	const validLevels: ThinkingLevel[] = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"ultra",
		"max",
	];
	return validLevels.includes(level as ThinkingLevel);
}
