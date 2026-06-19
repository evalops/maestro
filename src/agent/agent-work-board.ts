import type { A2ACockpitSummary } from "../platform/a2a-cockpit.js";
import type { TodoStore } from "../tools/todo.js";
import type { MissionManifest } from "./mission-manifest.js";
import { summarizeMissionContinuity } from "./mission-manifest.js";
import {
	type MissionStoreSnapshot,
	sanitizeMissionId,
} from "./mission-store.js";

export const AGENT_WORK_BOARD_SCHEMA = "evalops.maestro.agent-work-board.v1";

export type AgentWorkItemSource =
	| "mission"
	| "a2a"
	| "todo"
	| "handoff"
	| "github";

export type AgentWorkItemStatus =
	| "pending"
	| "running"
	| "waiting"
	| "completed"
	| "failed"
	| "blocked";

export interface AgentWorkItemEvidence {
	kind: string;
	label: string;
	path?: string;
	url?: string;
}

export interface AgentWorkItem {
	id: string;
	source: AgentWorkItemSource;
	title: string;
	status: AgentWorkItemStatus;
	owner?: string;
	priority: "high" | "medium" | "low";
	updatedAt?: string;
	blockers: string[];
	nextAction?: {
		label: string;
		command?: string;
	};
	evidence: AgentWorkItemEvidence[];
}

export interface GitHubAgentWorkProjection {
	id: string;
	title: string;
	status: AgentWorkItemStatus;
	branch?: string;
	prUrl?: string;
	updatedAt?: string;
	error?: string;
}

export interface AgentWorkBoardHandoffProjection {
	sessionId: string;
	title: string;
	status: "delivered" | "needs-followup" | "blocked";
	nextAction: string;
	blockers: string[];
	evidence: {
		sessionPath: string;
		updatedAt: string;
	};
}

export interface AgentWorkBoardOpenWorkProjection {
	goal: string;
	id: string;
	content: string;
	status: "pending" | "in_progress";
	priority: "high" | "medium" | "low";
	updatedAt: string;
	blockers: string[];
}

export interface BuildAgentWorkBoardInput {
	missions?: readonly MissionManifest[];
	missionSnapshots?: readonly MissionStoreSnapshot[];
	a2a?: A2ACockpitSummary;
	todos?: TodoStore;
	handoffs?: readonly AgentWorkBoardHandoffProjection[];
	openWork?: readonly AgentWorkBoardOpenWorkProjection[];
	githubTasks?: readonly GitHubAgentWorkProjection[];
}

export interface AgentWorkBoard {
	schemaVersion: typeof AGENT_WORK_BOARD_SCHEMA;
	generatedAt: string;
	counts: {
		total: number;
		pending: number;
		running: number;
		waiting: number;
		completed: number;
		failed: number;
		blocked: number;
	};
	items: AgentWorkItem[];
}

export function buildAgentWorkBoard(
	input: BuildAgentWorkBoardInput,
	now = new Date(),
): AgentWorkBoard {
	const missionSnapshots = input.missionSnapshots ?? [];
	const snapshotMissionIds = new Set(
		missionSnapshots.map((mission) => missionBoardDedupId(mission.missionId)),
	);
	const missions =
		input.missions?.filter(
			(mission) =>
				!snapshotMissionIds.has(missionBoardDedupId(mission.missionId)),
		) ?? [];
	const items = [
		...missionItems(missions),
		...missionSnapshotItems(missionSnapshots),
		...a2aItems(input.a2a),
		...todoItems(input.todos),
		...handoffItems(input.handoffs ?? [], input.openWork ?? []),
		...githubItems(input.githubTasks ?? []),
	].sort(compareWorkItems);
	return {
		schemaVersion: AGENT_WORK_BOARD_SCHEMA,
		generatedAt: now.toISOString(),
		counts: countItems(items),
		items,
	};
}

function missionBoardDedupId(missionId: string): string {
	try {
		return sanitizeMissionId(missionId);
	} catch {
		return missionId;
	}
}

