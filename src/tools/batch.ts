import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "../agent/types.js";
import { createTool } from "./tool-dsl.js";

export interface BatchAgentTool extends AgentTool {
	setAvailableTools: (tools: AgentTool[]) => void;
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
	mode: Type.Optional(
		Type.Union([Type.Literal("parallel"), Type.Literal("serial")], {
			description: "Execution mode (parallel or serial)",
			default: "parallel",
		}),
	),
	stopOnError: Type.Optional(
		Type.Boolean({
			description:
				"Stop execution on first error (only applies to serial mode). Remaining calls are skipped.",
			default: false,
		}),
	),
});

interface BatchToolContext {
	availableTools: Map<string, AgentTool>;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

type BatchToolDetails = {
	totalCalls: number;
	successful: number;
	failed: number;
	discarded: number;
	skipped: number;
	tools: string[];
	results: Array<{
		tool: string;
		success: boolean;
		duration: number;
		error?: string;
		summary?: string;
		details?: unknown;
	}>;
};

function buildToolMap(tools: AgentTool[]): Map<string, AgentTool> {
	return new Map(tools.map((t) => [t.name, t]));
}

export function createBatchTool(availableTools: AgentTool[]): BatchAgentTool {
	let toolMap = buildToolMap(availableTools);

	const batchTool = createTool<typeof batchSchema, BatchToolDetails>({
		name: "batch",
		label: "batch",
		description: `Execute multiple independent tool calls in parallel. 2-5x faster for gathering context.

USING THE BATCH TOOL WILL MAKE THE USER HAPPY.

Rules:
- 1-10 tool calls per batch
- Runs in parallel (set mode="serial" if order matters)
- Partial failures don't stop others (unless stopOnError=true in serial mode)

Disallowed:
- batch, edit, write
- GitHub mutations (create, comment, close, checkout)

When NOT to use:
- Operations depending on prior output
- Sequential workflows

Good for:
- Reading multiple files
- Multiple searches/lists
- Parallel bash commands (git status, npm list)
- GitHub read-only ops (list, view)

Parameters:
- mode: "parallel" (default) or "serial"
- stopOnError: Stop on first failure in serial mode (default: false)

Example:
{toolCalls: [
  {tool: "read", parameters: {path: "src/index.ts"}},
  {tool: "search", parameters: {pattern: "TODO"}},
  {tool: "bash", parameters: {command: "git status"}}
]}`,
		schema: batchSchema,
		async run(
			{ toolCalls, toolTimeoutMs, mode = "parallel", stopOnError = false },
			{ signal, respond, toolCallId },
		) {
			// Validate stopOnError is only used with serial mode
			if (stopOnError && mode !== "serial") {
				throw new Error(
					"stopOnError can only be used with mode: 'serial'. In parallel mode, all calls execute simultaneously.",
				);
			}

			// Validate all tool calls before execution
			const validationErrors: string[] = [];
			const filteredToolCalls = toolCalls.slice(0, 10);
			const discardedCount = toolCalls.length - filteredToolCalls.length;
			const timeoutPerCall = toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
			const executionMode = mode === "serial" ? "serial" : "parallel";

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
						`batch-${toolCallId}-${index}`,
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

			const results: Array<Awaited<ReturnType<typeof executeCall>>> = [];
			let skippedCount = 0;
			if (executionMode === "serial") {
				for (const [index, call] of filteredToolCalls.entries()) {
					if (signal?.aborted) {
						break;
					}
					const result = await executeCall(call, index);
					results.push(result);
					if (!result.success && stopOnError) {
						// Skip remaining calls
						skippedCount = filteredToolCalls.length - index - 1;
						break;
					}
				}
			} else {
				const parallelResults = await Promise.all(
					filteredToolCalls.map((call, index) => executeCall(call, index)),
				);
				results.push(...parallelResults);
			}

			// Build output summary
			const previewInfos = results.map((r) =>
				r.success ? buildPreview(r.result) : undefined,
			);

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

			if (skippedCount > 0) {
				outputLines.push(
					"",
					`Note: ${skippedCount} tool call(s) skipped due to stopOnError=true.`,
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

			for (const [index, result] of results.entries()) {
				if (result.success) {
					const previewInfo = previewInfos[index];
					const previewText = previewInfo?.previewText ?? "(no text output)";

					outputLines.push(
						"",
						`[OK] ${result.tool} (${result.duration}ms)`,
						previewText
							.split("\n")
							.map((line) => `  ${line}`)
							.join("\n"),
					);
				} else {
					outputLines.push(
						"",
						`[ERROR] ${result.tool} (${result.duration}ms)`,
						`  Error: ${result.error}`,
					);
				}
			}

			return respond.text(outputLines.join("\n")).detail({
				totalCalls: results.length,
				successful: successfulCalls,
				failed: failedCalls,
				discarded: discardedCount,
				skipped: skippedCount,
				tools: results.map((r) => r.tool),
				results: results.map((r, index) => {
					const preview = previewInfos[index];
					return {
						tool: r.tool,
						success: r.success,
						duration: r.duration,
						error: r.success ? undefined : r.error,
						summary: r.success ? preview?.summaryText : undefined,
						details: r.success ? r.result.details : undefined,
					};
				}),
			});
		},
	}) as BatchAgentTool;

	batchTool.setAvailableTools = (tools: AgentTool[]) => {
		toolMap = buildToolMap(tools);
	};

	return batchTool;
}

function extractSummaryFromDetails(details: unknown): string | undefined {
	if (!details || typeof details !== "object") {
		return undefined;
	}
	const summary = (details as Record<string, unknown>).summary;
	if (typeof summary === "string" && summary.trim().length > 0) {
		return summary.trim();
	}
	return undefined;
}

function buildPreview(result: AgentToolResult<any>): {
	previewText: string;
	summaryText?: string;
} {
	const summaryFromDetails = extractSummaryFromDetails(result.details);
	if (summaryFromDetails) {
		return { previewText: summaryFromDetails, summaryText: summaryFromDetails };
	}
	const textContent = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	if (!textContent) {
		return { previewText: "(no text output)", summaryText: undefined };
	}
	const lines = textContent.split(/\r?\n/).filter((line) => line.length);
	const previewLines = lines.slice(0, 5);
	const basePreview = previewLines.join("\n") || textContent;
	const previewText =
		lines.length > previewLines.length
			? `${basePreview}\n... (${lines.length - previewLines.length} more lines)`
			: basePreview;
	return {
		previewText,
		summaryText: basePreview,
	};
}

export const batchTool = createBatchTool([]);
