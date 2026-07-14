import type {
	AppMessage,
	ToolCall,
	ToolResultMessage,
} from "../agent/types.js";
import { canonicalCodexSubagentTool } from "../codex/subagent-workgraph.js";
import type { SessionTreeEntry } from "./types.js";

export interface AgentLineageOperation {
	edgeId: string;
	toolCallId: string;
	operation: string;
	status?: string;
	parentThreadId?: string;
	parentTurnId?: string;
	childThreadId?: string;
	childRunId: string;
	timestamp: string;
}

export interface AgentLineageEdge {
	edgeId: string;
	parentThreadId?: string;
	parentTurnId?: string;
	childThreadId?: string;
	childRunId: string;
	spawnToolCallId?: string;
	lastToolCallId: string;
	lastOperation: string;
	status?: string;
	updatedAt: string;
}

export interface AgentLineageProjection {
	edges: AgentLineageEdge[];
	operations: AgentLineageOperation[];
}

interface WorkGraphRecord {
	toolCallId: string;
	operation: string;
	status?: string;
	parentThreadId?: string;
	parentTurnId?: string;
	children: Array<{
		edgeId?: string;
		threadId?: string;
		childRunId: string;
		status?: string;
	}>;
}

interface WorkGraphFallback {
	toolCallId?: string;
	operation?: string;
}

export function buildAgentLineageProjection(
	entries: SessionTreeEntry[],
): AgentLineageProjection {
	const operations = new Map<string, AgentLineageOperation>();
	const edges = new Map<string, AgentLineageEdge>();

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		for (const graph of workGraphsFromMessage(entry.message)) {
			for (const child of graph.children) {
				const operationKey = `${graph.toolCallId}:${child.childRunId}`;
				const status = child.status ?? graph.status;
				const edgeId =
					child.edgeId ??
					`${graph.parentThreadId ?? "unknown-parent"}:${child.childRunId}`;
				operations.set(operationKey, {
					edgeId,
					toolCallId: graph.toolCallId,
					operation: graph.operation,
					status,
					parentThreadId: graph.parentThreadId,
					parentTurnId: graph.parentTurnId,
					childThreadId: child.threadId,
					childRunId: child.childRunId,
					timestamp: entry.timestamp,
				});

				const existing = edges.get(child.childRunId);
				edges.set(child.childRunId, {
					edgeId: existing?.edgeId ?? edgeId,
					parentThreadId: graph.parentThreadId ?? existing?.parentThreadId,
					parentTurnId: graph.parentTurnId ?? existing?.parentTurnId,
					childThreadId: child.threadId ?? existing?.childThreadId,
					childRunId: child.childRunId,
					spawnToolCallId:
						graph.operation === "spawnAgent"
							? graph.toolCallId
							: existing?.spawnToolCallId,
					lastToolCallId: graph.toolCallId,
					lastOperation: graph.operation,
					status,
					updatedAt: entry.timestamp,
				});
			}
		}
	}

	return { edges: [...edges.values()], operations: [...operations.values()] };
}

function workGraphsFromMessage(message: AppMessage): WorkGraphRecord[] {
	if (!isRecord(message)) return [];
	if (message.role === "assistant" && Array.isArray(message.content)) {
		return message.content
			.filter(isToolCall)
			.map((toolCall) =>
				parseWorkGraph(toolCall.arguments, {
					toolCallId: toolCall.id,
					operation: canonicalCodexSubagentTool(toolCall.name) ?? toolCall.name,
				}),
			)
			.filter((graph): graph is WorkGraphRecord => Boolean(graph));
	}
	if (message.role === "toolResult") {
		const result = message as unknown as ToolResultMessage;
		const graph = parseWorkGraph(result.details, {
			toolCallId: result.toolCallId,
			operation: canonicalCodexSubagentTool(result.toolName) ?? result.toolName,
		});
		return graph ? [graph] : [];
	}
	return [];
}

function parseWorkGraph(
	container: unknown,
	fallback: WorkGraphFallback = {},
): WorkGraphRecord | undefined {
	if (!isRecord(container)) return undefined;
	const graphValue = container.codexWorkGraph ?? container.codex_work_graph;
	if (!isRecord(graphValue)) return undefined;
	const toolCallId = stringValue(
		graphValue.toolCallId ?? graphValue.tool_call_id ?? fallback.toolCallId,
	);
	const operation = stringValue(
		graphValue.tool ?? graphValue.operation ?? fallback.operation,
	);
	const childrenValue = graphValue.childRuns ?? graphValue.child_runs;
	if (!toolCallId || !operation || !Array.isArray(childrenValue))
		return undefined;
	const parent = isRecord(graphValue.parent) ? graphValue.parent : {};
	const children = childrenValue
		.filter(isRecord)
		.map((child) => ({
			edgeId: stringValue(child.edgeId ?? child.edge_id),
			threadId: stringValue(child.threadId ?? child.thread_id),
			childRunId: stringValue(child.childRunId ?? child.child_run_id),
			status: stringValue(child.status),
		}))
		.filter((child): child is typeof child & { childRunId: string } =>
			Boolean(child.childRunId),
		);
	return {
		toolCallId,
		operation,
		status: stringValue(graphValue.status),
		parentThreadId: stringValue(
			parent.threadId ??
				parent.thread_id ??
				parent.senderThreadId ??
				parent.sender_thread_id,
		),
		parentTurnId: stringValue(parent.turnId ?? parent.turn_id),
		children,
	};
}

function isToolCall(value: unknown): value is ToolCall {
	return (
		isRecord(value) && value.type === "toolCall" && isRecord(value.arguments)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
