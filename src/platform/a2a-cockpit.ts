import { type A2AFleetSummary, inspectA2AFleet } from "./a2a-fleet.js";
import {
	type A2AOwnershipScope,
	hasA2AOwnershipRecordMarkers,
	hasA2AOwnershipScope,
	matchesA2AOwnershipScope,
} from "./a2a-ownership.js";
import {
	type A2ATaskLedgerEntry,
	type A2ATaskLedgerFile,
	isActionRequiredA2AState,
	isFinalA2AState,
	isTerminalA2AState,
	listA2ATaskEntries,
	loadA2ATaskLedger,
} from "./a2a-task-ledger.js";
import type { A2AWorkGraphMetadata } from "./a2a-work-graph.js";

export type A2ACockpitTaskStatus =
	| "waiting"
	| "running"
	| "completed"
	| "failed"
	| "unknown";

export type A2ACockpitNextActionSeverity = "info" | "warning" | "critical";

export interface A2ACockpitOptions {
	registryPath?: string;
	tasksPath?: string;
	timeoutMs?: number;
	peer?: string;
	limit?: number;
	ownershipScope?: A2AOwnershipScope;
}

export interface A2ACockpitSummary {
	generatedAt: string;
	registryPath: string;
	tasksPath: string;
	peer?: string;
	counts: A2ACockpitCounts;
	peers: A2ACockpitPeerSummary[];
	tasks: A2ACockpitTaskSummary[];
	nextActions: A2ACockpitNextAction[];
}

export interface A2ACockpitCounts {
	peers: number;
	onlinePeers: number;
	unreachablePeers: number;
	tasks: number;
	runningTasks: number;
	actionRequiredTasks: number;
	failedTasks: number;
	completedTasks: number;
}

export interface A2ACockpitPeerSummary {
	name: string;
	displayName?: string;
	url: string;
	status: "online" | "unreachable";
	error?: string;
	auth?: string;
	model?: string;
	cwd?: string;
	taskCounts: Pick<
		A2ACockpitCounts,
		| "tasks"
		| "runningTasks"
		| "actionRequiredTasks"
		| "failedTasks"
		| "completedTasks"
	>;
	lastTask?: {
		id: string;
		state: string;
		status: A2ACockpitTaskStatus;
		updatedAt: string;
		text: string;
	};
}

export interface A2ACockpitTaskSummary {
	ledgerId: string;
	peer: string;
	peerDisplayName?: string;
	orphanedPeer?: boolean;
	taskId: string;
	state: string;
	status: A2ACockpitTaskStatus;
	requiresInput: boolean;
	terminal: boolean;
	final: boolean;
	text: string;
	responseText?: string;
	updatedAt: string;
	completedAt?: string;
	workGraph?: A2AWorkGraphMetadata;
	nextCommand?: string;
}

export interface A2ACockpitNextAction {
	id: string;
	label: string;
	command: string;
	severity: A2ACockpitNextActionSeverity;
	peer: string;
	taskId?: string;
	reason: string;
}

export interface SummarizeA2ACockpitInput {
	fleet: A2AFleetSummary;
	ledger: A2ATaskLedgerFile;
	peer?: string;
	limit?: number;
	generatedAt?: string;
	ownershipScope?: A2AOwnershipScope;
}

export async function buildA2ACockpit(
	options: A2ACockpitOptions = {},
): Promise<A2ACockpitSummary> {
	if (!hasA2AOwnershipScope(options.ownershipScope)) {
		return buildA2ACockpitUnscoped(options);
	}
	const ledger = await loadA2ATaskLedger({ path: options.tasksPath });
	const scopedLedger = filterLedgerForOwnership(ledger, options.ownershipScope);
	const fleet = await inspectA2AFleet({
		registryPath: options.registryPath,
		tasksPath: options.tasksPath,
		timeoutMs: options.timeoutMs,
		ownershipScope: options.ownershipScope,
		includePeerNames: scopedLedger.tasks.map((task) => task.peer),
	});
	return summarizeA2ACockpit({
		fleet,
		ledger: scopedLedger,
		peer: options.peer,
		limit: options.limit,
		ownershipScope: options.ownershipScope,
	});
}

async function buildA2ACockpitUnscoped(
	options: A2ACockpitOptions,
): Promise<A2ACockpitSummary> {
	const [fleet, ledger] = await Promise.all([
		inspectA2AFleet({
			registryPath: options.registryPath,
			tasksPath: options.tasksPath,
			timeoutMs: options.timeoutMs,
		}),
		loadA2ATaskLedger({ path: options.tasksPath }),
	]);
	return summarizeA2ACockpit({
		fleet,
		ledger,
		peer: options.peer,
		limit: options.limit,
	});
}

