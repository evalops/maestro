/**
 * Smart Model Router
 *
 * Automatically routes requests to the optimal model based on task type.
 * Uses stronger models for complex reasoning and cheaper models for simple tasks.
 *
 * ## Task Types
 *
 * - **reasoning**: Complex architecture decisions, planning, analysis
 * - **execution**: Code generation, implementation, refactoring
 * - **tools**: Simple tool calls (search, read, list files)
 * - **embedding**: Vector embeddings (future)
 *
 * ## Usage
 *
 * ```typescript
 * import { smartModelRouter } from "./smart-model-router.js";
 *
 * // Configure models
 * smartModelRouter.configure({
 *   reasoning: "claude-opus-4-5-20251101",
 *   execution: "claude-sonnet-4-20250514",
 *   tools: "claude-3-5-haiku-20241022",
 * });
 *
 * // Get model for task
 * const model = smartModelRouter.getModel("reasoning");
 *
 * // Auto-detect task type from context
 * const model = smartModelRouter.routeRequest(messages, tools);
 * ```
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent:smart-model-router");

/**
 * Task types for model routing
 */
export type TaskType =
	| "reasoning"
	| "execution"
	| "tools"
	| "embedding"
	| "default";

/**
 * Model configuration for each task type
 */
export interface ModelConfig {
	reasoning?: string;
	execution?: string;
	tools?: string;
	embedding?: string;
	default: string;
}

/**
 * Signals that indicate reasoning-heavy tasks
 */
const REASONING_SIGNALS = [
	// Planning and architecture
	/\b(plan|design|architect|strategy|approach)\b/i,
	/\b(how should|what's the best way|consider|evaluate)\b/i,
	/\b(trade-?offs?|pros and cons|compare|alternatives)\b/i,

	// Analysis and debugging
	/\b(analyze|debug|investigate|diagnose|root cause)\b/i,
	/\b(why (is|does|doesn't|isn't)|explain|understand)\b/i,

	// Complex decisions
	/\b(refactor|restructure|redesign|optimize)\b/i,
	/\b(security|performance|scalability) (review|audit|analysis)\b/i,
];

/**
 * Signals that indicate simple tool execution
 */
const TOOL_SIGNALS = [
	// File operations
	/\b(read|show|display|cat|view) (file|contents?)\b/i,
	/\b(list|find|search|grep|glob) (files?|directories?)\b/i,
	/\b(check|verify|confirm) (if|whether|that)\b/i,

	// Simple queries
	/\b(what is|where is|how many|count)\b/i,
	/\b(get|fetch|retrieve|look up)\b/i,
];

/**
 * Tools that are typically simple operations
 */
const SIMPLE_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"LS",
	"WebFetch",
	"WebSearch",
]);

/**
 * Tools that typically require more reasoning
 */
const COMPLEX_TOOLS = new Set(["Edit", "Write", "Bash", "Task"]);

/**
 * Default model configurations by provider preference
 */
const DEFAULT_CONFIGS: Record<string, ModelConfig> = {
	anthropic: {
		reasoning: "claude-opus-4-5-20251101",
		execution: "claude-sonnet-4-20250514",
		tools: "claude-3-5-haiku-20241022",
		default: "claude-sonnet-4-20250514",
	},
	openai: {
		reasoning: "o1",
		execution: "gpt-4o",
		tools: "gpt-4o-mini",
		default: "gpt-4o",
	},
	google: {
		reasoning: "gemini-1.5-pro",
		execution: "gemini-1.5-pro",
		tools: "gemini-1.5-flash",
		default: "gemini-1.5-pro",
	},
	mixed: {
		reasoning: "claude-opus-4-5-20251101",
		execution: "claude-sonnet-4-20250514",
		tools: "gpt-4o-mini",
		default: "claude-sonnet-4-20250514",
	},
};

/**
 * Message structure for routing analysis
 */
interface RoutingMessage {
	role: string;
	content: string;
}

/**
 * Routing decision with explanation
 */
export interface RoutingDecision {
	taskType: TaskType;
	model: string;
	reason: string;
	confidence: number;
}

/**
 * Smart model router
 */
class SmartModelRouter {
	private config: ModelConfig = DEFAULT_CONFIGS.anthropic!;
	private enabled = true;
	private stats = {
		reasoning: 0,
		execution: 0,
		tools: 0,
		default: 0,
	};

	/**
	 * Configure models for each task type
	 */
	configure(config: Partial<ModelConfig>): void {
		this.config = { ...this.config, ...config };
		logger.info("Model router configured", { config: this.config });
	}

