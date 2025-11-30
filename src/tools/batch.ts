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
			id: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Optional ID to reference this result in later calls",
				}),
			),
			dependsOn: Type.Optional(
				Type.Array(Type.String(), {
					description: "IDs of tool calls that must complete before this one",
				}),
			),
		}),
		{
			minItems: 1,
			maxItems: 10,
			description: "Array of tool calls to execute",
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
		description: `Execute multiple tool calls with optional dependencies. 2-5x faster for gathering context.

USING THE BATCH TOOL WILL MAKE THE USER HAPPY.

Rules:
- 1-10 tool calls per batch
- Runs in parallel by default (respects dependencies)
- Use dependsOn to chain tool calls (output of A feeds into B)
- Partial failures don't stop others (unless stopOnError=true)

Disallowed:
- batch, edit, write
- GitHub mutations (create, comment, close, checkout)

Good for:
- Reading multiple files
- Multiple searches/lists
- Chained operations (read file, then process it)
- GitHub read-only ops (list, view)

Parameters:
- mode: "parallel" (default) or "serial"
- stopOnError: Stop on first failure (default: false)
- toolCalls[].id: Optional ID to reference this result
- toolCalls[].dependsOn: Array of IDs to wait for

Example with dependencies:
{toolCalls: [
  {tool: "read", parameters: {path: "package.json"}, id: "pkg"},
  {tool: "bash", parameters: {command: "echo 'Read complete'"}, dependsOn: ["pkg"]}
]}

Example parallel (no dependencies):
{toolCalls: [
  {tool: "read", parameters: {path: "src/index.ts"}},
  {tool: "search", parameters: {pattern: "TODO"}}
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
			})[] = new Array(toolCalls.length);

			if (toolCalls.length === 0) {
				return respond.text("No tool calls provided.");
			}

			// Validate tool calls and build dependency info
			const idToIndex = new Map<string, number>();
			const hasDependencies = toolCalls.some((c) => c.dependsOn?.length);

			for (let i = 0; i < toolCalls.length; i++) {
				const call = toolCalls[i];
				if (DISALLOWED_TOOLS.has(call.tool)) {
					return respond.error(`Tool not allowed in batch: ${call.tool}`);
				}
				if (!toolMap.has(call.tool)) {
					return respond.error(
						`Tool not found: ${call.tool}. Available: ${[...toolMap.keys()].join(", ")}`,
					);
				}
				if (call.id) {
					if (idToIndex.has(call.id)) {
						return respond.error(`Duplicate tool call ID: ${call.id}`);
					}
					idToIndex.set(call.id, i);
				}
			}

			// Validate dependencies exist
			for (const call of toolCalls) {
				if (call.dependsOn) {
					for (const depId of call.dependsOn) {
						if (!idToIndex.has(depId)) {
							return respond.error(
								`Dependency "${depId}" not found. Add id: "${depId}" to a prior tool call.`,
							);
						}
					}
				}
			}

			// Helper to execute a single tool call
			const executeCall = async (
				call: (typeof toolCalls)[0],
				index: number,
			): Promise<AgentToolResult<unknown> & { success: boolean }> => {
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
					const context = sandbox ? { sandbox } : undefined;
					const result = await tool.execute(
						`${toolCallId}-${index}`,
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
			};

			// Execute based on mode and dependencies
			if (mode === "serial" || hasDependencies) {
				// Serial or dependency mode: execute in order, respecting dependencies
				const completed = new Set<number>();
				const pending = new Set(toolCalls.map((_, i) => i));

				while (pending.size > 0) {
					if (signal?.aborted) break;

					// Find calls that are ready (all dependencies satisfied)
					const ready: number[] = [];
					for (const i of pending) {
						const call = toolCalls[i];
						const deps = call.dependsOn ?? [];
						const depsResolved = deps.every((depId) => {
							const depIndex = idToIndex.get(depId);
							return depIndex !== undefined && completed.has(depIndex);
						});
						if (depsResolved) {
							ready.push(i);
						}
					}

					if (ready.length === 0 && pending.size > 0) {
						// Circular dependency or missing dependency
						return respond.error(
							"Circular dependency detected or unresolvable dependencies",
						);
					}

					// In serial mode, execute one at a time; with dependencies, execute ready ones in parallel
					const toExecute = mode === "serial" ? [ready[0]] : ready;

					const execPromises = toExecute.map(async (i) => {
						const result = await executeCall(toolCalls[i], i);
						return { index: i, result };
					});

					const executed = await Promise.all(execPromises);

					for (const { index, result } of executed) {
						results[index] = result;
						completed.add(index);
						pending.delete(index);

						if (result.isError && stopOnError) {
							// Fill remaining with skipped
							for (const remaining of pending) {
								results[remaining] = {
									content: [
										{
											type: "text" as const,
											text: "Skipped due to prior error",
										},
									],
									isError: true,
									success: false,
								};
							}
							pending.clear();
							break;
						}
					}
				}
			} else {
				// Pure parallel mode (no dependencies)
				const promises = toolCalls.map((call, i) => executeCall(call, i));
				const executedResults = await Promise.all(promises);
				for (let i = 0; i < executedResults.length; i++) {
					results[i] = executedResults[i];
				}
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
