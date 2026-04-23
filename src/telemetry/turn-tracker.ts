/**
 * Turn Tracker - Integrates TurnCollector with Agent Event Stream
 *
 * Automatically tracks agent turns by subscribing to agent events and
 * emitting canonical wide events at turn completion.
 */

import type { Agent } from "../agent/agent.js";
import type { AgentEvent, ThinkingLevel, Usage } from "../agent/types.js";
import {
	type CanonicalTurnEvent,
	type TailSamplingConfig,
	TurnCollector,
	getSamplingConfigFromEnv,
} from "./wide-events.js";

export interface TurnTrackerConfig {
	/** Session ID for the current session */
	sessionId: string;
	/** Sampling configuration (defaults to env vars or built-in defaults) */
	samplingConfig?: Partial<TailSamplingConfig>;
	/** Callback when a turn completes (for logging/debugging) */
	onTurnComplete?: (event: CanonicalTurnEvent) => void;
}

export interface TurnTrackerContext {
	/** Sandbox mode in use */
	sandboxMode?: "docker" | "local" | "none";
	/** Approval mode in use */
	approvalMode?: "auto" | "prompt" | "fail";
	/** Active MCP server names */
	mcpServers?: string[];
	/** Number of context sources */
	contextSourceCount?: number;
	/** Feature flags */
	features?: {
		safeMode?: boolean;
		guardianEnabled?: boolean;
		compactionEnabled?: boolean;
		hookCount?: number;
	};
}

/**
 * Tracks agent turns and emits canonical wide events.
 *
 * Usage:
 * ```typescript
 * const tracker = new TurnTracker(agent, {
 *   sessionId: "session-123",
 *   onTurnComplete: (event) => console.log("Turn completed:", event.turnId),
 * });
 *
 * // Update context as it changes
 * tracker.updateContext({ sandboxMode: "docker", mcpServers: ["context7"] });
 *
 * // Tracker automatically records turns via agent subscription
 * await agent.prompt("Hello!");
 *
 * // Clean up when done
 * tracker.dispose();
 * ```
 */
export class TurnTracker {
	private turnNumber = 0;
	private currentTurn: TurnCollector | null = null;
	private context: TurnTrackerContext = {};
	private unsubscribe: (() => void) | null = null;
	private samplingConfig: Partial<TailSamplingConfig>;
	private accumulatedUsage: Usage | null = null;

	constructor(
		private readonly agent: Agent,
		private readonly config: TurnTrackerConfig,
	) {
		this.samplingConfig = {
			...getSamplingConfigFromEnv(),
			...config.samplingConfig,
		};

		this.unsubscribe = agent.subscribe((event) => this.handleEvent(event));
	}

	/**
	 * Update the context for future turns.
	 * Call this when sandbox mode, MCP servers, or other context changes.
	 */
	updateContext(context: Partial<TurnTrackerContext>): void {
		this.context = { ...this.context, ...context };
	}

	/**
	 * Stop tracking and clean up subscription.
	 */
	dispose(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
	}

	/**
	 * Get the current turn number (0 if no turns have started).
	 */
	getTurnNumber(): number {
		return this.turnNumber;
	}

	private handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.startTurn(event.continuation === true);
				break;

			case "tool_execution_start":
				if (this.currentTurn && "toolCallId" in event && "toolName" in event) {
					this.currentTurn.recordToolStart(
						event.toolName,
						event.toolCallId,
						"input" in event && typeof event.input === "string"
							? event.input.length
							: undefined,
					);
				}
				break;

			case "tool_execution_end":
				if (this.currentTurn && "toolCallId" in event) {
					const success = !event.isError;
					const errorCode = event.isError
						? (event.errorCode?.slice(0, 50) ?? "error")
						: undefined;
					const outputSize =
						"output" in event && typeof event.output === "string"
							? event.output.length
							: undefined;

					this.currentTurn.recordToolEnd(
						event.toolCallId,
						success,
						outputSize,
						errorCode,
					);
				}
				break;

			case "message_start":
				if (this.currentTurn && event.message?.role === "assistant") {
					this.currentTurn.recordLlmStart();
				}
				break;

