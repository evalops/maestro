/**
 * RPC Mode - JSON-over-stdio protocol for programmatic agent control.
 *
 * Moved from main.ts. Provides a line-based JSON protocol for IDE integrations,
 * language servers, and other tools that embed Composer functionality.
 *
 * ## Protocol
 *
 * **Input (stdin)**: JSON objects, one per line
 * ```json
 * {"type": "prompt", "message": "Hello"}
 * {"type": "abort"}
 * {"type": "compact", "customInstructions": "Focus on..."}
 * ```
 *
 * **Output (stdout)**: Agent events as JSON objects, one per line
 *
 * @module cli/rpc-mode
 */

import type { Agent } from "../agent/agent.js";
import { buildCompactionHookContext } from "../agent/compaction-hooks.js";
import { performCompaction } from "../agent/compaction.js";
import {
	buildCompactionEvent,
	runWithPromptRecovery,
} from "../agent/prompt-recovery.js";
import type {
	AgentEvent,
	AppMessage,
	AssistantMessage,
} from "../agent/types.js";
import {
	createRenderableMessage,
	renderMessageToPlainText,
} from "../conversation/render-model.js";
import type { SessionManager } from "../session/manager.js";

/**
 * Run the CLI in RPC mode.
 *
 * The process runs indefinitely until stdin closes or it receives
 * a termination signal.
 */
export async function runRpcMode(
	agent: Agent,
	sessionManager: SessionManager,
): Promise<void> {
	// Subscribe to all events and emit as JSON for client consumption
	agent.subscribe((event) => {
		console.log(JSON.stringify(event));
	});

	// Set up JSON-over-stdin readline interface
	const readline = await import("node:readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	// Process incoming RPC commands line by line
	rl.on("line", async (line: string) => {
		try {
			const input = JSON.parse(line);

			if (input.type === "prompt" && input.message) {
				await runWithPromptRecovery({
					agent,
					sessionManager,
					hookContext: buildCompactionHookContext(
						sessionManager,
						process.cwd(),
					),
					execute: () => agent.prompt(input.message),
					callbacks: {
						onCompacted: (result) => {
							console.log(
								JSON.stringify(buildCompactionEvent(result, { auto: true })),
							);
						},
					},
				});
			} else if (input.type === "abort") {
				agent.abort();
			} else if (input.type === "get_messages") {
				console.log(
					JSON.stringify({
						type: "messages",
						messages: agent.state.messages,
					}),
				);
			} else if (input.type === "get_state") {
				console.log(
					JSON.stringify({
						type: "state",
						state: {
							model: agent.state.model,
							messages: agent.state.messages,
							isStreaming: agent.state.isStreaming,
							error: agent.state.error,
							thinkingLevel: agent.state.thinkingLevel,
							session: agent.state.session,
							queuedMessageCount: agent.getQueuedMessageCount(),
						},
					}),
				);
			} else if (input.type === "continue") {
				await runWithPromptRecovery({
					agent,
					sessionManager,
					hookContext: buildCompactionHookContext(
						sessionManager,
						process.cwd(),
					),
					execute: () => agent.continue(input.options),
					callbacks: {
						onCompacted: (result) => {
							console.log(
								JSON.stringify(buildCompactionEvent(result, { auto: true })),
							);
						},
					},
				});
			} else if (input.type === "compact") {
				const customInstructions = input.customInstructions as
					| string
					| undefined;

				const result = await performCompaction({
					agent,
					sessionManager,
					auto: false,
					trigger: "manual",
					hookContext: buildCompactionHookContext(
						sessionManager,
						process.cwd(),
					),
					customInstructions,
					renderSummaryText: (summary: AssistantMessage) => {
						const renderable = createRenderableMessage(summary as AppMessage);
						return renderable
							? renderMessageToPlainText(renderable).trim()
							: "";
					},
				});

				if (!result.success) {
					console.log(
						JSON.stringify({
							type: "error",
							error: result.error,
						}),
					);
					return;
				}

				// Emit compaction event
				const compactionEvent: AgentEvent = {
					type: "compaction",
					summary:
						result.summary ?? `Compacted ${result.compactedCount} messages`,
					firstKeptEntryIndex: result.firstKeptEntryIndex ?? 0,
					tokensBefore: result.tokensBefore ?? 0,
					auto: false,
					customInstructions,
					timestamp: new Date().toISOString(),
				};
				console.log(JSON.stringify(compactionEvent));
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(JSON.stringify({ type: "error", error: message }));
		}
	});

	// Keep process alive indefinitely - exits when stdin closes
	return new Promise(() => {});
}
