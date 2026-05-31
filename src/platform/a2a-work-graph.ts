export interface A2ACodexSubagentEdgeMetadata {
	spawnToolCallId?: string;
	waitToolCallId?: string;
	childRunId?: string;
	threadId?: string;
	operation?: string;
	status?: string;
	role?: string;
	workItemState?: string;
	completionGate?: string;
	workItemId?: string;
}

export interface A2ACodexSubagentWorkGraphMetadata {
	toolCallIds: string[];
	childRunIds: string[];
	threadIds: string[];
	edgeCount?: number;
	edges?: A2ACodexSubagentEdgeMetadata[];
}

export interface A2AWorkGraphMetadata {
	state?: string;
	itemCount?: number;
	activeItemCount?: number;
	blockedItemCount?: number;
	waitingItemCount?: number;
	childRunCount?: number;
	childRunIds: string[];
	toolCallCount?: number;
	pendingToolCallCount?: number;
	toolExecutionIds: string[];
	waitItemCount?: number;
	waitIds: string[];
	stateCounts?: Record<string, number>;
	correlationPath?: string;
	codexSubagents?: A2ACodexSubagentWorkGraphMetadata;
}

export function extractA2AWorkGraphMetadata(
	task: { metadata?: Record<string, unknown> } | undefined,
): A2AWorkGraphMetadata | undefined {
	return normalizeA2AWorkGraphMetadata(task?.metadata?.workGraph);
}

export function normalizeA2AWorkGraphMetadata(
	input: unknown,
): A2AWorkGraphMetadata | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	const codexSubagents = normalizeCodexSubagents(input.codexSubagents);
	const stateCounts = normalizeNumberRecord(input.stateCounts);
	const graph: A2AWorkGraphMetadata = {
		...(stringValue(input.state) ? { state: stringValue(input.state) } : {}),
		...(numberValue(input.itemCount) !== undefined
			? { itemCount: numberValue(input.itemCount) }
			: {}),
		...(numberValue(input.activeItemCount) !== undefined
			? { activeItemCount: numberValue(input.activeItemCount) }
			: {}),
		...(numberValue(input.blockedItemCount) !== undefined
			? { blockedItemCount: numberValue(input.blockedItemCount) }
			: {}),
		...(numberValue(input.waitingItemCount) !== undefined
			? { waitingItemCount: numberValue(input.waitingItemCount) }
			: {}),
		...(numberValue(input.childRunCount) !== undefined
			? { childRunCount: numberValue(input.childRunCount) }
			: {}),
		childRunIds: stringList(input.childRunIds),
		...(numberValue(input.toolCallCount) !== undefined
			? { toolCallCount: numberValue(input.toolCallCount) }
			: {}),
		...(numberValue(input.pendingToolCallCount) !== undefined
			? { pendingToolCallCount: numberValue(input.pendingToolCallCount) }
			: {}),
		toolExecutionIds: stringList(input.toolExecutionIds),
		...(numberValue(input.waitItemCount) !== undefined
			? { waitItemCount: numberValue(input.waitItemCount) }
			: {}),
		waitIds: stringList(input.waitIds),
		...(stateCounts ? { stateCounts } : {}),
		...(stringValue(input.correlationPath)
			? { correlationPath: stringValue(input.correlationPath) }
			: {}),
		...(codexSubagents ? { codexSubagents } : {}),
	};
	return hasWorkGraphSignal(graph) ? graph : undefined;
}

export function formatA2AWorkGraphSummary(
	graph: A2AWorkGraphMetadata | undefined,
): string | undefined {
	if (!graph) {
		return undefined;
	}
	const parts = [
		graph.state,
		countPart("items", graph.itemCount),
		countPart("active", graph.activeItemCount),
		positiveCountPart("blocked", graph.blockedItemCount),
		positiveCountPart("waiting", graph.waitingItemCount),
		countPart("child runs", graph.childRunCount),
		countPart("tools", graph.toolCallCount),
		positiveCountPart("pending tools", graph.pendingToolCallCount),
		countPart("waits", graph.waitItemCount),
	].filter((part): part is string => Boolean(part));
	if (parts.length === 0) {
		return undefined;
	}
	return `Work graph: ${parts.join(" | ")}`;
}

export function formatA2AWorkGraphCodexSubagents(
	graph: A2AWorkGraphMetadata | undefined,
): string | undefined {
	const subagents = graph?.codexSubagents;
	if (!subagents) {
		return undefined;
	}
	const parts = [
		countPart("edges", subagents.edgeCount),
		edgeLifecyclePart(subagents.edges),
		idListPart("child runs", subagents.childRunIds),
		idListPart("tools", subagents.toolCallIds),
		idListPart("threads", subagents.threadIds),
	].filter((part): part is string => Boolean(part));
	if (parts.length === 0) {
		return undefined;
	}
	return `Codex subagents: ${parts.join(" | ")}`;
}

function normalizeCodexSubagents(
	input: unknown,
): A2ACodexSubagentWorkGraphMetadata | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	const edges = normalizeCodexSubagentEdges(input.edges);
	const subagents: A2ACodexSubagentWorkGraphMetadata = {
		toolCallIds: stringList(input.toolCallIds),
		childRunIds: stringList(input.childRunIds),
		threadIds: stringList(input.threadIds),
		...(numberValue(input.edgeCount) !== undefined
			? { edgeCount: numberValue(input.edgeCount) }
			: {}),
		...(edges.length > 0 ? { edges } : {}),
	};
	return subagents.toolCallIds.length > 0 ||
		subagents.childRunIds.length > 0 ||
		subagents.threadIds.length > 0 ||
		edges.length > 0 ||
		subagents.edgeCount !== undefined
		? subagents
		: undefined;
}

