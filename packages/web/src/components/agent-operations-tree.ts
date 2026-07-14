import type { TrajectoryReplayLabTimelineItem } from "../services/api-client.types.js";

export interface AgentOperationsNode {
	runId: string;
	parentRunId?: string;
	status: string;
	latestItem: TrajectoryReplayLabTimelineItem;
	children: AgentOperationsNode[];
}

interface MutableAgentOperationsNode extends AgentOperationsNode {
	children: MutableAgentOperationsNode[];
}

function isLater(
	candidate: TrajectoryReplayLabTimelineItem,
	current: TrajectoryReplayLabTimelineItem,
): boolean {
	if (candidate.timestamp !== current.timestamp) {
		return candidate.timestamp > current.timestamp;
	}
	return candidate.id > current.id;
}

function updateNode(
	nodes: Map<string, MutableAgentOperationsNode>,
	runId: string,
	item: TrajectoryReplayLabTimelineItem,
	parentRunId?: string,
): MutableAgentOperationsNode {
	const current = nodes.get(runId);
	if (!current) {
		const created: MutableAgentOperationsNode = {
			runId,
			...(parentRunId && parentRunId !== runId ? { parentRunId } : {}),
			status: item.status ?? "unknown",
			latestItem: item,
			children: [],
		};
		nodes.set(runId, created);
		return created;
	}
	if (!current.parentRunId && parentRunId && parentRunId !== runId) {
		current.parentRunId = parentRunId;
	}
	if (isLater(item, current.latestItem)) {
		current.latestItem = item;
		current.status = item.status ?? "unknown";
	}
	return current;
}

function compareNodes(
	left: MutableAgentOperationsNode,
	right: MutableAgentOperationsNode,
): number {
	const timestamp = right.latestItem.timestamp.localeCompare(
		left.latestItem.timestamp,
	);
	return timestamp || left.runId.localeCompare(right.runId);
}

export function buildAgentOperationsTree(
	items: readonly TrajectoryReplayLabTimelineItem[],
): AgentOperationsNode[] {
	const nodes = new Map<string, MutableAgentOperationsNode>();
	for (const item of items) {
		if (item.agentRunId) {
			updateNode(nodes, item.agentRunId, item, item.parentAgentRunId);
		}
		if (item.childAgentRunId) {
			updateNode(
				nodes,
				item.childAgentRunId,
				item,
				item.parentAgentRunId ?? item.agentRunId,
			);
		}
	}

	const roots: MutableAgentOperationsNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentRunId ? nodes.get(node.parentRunId) : undefined;
		if (parent && parent !== node) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	for (const node of nodes.values()) node.children.sort(compareNodes);
	return roots.sort(compareNodes);
}
