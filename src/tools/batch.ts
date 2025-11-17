import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "../agent/types.js";
import { createTypeboxTool } from "./typebox-tool.js";

export interface BatchAgentTool extends AgentTool {
	setAvailableTools: (tools: AgentTool<any, any>[]) => void;
}

const DISALLOWED_TOOLS = new Set(["batch", "edit", "write"]);

const batchSchema = Type.Object({
	toolCalls: Type.Array(
		Type.Object({
			tool: Type.String({
				description: "The name of the tool to execute",
			}),
			parameters: Type.Record(Type.String(), Type.Any(), {
				description: "Parameters for the tool",
			}),
		}),
		{
			description: "Array of tool calls to execute in parallel (1-10 calls)",
			minItems: 1,
			maxItems: 10,
		},
	),
	toolTimeoutMs: Type.Optional(
		Type.Integer({
			description: "Per-tool timeout in milliseconds",
			minimum: 1_000,
			maximum: 300_000,
			default: 30_000,
		}),
	),
});

interface BatchToolContext {
	availableTools: Map<string, AgentTool<any, any>>;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

function buildToolMap(tools: AgentTool<any, any>[]): Map<string, AgentTool> {
	return new Map(tools.map((t) => [t.name, t]));
}

export function createBatchTool(
	availableTools: AgentTool<any, any>[],
): BatchAgentTool {
	let toolMap = buildToolMap(availableTools);

	const batchTool = createTypeboxTool({
		name: "batch",
		label: "batch",
		description: `Execute multiple independent tool calls in parallel to reduce latency. Best used for gathering context (reads, searches, listings).

USING THE BATCH TOOL WILL IMPROVE PERFORMANCE.

Rules:
- 1–10 tool calls per batch
- All calls start in parallel; ordering NOT guaranteed
- Partial failures do not stop others

Disallowed Tools:
- batch (no nesting)
- edit (run edits separately for safety)
- write (run writes separately for safety)

When NOT to Use:
- Operations that depend on prior tool output (e.g., write then read same file)
- Ordered stateful mutations where sequence matters

Good Use Cases:
- Read many files in parallel
- Multiple search/list operations
- Parallel bash introspection commands

Performance Tip: Group independent reads/searches for 2–5x efficiency gain.`,
		schema: batchSchema,
		async execute(_toolCallId, { toolCalls, toolTimeoutMs }, signal) {
			// Validate all tool calls before execution
			const validationErrors: string[] = [];
			const filteredToolCalls = toolCalls.slice(0, 10);
			const discardedCount = toolCalls.length - filteredToolCalls.length;
			const timeoutPerCall = toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

			for (const call of filteredToolCalls) {
				if (DISALLOWED_TOOLS.has(call.tool)) {
					validationErrors.push(
						`Tool '${call.tool}' is not allowed in batch. Disallowed tools: ${Array.from(DISALLOWED_TOOLS).join(", ")}`,
					);
				} else if (!toolMap.has(call.tool)) {
					const availableToolsList = Array.from(toolMap.keys()).filter(
						(name) => !DISALLOWED_TOOLS.has(name),
					);
					validationErrors.push(
						`Tool '${call.tool}' not found. Available tools: ${availableToolsList.join(", ")}`,
					);
				}
			}

			if (validationErrors.length > 0) {
				throw new Error(validationErrors.join("\n"));
			}

			// Execute all tool calls in parallel
			const executeCall = async (
				call: (typeof filteredToolCalls)[0],
				index: number,
			) => {
				const callStartTime = Date.now();
				const controller = new AbortController();
				let timeoutHandle: NodeJS.Timeout | undefined;
				let callTimedOut = false;

				if (signal) {
					if (signal.aborted) {
						controller.abort();
					} else {
						const abortListener = () => controller.abort();
						signal.addEventListener("abort", abortListener, { once: true });
						controller.signal.addEventListener(
							"abort",
							() => {
								signal.removeEventListener("abort", abortListener);
							},
							{ once: true },
						);
					}
				}

				if (timeoutPerCall > 0) {
					timeoutHandle = setTimeout(() => {
						callTimedOut = true;
						controller.abort();
					}, timeoutPerCall);
				}

				try {
					const tool = toolMap.get(call.tool);
					if (!tool) {
						throw new Error(`Tool '${call.tool}' not found`);
					}
					const result = await tool.execute(
						`batch-${_toolCallId}-${index}`,
						call.parameters,
						controller.signal,
					);

					return {
						success: true as const,
						tool: call.tool,
						result,
						duration: Date.now() - callStartTime,
					};
				} catch (error) {
					const errorMessage = callTimedOut
						? `Timed out after ${timeoutPerCall}ms`
						: error instanceof Error
							? error.message
							: String(error);
					return {
						success: false as const,
						tool: call.tool,
						error: errorMessage,
						duration: Date.now() - callStartTime,
					};
				} finally {
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
					}
				}
			};

			const results = await Promise.all(
				filteredToolCalls.map((call, index) => executeCall(call, index)),
			);

			// Build output summary
			const successfulCalls = results.filter((r) => r.success).length;
			const failedCalls = results.length - successfulCalls;

			const outputLines: string[] = [];

			// Add summary header
			if (failedCalls > 0) {
				outputLines.push(
					`Executed ${successfulCalls}/${results.length} tools successfully. ${failedCalls} failed.`,
				);
			} else {
				outputLines.push(
					`All ${successfulCalls} tools executed successfully.`,
					"",
					"Keep using the batch tool for optimal performance in your next response!",
				);
			}

			if (discardedCount > 0) {
				outputLines.push(
					"",
					`Note: ${discardedCount} tool call(s) exceeded the 10-tool limit and were discarded.`,
				);
			}

			// Add individual results
			outputLines.push("", "Results:");

			for (const result of results) {
				if (result.success) {
					const textContent = result.result.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("\n");
					const lines = textContent.split("\n").filter((line) => line.length);
					const previewLines = lines.slice(0, 5);
					const preview =
						lines.length > previewLines.length
							? `${previewLines.join("\n")}\n... (${lines.length - previewLines.length} more lines)`
							: previewLines.join("\n");

					outputLines.push(
						"",
						`✓ ${result.tool} (${result.duration}ms)`,
						preview
							.split("\n")
							.map((line) => `  ${line}`)
							.join("\n"),
					);
				} else {
					outputLines.push(
						"",
						`✗ ${result.tool} (${result.duration}ms)`,
						`  Error: ${result.error}`,
					);
				}
			}

			return {
				content: [{ type: "text", text: outputLines.join("\n") }],
				details: {
					totalCalls: results.length,
					successful: successfulCalls,
					failed: failedCalls,
					discarded: discardedCount,
					tools: filteredToolCalls.map((c) => c.tool),
					results: results.map((r, idx) => ({
						tool: r.tool,
						success: r.success,
						duration: r.duration,
						error: r.success ? undefined : r.error,
						summary: r.success
							? textSummary(filteredToolCalls[idx], r.result)
							: undefined,
						details: r.success ? r.result.details : undefined,
					})),
				},
			};
		},
	}) as BatchAgentTool;

	batchTool.setAvailableTools = (tools: AgentTool<any, any>[]) => {
		toolMap = buildToolMap(tools);
	};

	return batchTool;
}

function textSummary(
	_call: { tool: string; parameters: Record<string, unknown> },
	result: AgentToolResult<any>,
): string | undefined {
	const content = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	if (!content) return undefined;
	const lines = content.split(/\r?\n/).slice(0, 5);
	return lines.join("\n");
}

export const batchTool = createBatchTool([]);