function missionSnapshotItems(
	snapshots: readonly MissionStoreSnapshot[],
): AgentWorkItem[] {
	return snapshots.flatMap((mission) => {
		const continuity = summarizeMissionContinuity({
			version: 1,
			missionId: mission.missionId,
			milestones: [],
			features: mission.features,
			createdAt: mission.createdAt,
			updatedAt: mission.updatedAt,
		});
		const features: AgentWorkItem[] = mission.features.map((feature) => ({
			id: `mission-store:${mission.missionId}:${feature.id}`,
			source: "mission" as const,
			title: feature.description,
			status: missionFeatureStatus(feature.status),
			owner: feature.handoff?.workerId ?? feature.skillName,
			priority:
				feature.status === "in-progress" || mission.state === "blocked"
					? "high"
					: "medium",
			updatedAt: feature.handoff?.handedOffAt ?? mission.updatedAt,
			blockers:
				feature.handoff?.discoveredIssues
					?.filter((issue) => issue.severity === "blocking")
					.map((issue) => issue.description) ?? [],
			evidence:
				feature.handoff?.verification?.commandsRun?.map((command) => ({
					kind: "verification-command",
					label: command.command,
				})) ?? [],
		}));
		const blocked: AgentWorkItem[] =
			mission.state === "blocked"
				? [
						{
							id: `mission-store:${mission.missionId}:blocked`,
							source: "mission",
							title: mission.title ?? mission.missionId,
							status: "blocked",
							priority: "high",
							updatedAt: mission.updatedAt,
							blockers: [latestMissionBlocker(mission)],
							nextAction: { label: "Inspect mission progress log" },
							evidence: mission.workerSessionIds.map((workerSessionId) => ({
								kind: "worker-session",
								label: workerSessionId,
							})),
						},
					]
				: [];
		return [
			...blocked,
			...features,
			...missionContinuityItems(
				"mission-store",
				mission.missionId,
				mission.updatedAt,
				continuity,
			),
		];
	});
}

function latestMissionBlocker(mission: MissionStoreSnapshot): string {
	for (let index = mission.progressLog.length - 1; index >= 0; index--) {
		const entry = mission.progressLog[index];
		if (entry?.type === "mission_blocked" && entry.message?.trim()) {
			return entry.message;
		}
	}
	return "Mission is blocked";
}

function missionItems(missions: readonly MissionManifest[]): AgentWorkItem[] {
	return missions.flatMap((mission) => {
		const continuity = summarizeMissionContinuity(mission);
		const features: AgentWorkItem[] = mission.features.map((feature) => ({
			id: `mission:${mission.missionId}:${feature.id}`,
			source: "mission" as const,
			title: feature.description,
			status: missionFeatureStatus(feature.status),
			owner: feature.handoff?.workerId ?? feature.skillName,
			priority: feature.status === "in-progress" ? "high" : "medium",
			updatedAt: feature.handoff?.handedOffAt ?? mission.updatedAt,
			blockers:
				feature.handoff?.discoveredIssues
					?.filter((issue) => issue.severity === "blocking")
					.map((issue) => issue.description) ?? [],
			evidence:
				feature.handoff?.verification?.commandsRun?.map((command) => ({
					kind: "verification-command",
					label: command.command,
				})) ?? [],
		}));
		return [
			...features,
			...missionContinuityItems(
				"mission",
				mission.missionId,
				mission.updatedAt,
				continuity,
			),
		];
	});
}

function missionContinuityItems(
	prefix: "mission" | "mission-store",
	missionId: string,
	updatedAt: string,
	continuity: ReturnType<typeof summarizeMissionContinuity>,
): AgentWorkItem[] {
	return [
		...continuity.unresolved,
		...continuity.openFollowUps,
		...continuity.openTrackedItems,
	].map((item) => {
		const key = "key" in item ? item.key : item.id;
		return {
			id: `${prefix}:${missionId}:handoff:${item.sourceFeatureId}:${item.kind}:${key}`,
			source: "mission" as const,
			title: item.description,
			status: "blocked" as const,
			priority: "high" as const,
			updatedAt,
			blockers: ["Unresolved mission handoff item"],
			nextAction: { label: "Track, requeue, or dismiss this handoff item" },
			evidence: [],
		};
	});
}

function a2aItems(a2a: A2ACockpitSummary | undefined): AgentWorkItem[] {
	if (!a2a) return [];
	const nextActionsByTask = new Map(
		a2a.nextActions
			.filter((action) => action.taskId)
			.map(
				(action) =>
					[a2aTaskActionKey(action.peer, action.taskId!), action] as const,
			),
	);
	return a2a.tasks.map((task) => {
		const action = nextActionsByTask.get(
			a2aTaskActionKey(task.peer, task.taskId),
		);
		return {
			id: `a2a:${task.peer}:${task.taskId}`,
			source: "a2a",
			title: task.text,
			status: a2aStatus(task.status),
			owner: task.peerDisplayName ?? task.peer,
			priority:
				task.requiresInput || task.status === "failed" ? "high" : "medium",
			updatedAt: task.updatedAt,
			blockers: task.requiresInput ? ["Waiting on operator input"] : [],
			nextAction: action
				? { label: action.label, command: action.command }
				: task.nextCommand
					? { label: "Resume A2A task", command: task.nextCommand }
					: undefined,
			evidence: task.workGraph
				? [{ kind: "work-graph", label: "A2A work graph captured" }]
				: [],
		};
	});
}