function normalizeCodexSubagentEdges(
	input: unknown,
): A2ACodexSubagentEdgeMetadata[] {
	if (!Array.isArray(input)) {
		return [];
	}
	const edges: A2ACodexSubagentEdgeMetadata[] = [];
	for (const value of input) {
		if (!isRecord(value)) {
			continue;
		}
		const edge: A2ACodexSubagentEdgeMetadata = {};
		const spawnToolCallId = stringValue(value.spawnToolCallId);
		const waitToolCallId = stringValue(value.waitToolCallId);
		const childRunId = stringValue(value.childRunId);
		const threadId = stringValue(value.threadId);
		const operation = stringValue(value.operation);
		const status = stringValue(value.status);
		const role = stringValue(value.role);
		const workItemState = stringValue(value.workItemState);
		const completionGate = stringValue(value.completionGate);
		const workItemId = stringValue(value.workItemId);
		if (spawnToolCallId) {
			edge.spawnToolCallId = spawnToolCallId;
		}
		if (waitToolCallId) {
			edge.waitToolCallId = waitToolCallId;
		}
		if (childRunId) {
			edge.childRunId = childRunId;
		}
		if (threadId) {
			edge.threadId = threadId;
		}
		if (operation) {
			edge.operation = operation;
		}
		if (status) {
			edge.status = status;
		}
		if (role) {
			edge.role = role;
		}
		if (workItemState) {
			edge.workItemState = workItemState;
		}
		if (completionGate) {
			edge.completionGate = completionGate;
		}
		if (workItemId) {
			edge.workItemId = workItemId;
		}
		if (
			!edge.spawnToolCallId &&
			!edge.waitToolCallId &&
			!edge.childRunId &&
			!edge.threadId
		) {
			continue;
		}
		if (
			!edges.some(
				(existing) =>
					existing.spawnToolCallId === edge.spawnToolCallId &&
					existing.waitToolCallId === edge.waitToolCallId &&
					existing.childRunId === edge.childRunId &&
					existing.threadId === edge.threadId &&
					existing.operation === edge.operation &&
					existing.status === edge.status,
			)
		) {
			edges.push(edge);
		}
	}
	return edges;
}

function normalizeNumberRecord(
	input: unknown,
): Record<string, number> | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	const entries = Object.entries(input)
		.map(([key, value]) => [key, numberValue(value)] as const)
		.filter((entry): entry is [string, number] => entry[1] !== undefined);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function hasWorkGraphSignal(graph: A2AWorkGraphMetadata): boolean {
	return Boolean(
		graph.state ||
			graph.itemCount !== undefined ||
			graph.activeItemCount !== undefined ||
			graph.blockedItemCount !== undefined ||
			graph.waitingItemCount !== undefined ||
			graph.childRunCount !== undefined ||
			graph.childRunIds.length > 0 ||
			graph.toolCallCount !== undefined ||
			graph.pendingToolCallCount !== undefined ||
			graph.toolExecutionIds.length > 0 ||
			graph.waitItemCount !== undefined ||
			graph.waitIds.length > 0 ||
			graph.stateCounts ||
			graph.correlationPath ||
			graph.codexSubagents,
	);
}

function countPart(
	label: string,
	value: number | undefined,
): string | undefined {
	return value === undefined ? undefined : `${label} ${value}`;
}

function positiveCountPart(
	label: string,
	value: number | undefined,
): string | undefined {
	return value && value > 0 ? `${label} ${value}` : undefined;
}

function idListPart(
	label: string,
	values: readonly string[],
): string | undefined {
	if (values.length === 0) {
		return undefined;
	}
	const visible = values.slice(0, 3).join(", ");
	const hidden = values.length > 3 ? ` (+${values.length - 3} more)` : "";
	return `${label} ${visible}${hidden}`;
}

function edgeLifecyclePart(
	edges: readonly A2ACodexSubagentEdgeMetadata[] | undefined,
): string | undefined {
	if (!edges || edges.length === 0) {
		return undefined;
	}
	const values = edges
		.map(formatCodexSubagentEdge)
		.filter((value): value is string => Boolean(value));
	if (values.length === 0) {
		return undefined;
	}
	const visible = values.slice(0, 3).join(", ");
	const hidden = values.length > 3 ? ` (+${values.length - 3} more)` : "";
	return `lifecycle ${visible}${hidden}`;
}

function formatCodexSubagentEdge(
	edge: A2ACodexSubagentEdgeMetadata,
): string | undefined {
	const lifecycle = [edge.operation, edge.status].filter(Boolean).join(":");
	const subject =
		edge.childRunId ??
		edge.threadId ??
		edge.spawnToolCallId ??
		edge.waitToolCallId;
	if (!lifecycle) {
		return subject;
	}
	return subject ? `${lifecycle}(${subject})` : lifecycle;
}

function stringList(input: unknown): string[] {
	if (!Array.isArray(input)) {
		return [];
	}
	const values: string[] = [];
	for (const value of input) {
		const text = stringValue(value);
		if (text && !values.includes(text)) {
			values.push(text);
		}
	}
	return values;
}

function stringValue(input: unknown): string | undefined {
	return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function numberValue(input: unknown): number | undefined {
	if (typeof input === "number" && Number.isFinite(input)) {
		return input;
	}
	if (typeof input !== "string" || !input.trim()) {
		return undefined;
	}
	const parsed = Number(input);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