			case "message_end":
				if (this.currentTurn && event.message?.role === "assistant") {
					this.currentTurn.recordLlmEnd();
					// Accumulate usage from this message (turns may have multiple LLM calls)
					if ("message" in event && event.message && "usage" in event.message) {
						const usage = event.message.usage as Usage;
						if (this.accumulatedUsage) {
							// Add to existing totals
							this.accumulatedUsage = {
								input: this.accumulatedUsage.input + usage.input,
								output: this.accumulatedUsage.output + usage.output,
								cacheRead: this.accumulatedUsage.cacheRead + usage.cacheRead,
								cacheWrite: this.accumulatedUsage.cacheWrite + usage.cacheWrite,
								cost: {
									input: this.accumulatedUsage.cost.input + usage.cost.input,
									output: this.accumulatedUsage.cost.output + usage.cost.output,
									cacheRead:
										this.accumulatedUsage.cost.cacheRead + usage.cost.cacheRead,
									cacheWrite:
										this.accumulatedUsage.cost.cacheWrite +
										usage.cost.cacheWrite,
									total: this.accumulatedUsage.cost.total + usage.cost.total,
								},
							};
						} else {
							this.accumulatedUsage = usage;
						}
					}
				}
				break;

			case "agent_end":
				this.endTurn(event);
				break;
		}
	}

	private startTurn(isContinuation = false): void {
		if (!isContinuation || this.turnNumber === 0) {
			this.turnNumber++;
			this.accumulatedUsage = null;
		}

		this.currentTurn = new TurnCollector(
			this.config.sessionId,
			this.turnNumber,
			this.samplingConfig,
		);

		// Set model info from agent state
		const state = this.agent.state;
		this.currentTurn.setModel({
			id: state.model.id,
			provider: state.model.provider,
			thinkingLevel:
				state.thinkingLevel as CanonicalTurnEvent["model"]["thinkingLevel"],
		});

		// Set context from tracker
		if (this.context.sandboxMode) {
			this.currentTurn.setSandboxMode(this.context.sandboxMode);
		}
		if (this.context.approvalMode) {
			this.currentTurn.setApprovalMode(this.context.approvalMode);
		}
		if (this.context.mcpServers) {
			this.currentTurn.setMcpServers(this.context.mcpServers);
		}
		if (this.context.contextSourceCount !== undefined) {
			this.currentTurn.setContextSourceCount(this.context.contextSourceCount);
		}
		if (this.context.features) {
			this.currentTurn.setFeatures({
				safeMode: this.context.features.safeMode ?? false,
				guardianEnabled: this.context.features.guardianEnabled ?? true,
				compactionEnabled: this.context.features.compactionEnabled ?? true,
				hookCount: this.context.features.hookCount ?? 0,
			});
		}

		// Set message count
		this.currentTurn.setMessageCount(state.messages.length);
	}

	private endTurn(event: AgentEvent & { type: "agent_end" }): void {
		if (!this.currentTurn) {
			return;
		}

		// Determine status
		let status: CanonicalTurnEvent["status"] = "success";
		let abortReason: CanonicalTurnEvent["abortReason"] | undefined;
		let errorDetails: { category?: string; message?: string } | undefined;

		if ("aborted" in event && event.aborted) {
			status = "aborted";
			abortReason = "user";
		}

		// Check for error in agent state
		const agentError = this.agent.state.error;
		if (agentError) {
			status = "error";
			errorDetails = {
				category: "runtime",
				message:
					agentError.length > 200
						? `${agentError.slice(0, 200)}...`
						: agentError,
			};
		}

		// Extract token usage
		const tokens = {
			input: this.accumulatedUsage?.input ?? 0,
			output: this.accumulatedUsage?.output ?? 0,
			cacheRead: this.accumulatedUsage?.cacheRead ?? 0,
			cacheWrite: this.accumulatedUsage?.cacheWrite ?? 0,
			thinking:
				"thinking" in (this.accumulatedUsage ?? {})
					? (this.accumulatedUsage as { thinking?: number }).thinking
					: undefined,
		};

		const costUsd = this.accumulatedUsage?.cost?.total ?? 0;

		// Complete the turn
		const canonicalEvent = this.currentTurn.complete(
			status,
			tokens,
			costUsd,
			errorDetails,
			abortReason,
		);

		// Call the callback if provided
		if (this.config.onTurnComplete) {
			this.config.onTurnComplete(canonicalEvent);
		}

		this.currentTurn = null;
	}
}

/**
 * Create a TurnTracker for an agent.
 */
export function createTurnTracker(
	agent: Agent,
	config: TurnTrackerConfig,
): TurnTracker {
	return new TurnTracker(agent, config);
}