	/**
	 * Use a preset configuration
	 */
	usePreset(preset: keyof typeof DEFAULT_CONFIGS): void {
		const presetConfig = DEFAULT_CONFIGS[preset];
		if (presetConfig) {
			this.config = { ...presetConfig };
			logger.info("Using preset configuration", { preset });
		}
	}

	/**
	 * Enable or disable smart routing
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		logger.info(`Smart routing ${enabled ? "enabled" : "disabled"}`);
	}

	/**
	 * Get model for a specific task type
	 */
	getModel(taskType: TaskType): string {
		if (!this.enabled) {
			return this.config.default;
		}

		const model = this.config[taskType] || this.config.default;
		this.stats[taskType === "embedding" ? "default" : taskType]++;
		return model;
	}

	/**
	 * Route a request based on messages and tools
	 */
	routeRequest(
		messages: RoutingMessage[],
		pendingTools?: string[],
	): RoutingDecision {
		if (!this.enabled) {
			return {
				taskType: "default",
				model: this.config.default,
				reason: "Smart routing disabled",
				confidence: 1.0,
			};
		}

		// Analyze the last few user messages
		const recentUserMessages = messages
			.filter((m) => m.role === "user")
			.slice(-3)
			.map((m) => m.content)
			.join(" ");

		// Check for reasoning signals
		const reasoningScore = this.scoreSignals(
			recentUserMessages,
			REASONING_SIGNALS,
		);

		// Check for simple tool signals
		const toolScore = this.scoreSignals(recentUserMessages, TOOL_SIGNALS);

		// Check pending tools
		let toolComplexity = 0;
		if (pendingTools && pendingTools.length > 0) {
			const simpleCount = pendingTools.filter((t) =>
				SIMPLE_TOOLS.has(t),
			).length;
			const complexCount = pendingTools.filter((t) =>
				COMPLEX_TOOLS.has(t),
			).length;
			toolComplexity = complexCount - simpleCount;
		}

		// Make routing decision
		let taskType: TaskType;
		let reason: string;
		let confidence: number;

		if (reasoningScore >= 2 || toolComplexity >= 2) {
			taskType = "reasoning";
			reason = `High reasoning signals (score: ${reasoningScore}, complexity: ${toolComplexity})`;
			confidence = Math.min(
				0.9,
				0.5 + reasoningScore * 0.1 + toolComplexity * 0.1,
			);
		} else if (toolScore >= 2 && toolComplexity <= 0) {
			taskType = "tools";
			reason = `Simple tool operation (score: ${toolScore}, complexity: ${toolComplexity})`;
			confidence = Math.min(0.9, 0.5 + toolScore * 0.1);
		} else {
			taskType = "execution";
			reason = `Standard execution (reasoning: ${reasoningScore}, tools: ${toolScore})`;
			confidence = 0.7;
		}

		const model = this.getModel(taskType);

		logger.debug("Routing decision", {
			taskType,
			model,
			reason,
			confidence,
			reasoningScore,
			toolScore,
			toolComplexity,
		});

		return { taskType, model, reason, confidence };
	}

	/**
	 * Score text against signal patterns
	 */
	private scoreSignals(text: string, patterns: RegExp[]): number {
		let score = 0;
		for (const pattern of patterns) {
			if (pattern.test(text)) {
				score++;
			}
		}
		return score;
	}

	/**
	 * Get routing statistics
	 */
	getStats(): typeof this.stats {
		return { ...this.stats };
	}

	/**
	 * Reset statistics
	 */
	resetStats(): void {
		this.stats = { reasoning: 0, execution: 0, tools: 0, default: 0 };
	}

	/**
	 * Get current configuration
	 */
	getConfig(): ModelConfig {
		return { ...this.config };
	}
}

/**
 * Global smart model router instance
 */
export const smartModelRouter = new SmartModelRouter();

/**
 * Helper to determine if a task likely needs reasoning
 */
export function needsReasoning(userMessage: string): boolean {
	return REASONING_SIGNALS.some((pattern) => pattern.test(userMessage));
}

/**
 * Helper to determine if a task is likely simple tool usage
 */
export function isSimpleToolTask(
	userMessage: string,
	tools?: string[],
): boolean {
	const hasToolSignals = TOOL_SIGNALS.some((pattern) =>
		pattern.test(userMessage),
	);
	const hasOnlySimpleTools = tools?.every((t) => SIMPLE_TOOLS.has(t)) ?? true;
	return hasToolSignals && hasOnlySimpleTools;
}