export function summarizeA2ACockpit(
	input: SummarizeA2ACockpitInput,
): A2ACockpitSummary {
	const peerFilter = cleanPeer(input.peer);
	const limit = normalizeLimit(input.limit);
	const scopedLedger = filterLedgerForOwnership(
		input.ledger,
		input.ownershipScope,
	);
	const scopedTaskPeerNames = new Set(
		scopedLedger.tasks.map((task) => task.peer),
	);
	const peers = input.fleet.peers
		.filter(
			(peer) =>
				matchesA2AOwnershipScope(peer, input.ownershipScope) ||
				scopedTaskPeerNames.has(peer.name),
		)
		.filter((peer) => !peerFilter || peer.name === peerFilter)
		.map((peer) => summarizePeer(peer, scopedLedger));
	const registeredPeerNames = new Set(peers.map((peer) => peer.name));
	const tasks = listA2ATaskEntries(scopedLedger, { peer: peerFilter })
		.map((task) => summarizeTask(task, registeredPeerNames))
		.sort(compareTasksForCockpit);
	const limitedTasks = tasks.slice(0, limit);
	const counts = summarizeCounts(peers, tasks);
	return {
		generatedAt: input.generatedAt ?? input.fleet.generatedAt,
		registryPath: input.fleet.registryPath,
		tasksPath: input.fleet.tasksPath,
		...(peerFilter ? { peer: peerFilter } : {}),
		counts,
		peers,
		tasks: limitedTasks,
		nextActions: summarizeNextActions(peers, tasks, limit),
	};
}

function filterLedgerForOwnership(
	ledger: A2ATaskLedgerFile,
	scope: A2AOwnershipScope | undefined,
): A2ATaskLedgerFile {
	return {
		tasks: ledger.tasks.filter((entry) =>
			hasA2AOwnershipRecordMarkers(entry)
				? matchesA2AOwnershipScope(entry, scope)
				: true,
		),
	};
}

function summarizePeer(
	peer: A2AFleetSummary["peers"][number],
	ledger: A2ATaskLedgerFile,
): A2ACockpitPeerSummary {
	const tasks = listA2ATaskEntries(ledger, { peer: peer.name }).map((task) =>
		summarizeTask(task),
	);
	const lastTask = tasks[0];
	return {
		name: peer.name,
		...(peer.displayName ? { displayName: peer.displayName } : {}),
		url: peer.url,
		status: peer.status,
		...(peer.error ? { error: peer.error } : {}),
		...(peer.auth ? { auth: peer.auth } : {}),
		...(peer.model ? { model: peer.model } : {}),
		...(peer.cwd ? { cwd: peer.cwd } : {}),
		taskCounts: {
			tasks: tasks.length,
			runningTasks: tasks.filter((task) => task.status === "running").length,
			actionRequiredTasks: tasks.filter((task) => task.status === "waiting")
				.length,
			failedTasks: tasks.filter((task) => task.status === "failed").length,
			completedTasks: tasks.filter((task) => task.status === "completed")
				.length,
		},
		...(lastTask
			? {
					lastTask: {
						id: lastTask.taskId,
						state: lastTask.state,
						status: lastTask.status,
						updatedAt: lastTask.updatedAt,
						text: lastTask.text,
					},
				}
			: {}),
	};
}

function summarizeTask(
	entry: A2ATaskLedgerEntry,
	registeredPeerNames?: ReadonlySet<string>,
): A2ACockpitTaskSummary {
	const status = classifyTaskState(entry.state);
	const requiresInput = isActionRequiredA2AState(entry.state);
	const terminal = isTerminalA2AState(entry.state);
	const final = isFinalA2AState(entry.state);
	const orphanedPeer =
		registeredPeerNames !== undefined && !registeredPeerNames.has(entry.peer);
	const nextCommand = orphanedPeer ? undefined : taskCommand(entry, status);
	return {
		ledgerId: entry.id,
		peer: entry.peer,
		...(entry.peerDisplayName
			? { peerDisplayName: entry.peerDisplayName }
			: {}),
		...(orphanedPeer ? { orphanedPeer: true } : {}),
		taskId: entry.taskId,
		state: entry.state,
		status,
		requiresInput,
		terminal,
		final,
		text: entry.text,
		...(entry.responseText ? { responseText: entry.responseText } : {}),
		updatedAt: entry.updatedAt,
		...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
		...(entry.workGraph ? { workGraph: entry.workGraph } : {}),
		...(nextCommand ? { nextCommand } : {}),
	};
}

function summarizeCounts(
	peers: A2ACockpitPeerSummary[],
	tasks: A2ACockpitTaskSummary[],
): A2ACockpitCounts {
	return {
		peers: peers.length,
		onlinePeers: peers.filter((peer) => peer.status === "online").length,
		unreachablePeers: peers.filter((peer) => peer.status === "unreachable")
			.length,
		tasks: tasks.length,
		runningTasks: tasks.filter((task) => task.status === "running").length,
		actionRequiredTasks: tasks.filter((task) => task.status === "waiting")
			.length,
		failedTasks: tasks.filter((task) => task.status === "failed").length,
		completedTasks: tasks.filter((task) => task.status === "completed").length,
	};
}

