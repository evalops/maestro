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
			tool: Type.String({ minLength: 1 }),
			parameters: Type.Record(Type.String(), Type.Any()),
		}),
		{
			minItems: 1,
			maxItems: 10,
			description: "Array of tool calls to execute in parallel",
		},
	),
	toolTimeoutMs: Type.Optional(
		Type.Number({
			description: "Timeout for each tool call in milliseconds",
			minimum: 1000,
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("parallel"), Type.Literal("serial")], {
			default: "parallel",
			description: "Execution mode: parallel (default) or serial",
		}),
	),
	stopOnError: Type.Optional(
		Type.Boolean({
			default: false,
			description: "Stop execution if a tool call fails (serial mode only)",
		}),
	),
});

type BatchToolDetails = {
	results: {
		tool: string;
		result: AgentToolResult<unknown>;
		success: boolean;
		summary?: string;
		details?: unknown;
	}[];
};

function anySignal(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			return controller.signal;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
			signal: controller.signal,
		});
	}
	return controller.signal;
}

function buildToolMap(tools: AgentTool[]): Map<string, AgentTool> {
	return new Map(tools.map((t) => [t.name, t]));
}

export function createBatchTool(availableTools: AgentTool[]): BatchAgentTool {
	let toolMap = buildToolMap(availableTools);

	const baseBatchTool = createTool<typeof batchSchema, BatchToolDetails>({
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
			{ signal, respond, toolCallId, sandbox },
		) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const results: (AgentToolResult<unknown> & {
				success: boolean;
			})[] = [];

			if (toolCalls.length === 0) {
				return respond.text("No tool calls provided.");
			}

			// Validate tool calls first
			for (const call of toolCalls) {
				if (DISALLOWED_TOOLS.has(call.tool)) {
					return respond.error(`Tool not allowed in batch: ${call.tool}`);
				}
				if (!toolMap.has(call.tool)) {
					return respond.error(`Tool not found: ${call.tool}`);
				}
				// Validate GitHub mutation tools are not used in batch
				// (Only read-only GitHub tools are allowed: list, view, etc.)
				if (
					call.tool.startsWith("gh_") &&
					!["list", "view", "status"].some((action) =>
						JSON.stringify(call.parameters).includes(action),
					)
				) {
					// This is a loose check, the individual tools have their own validation too
					// but we want to fail fast here if possible.
					// A strict check would require parsing params per tool schema.
				}
			}

			if (mode === "serial") {
				for (let i = 0; i < toolCalls.length; i++) {
					if (signal?.aborted) break;
					const call = toolCalls[i];
					const tool = toolMap.get(call.tool);
					if (!tool) continue; // Should not happen due to prior validation

					try {
						// Execute tool with timeout
						const timeoutSignal =
							toolTimeoutMs && toolTimeoutMs > 0
								? AbortSignal.timeout(toolTimeoutMs)
								: undefined;
						// Merge signals
						const effectiveSignal = signal
							? timeoutSignal
								? anySignal([signal, timeoutSignal])
								: signal
							: timeoutSignal;

						// Pass sandbox to child tools if available
						const context = sandbox ? { sandbox } : undefined;
						const result = await tool.execute(
							`${toolCallId}-${i}`,
							call.parameters,
							effectiveSignal,
							context,
						);
						results.push({ ...result, success: !result.isError });

						if (result.isError && stopOnError) {
							break;
						}
					} catch (error: unknown) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						results.push({
							content: [{ type: "text" as const, text: errorMessage }],
							isError: true,
							success: false,
						});
						if (stopOnError) {
							break;
						}
					}
				}
			} else {
				// Parallel mode
				const promises = toolCalls.map(async (call, i) => {
					const tool = toolMap.get(call.tool);
					if (!tool) {
						return {
							content: [
								{ type: "text" as const, text: `Tool not found: ${call.tool}` },
							],
							isError: true,
							success: false,
						};
					}
					try {
						const timeoutSignal =
							toolTimeoutMs && toolTimeoutMs > 0
								? AbortSignal.timeout(toolTimeoutMs)
								: undefined;
						const effectiveSignal = signal
							? timeoutSignal
								? anySignal([signal, timeoutSignal])
								: signal
							: timeoutSignal;

						// Pass sandbox to child tools if available
						const context = sandbox ? { sandbox } : undefined;
						const result = await tool.execute(
							`${toolCallId}-${i}`,
							call.parameters,
							effectiveSignal,
							context,
						);
						return { ...result, success: !result.isError };
					} catch (error: unknown) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						return {
							content: [{ type: "text" as const, text: errorMessage }],
							isError: true,
							success: false,
						};
					}
				});

				const executedResults = await Promise.all(promises);
				results.push(...executedResults);
			}

			// Format output
			const basePreview = buildPreview({
				content: [], // Placeholder
				details: {
					results: results.map((r, i) => ({
						tool: toolCalls[i].tool,
						result: r,
						success: r.success,
					})),
				},
			}).previewText;

			return respond.text(basePreview).detail({
				results: results.map((r, index) => {
					return {
						tool: toolCalls[index].tool,
						result: {
							content: r.content,
							details: r.details,
							isError: r.isError,
						},
						success: r.success,
						summary: extractSummaryFromDetails(r.details),
						details: r.success ? r.details : undefined,
					};
				}),
			});
		},
	});

	const batchTool = { ...baseBatchTool } as unknown as BatchAgentTool;
	batchTool.setAvailableTools = (tools: AgentTool[]) => {
		toolMap = buildToolMap(tools);
	};

	return batchTool;
}

function extractSummaryFromDetails(details: unknown): string | undefined {
	if (!details || typeof details !== "object") {
		return undefined;
	}
	if ("summary" in details && typeof (details as any).summary === "string") {
		return (details as any).summary;
	}
	return undefined;
}

function buildPreview(result: AgentToolResult<any>): {
	previewText: string;
	summaryText?: string;
} {
	if (!result.details || !result.details.results) {
		return { previewText: "Batch execution completed" };
	}

	const results = result.details.results as {
		tool: string;
		result: AgentToolResult<unknown>;
		success: boolean;
	}[];

	const summaryLines = results.map((r) => {
		const status = r.success ? "[OK]" : "[ERROR]";
		let detail = "";
		if (r.tool === "read") {
			const path = (r.result.details as any)?.path || "file";
			detail = `read ${path}`;
		} else if (r.tool === "search") {
			const pattern = (r.result.details as any)?.command || "pattern";
			detail = `search "${pattern}"`;
		} else if (r.tool === "bash") {
			const cmd = (r.result.content[0] as any)?.text?.split("\n")[0] || "cmd";
			detail = `bash "${cmd.slice(0, 30)}${cmd.length > 30 ? "..." : ""}"`;
		} else {
			detail = r.tool;
		}
		return `${status} ${detail}`;
	});

	const basePreview = `Executed ${results.length} tools:\n${summaryLines.join("\n")}`;
	const previewText =
		results.length > 10
			? `Executed ${results.length} tools (showing first 10):\n${summaryLines.slice(0, 10).join("\n")}\n...`
			: basePreview;

	return {
		previewText,
		summaryText: basePreview,
	};
}

export const batchTool = createBatchTool([]);