function a2aTaskActionKey(peer: string | undefined, taskId: string): string {
	return `${peer ?? ""}:${taskId}`;
}

function todoItems(todos: TodoStore | undefined): AgentWorkItem[] {
	if (!todos) return [];
	return Object.values(todos).flatMap((goal) =>
		goal.items
			.filter((item) => item.status !== "completed")
			.map((item) => ({
				id: `todo:${goal.goal}:${item.id}`,
				source: "todo" as const,
				title: item.content,
				status: item.status === "in_progress" ? "running" : "pending",
				priority: item.priority,
				updatedAt: goal.updatedAt,
				blockers: item.blockedBy ?? [],
				nextAction: { label: `Continue todo goal: ${goal.goal}` },
				evidence: [],
			})),
	);
}

function handoffItems(
	handoffs: readonly AgentWorkBoardHandoffProjection[],
	openWork: readonly AgentWorkBoardOpenWorkProjection[],
): AgentWorkItem[] {
	const fromHandoffs: AgentWorkItem[] = handoffs
		.filter((handoff) => handoff.status !== "delivered")
		.map((handoff) => ({
			id: `handoff:${handoff.sessionId}`,
			source: "handoff" as const,
			title: handoff.title,
			status: handoff.status === "blocked" ? "blocked" : "waiting",
			priority: handoff.status === "blocked" ? "high" : "medium",
			updatedAt: handoff.evidence.updatedAt,
			blockers: handoff.blockers,
			nextAction: { label: handoff.nextAction },
			evidence: [
				{
					kind: "session",
					label: "Session handoff",
					path: handoff.evidence.sessionPath,
				},
			],
		}));
	const fromOpenWork: AgentWorkItem[] = openWork.map((item) => ({
		id: `open-work:${item.goal}:${item.id}`,
		source: "handoff" as const,
		title: item.content,
		status: item.status === "in_progress" ? "running" : "pending",
		priority: item.priority,
		updatedAt: item.updatedAt,
		blockers: item.blockers,
		nextAction: { label: `Continue ${item.goal}` },
		evidence: [],
	}));
	return [...fromHandoffs, ...fromOpenWork];
}

function githubItems(
	tasks: readonly GitHubAgentWorkProjection[],
): AgentWorkItem[] {
	return tasks.map((task) => ({
		id: `github:${task.id}`,
		source: "github",
		title: task.title,
		status: task.status,
		owner: task.branch,
		priority: task.status === "failed" ? "high" : "medium",
		updatedAt: task.updatedAt,
		blockers: task.error ? [task.error] : [],
		nextAction: task.prUrl
			? { label: "Review pull request", command: task.prUrl }
			: undefined,
		evidence: task.prUrl
			? [{ kind: "pull-request", label: "GitHub PR", url: task.prUrl }]
			: [],
	}));
}

function missionFeatureStatus(status: string): AgentWorkItemStatus {
	switch (status) {
		case "passed":
			return "completed";
		case "failed":
			return "failed";
		case "in-progress":
			return "running";
		case "blocked":
			return "blocked";
		default:
			return "pending";
	}
}

function a2aStatus(status: string): AgentWorkItemStatus {
	switch (status) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "waiting":
			return "waiting";
		case "running":
			return "running";
		default:
			return "pending";
	}
}

function countItems(items: readonly AgentWorkItem[]): AgentWorkBoard["counts"] {
	const counts = {
		total: items.length,
		pending: 0,
		running: 0,
		waiting: 0,
		completed: 0,
		failed: 0,
		blocked: 0,
	};
	for (const item of items) {
		counts[item.status] += 1;
	}
	return counts;
}

function compareWorkItems(left: AgentWorkItem, right: AgentWorkItem): number {
	return (
		statusWeight(right.status) - statusWeight(left.status) ||
		priorityWeight(right.priority) - priorityWeight(left.priority) ||
		(right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
		left.id.localeCompare(right.id)
	);
}

function statusWeight(status: AgentWorkItemStatus): number {
	switch (status) {
		case "blocked":
			return 6;
		case "failed":
			return 5;
		case "waiting":
			return 4;
		case "running":
			return 3;
		case "pending":
			return 2;
		case "completed":
			return 1;
	}
}

function priorityWeight(priority: AgentWorkItem["priority"]): number {
	switch (priority) {
		case "high":
			return 3;
		case "medium":
			return 2;
		case "low":
			return 1;
	}
}