function summarizeNextActions(
	peers: A2ACockpitPeerSummary[],
	tasks: A2ACockpitTaskSummary[],
	limit: number,
): A2ACockpitNextAction[] {
	const actions = tasks
		.map((task) => nextActionForTask(task))
		.filter((action): action is A2ACockpitNextAction => Boolean(action))
		.slice(0, limit);
	if (actions.length > 0) {
		return actions;
	}
	return peers
		.filter(
			(peer) => peer.status === "online" && peer.taskCounts.runningTasks === 0,
		)
		.slice(0, limit)
		.map((peer) => ({
			id: `delegate:${peer.name}`,
			label: `Delegate fresh work to ${peer.name}`,
			command: `maestro a2a delegate ${shellQuote(peer.name)} <objective> --wait --work-graph`,
			severity: "info",
			peer: peer.name,
			reason:
				"Peer is reachable and has no active local A2A task in the ledger.",
		}));
}

function nextActionForTask(
	task: A2ACockpitTaskSummary,
): A2ACockpitNextAction | undefined {
	if (task.orphanedPeer) {
		return undefined;
	}
	if (task.status === "waiting") {
		return {
			id: `reply:${task.peer}:${task.taskId}`,
			label: `Reply to ${task.peer} task ${task.taskId}`,
			command: `maestro a2a reply ${shellQuote(task.peer)} ${shellQuote(task.taskId)} <response> --wait --work-graph`,
			severity: "critical",
			peer: task.peer,
			taskId: task.taskId,
			reason: "Peer returned an input-required or auth-required A2A state.",
		};
	}
	if (task.status === "running") {
		return {
			id: `wait:${task.peer}:${task.taskId}`,
			label: `Wait for ${task.peer} task ${task.taskId}`,
			command:
				task.nextCommand ??
				`maestro a2a wait ${shellQuote(task.peer)} ${shellQuote(task.taskId)} --work-graph`,
			severity: "info",
			peer: task.peer,
			taskId: task.taskId,
			reason: "Task is still non-terminal in the local A2A ledger.",
		};
	}
	if (task.status === "failed") {
		return {
			id: `refresh:${task.peer}:${task.taskId}`,
			label: `Refresh failed ${task.peer} task ${task.taskId}`,
			command: `maestro a2a tasks ${shellQuote(task.peer)} --refresh --work-graph`,
			severity: "warning",
			peer: task.peer,
			taskId: task.taskId,
			reason: "Task reached a failed, rejected, or canceled final state.",
		};
	}
	return undefined;
}

function taskCommand(
	entry: A2ATaskLedgerEntry,
	status: A2ACockpitTaskStatus,
): string | undefined {
	if (status === "waiting") {
		return `maestro a2a reply ${shellQuote(entry.peer)} ${shellQuote(entry.taskId)} <response> --wait --work-graph`;
	}
	if (status === "running") {
		return `maestro a2a wait ${shellQuote(entry.peer)} ${shellQuote(entry.taskId)} --work-graph`;
	}
	return undefined;
}

function classifyTaskState(state: string): A2ACockpitTaskStatus {
	const normalized = normalizeState(state);
	if (!normalized) {
		return "unknown";
	}
	if (isActionRequiredA2AState(normalized)) {
		return "waiting";
	}
	if (normalized.includes("COMPLETED")) {
		return "completed";
	}
	if (
		normalized.includes("FAILED") ||
		normalized.includes("REJECTED") ||
		normalized.includes("CANCELED") ||
		normalized.includes("CANCELLED")
	) {
		return "failed";
	}
	if (!isFinalA2AState(normalized)) {
		return "running";
	}
	return "unknown";
}

function compareTasksForCockpit(
	left: A2ACockpitTaskSummary,
	right: A2ACockpitTaskSummary,
): number {
	const urgency = taskUrgency(right.status) - taskUrgency(left.status);
	if (urgency !== 0) {
		return urgency;
	}
	return right.updatedAt.localeCompare(left.updatedAt);
}

function taskUrgency(status: A2ACockpitTaskStatus): number {
	switch (status) {
		case "waiting":
			return 4;
		case "failed":
			return 3;
		case "running":
			return 2;
		case "unknown":
			return 1;
		case "completed":
			return 0;
	}
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return 8;
	}
	if (!Number.isFinite(limit) || limit <= 0) {
		return 8;
	}
	return Math.min(Math.floor(limit), 50);
}

function cleanPeer(peer: string | undefined): string | undefined {
	const trimmed = peer?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeState(state: string): string {
	return state.toUpperCase().replace(/[\s-]+/gu, "_");
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/u.test(value)) {
		return value;
	}
	return `'${value.replace(/'/gu, "'\\''")}'`;
}
