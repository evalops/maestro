import { describe, expect, it } from "vitest";
import {
	type A2ATelemetryCloudEventLike,
	inspectA2ATelemetry,
} from "../../src/platform/a2a-telemetry-inspect.js";

describe("A2A telemetry inspection", () => {
	it("reconstructs delegated lanes from A2A CloudEvents and completion audit proof", () => {
		const events: A2ATelemetryCloudEventLike[] = [
			event("maestro.events.a2a.peer.selected", {
				swarm_id: "swarm_1",
				lane_id: "lane_alpha",
				parent_task_id: "task_parent",
				peer_name: "Alpha",
				peer_agent_id: "agent_alpha",
				source: "platform-agent-registry",
				skill_id: "maestro.subagent.code-review",
			}),
			event("maestro.events.a2a.task.dispatched", {
				swarm_id: "swarm_1",
				lane_id: "lane_alpha",
				parent_task_id: "task_parent",
				a2a_task_id: "a2a_task_1",
				a2a_message_id: "a2a_message_1",
				context_id: "ctx_1",
				status: "TASK_STATE_SUBMITTED",
			}),
			event("maestro.events.a2a.task.completed", {
				swarm_id: "swarm_1",
				lane_id: "lane_alpha",
				parent_task_id: "task_parent",
				a2a_task_id: "a2a_task_1",
				status: "TASK_STATE_COMPLETED",
				success: true,
				duration_ms: 450,
			}),
		];

		const inspection = inspectA2ATelemetry({
			swarmId: "swarm_1",
			events,
			audit: {
				schema: "evalops.maestro.a2a-completion-audit.v1",
				swarmId: "swarm_1",
				generatedAt: "2026-05-23T18:00:00.000Z",
				complete: true,
				counts: {
					remoteLanes: 1,
					completeLanes: 1,
					incompleteLanes: 0,
					pushCoveredLanes: 1,
					workGraphCoveredLanes: 1,
				},
				lanes: [
					{
						laneId: "lane_alpha",
						parentTaskId: "task_parent",
						a2aTaskId: "a2a_task_1",
						a2aMessageId: "a2a_message_1",
						contextId: "ctx_1",
						peer: "Alpha",
						status: "TASK_STATE_COMPLETED",
						terminal: true,
						evidence: {
							status: true,
							artifact: true,
							task: true,
							workGraph: true,
							push: true,
							correlation: true,
						},
						missingEvidence: [],
					},
				],
			},
		});

		expect(inspection).toEqual(
			expect.objectContaining({
				schema: "evalops.maestro.a2a-telemetry-inspection.v1",
				swarmId: "swarm_1",
				complete: true,
				counts: {
					events: 3,
					lanes: 1,
					selectedPeers: 1,
					completedLanes: 1,
					failedLanes: 0,
					missingTelemetryLanes: 0,
				},
				lanes: [
					expect.objectContaining({
						laneId: "lane_alpha",
						parentTaskId: "task_parent",
						a2aTaskId: "a2a_task_1",
						a2aMessageId: "a2a_message_1",
						contextId: "ctx_1",
						peer: "Alpha",
						peerAgentId: "agent_alpha",
						source: "platform-agent-registry",
						status: "TASK_STATE_COMPLETED",
						eventTypes: [
							"maestro.events.a2a.peer.selected",
							"maestro.events.a2a.task.dispatched",
							"maestro.events.a2a.task.completed",
						],
						missingEventTypes: [],
						missingEvidence: [],
					}),
				],
			}),
		);
	});

	it("accepts pre-dispatch task failures without requiring a dispatch event", () => {
		const events: A2ATelemetryCloudEventLike[] = [
			event("maestro.events.a2a.peer.selected", {
				swarm_id: "swarm_1",
				lane_id: "lane_alpha",
				parent_task_id: "task_parent",
				peer_name: "Alpha",
				peer_agent_id: "agent_alpha",
				source: "platform-agent-registry",
			}),
			event("maestro.events.a2a.task.failed", {
				swarm_id: "swarm_1",
				lane_id: "lane_alpha",
				parent_task_id: "task_parent",
				status: "TASK_STATE_FAILED",
				success: false,
				terminal: true,
			}),
		];

		const inspection = inspectA2ATelemetry({
			swarmId: "swarm_1",
			events,
		});

		expect(inspection).toEqual(
			expect.objectContaining({
				complete: true,
				counts: expect.objectContaining({
					completedLanes: 0,
					failedLanes: 1,
					missingTelemetryLanes: 0,
				}),
				lanes: [
					expect.objectContaining({
						laneId: "lane_alpha",
						a2aTaskId: undefined,
						status: "TASK_STATE_FAILED",
						eventTypes: [
							"maestro.events.a2a.peer.selected",
							"maestro.events.a2a.task.failed",
						],
						missingEventTypes: [],
					}),
				],
			}),
		);
	});

	it("still requires dispatch telemetry when a terminal event has a remote task id", () => {
		const events: A2ATelemetryCloudEventLike[] = [
			event("maestro.events.a2a.peer.selected", {
				swarm_id: "swarm_1",
				lane_id: "lane_alpha",
				parent_task_id: "task_parent",
				peer_name: "Alpha",
				peer_agent_id: "agent_alpha",
				source: "platform-agent-registry",
			}),
			event("maestro.events.a2a.task.failed", {
				swarm_id: "swarm_1",
				lane_id: "lane_alpha",
				parent_task_id: "task_parent",
				a2a_task_id: "remote-task-1",
				status: "TASK_STATE_FAILED",
				success: false,
				terminal: true,
			}),
		];

		const inspection = inspectA2ATelemetry({
			swarmId: "swarm_1",
			events,
		});

		expect(inspection).toEqual(
			expect.objectContaining({
				complete: false,
				counts: expect.objectContaining({
					failedLanes: 1,
					missingTelemetryLanes: 1,
				}),
				lanes: [
					expect.objectContaining({
						laneId: "lane_alpha",
						a2aTaskId: "remote-task-1",
						missingEventTypes: ["maestro.events.a2a.task.dispatched"],
					}),
				],
			}),
		);
	});
});

function event(
	type: string,
	data: Record<string, unknown>,
): A2ATelemetryCloudEventLike {
	return {
		type,
		time: "2026-05-23T18:00:00.000Z",
		data: {
			"@type": "type.googleapis.com/maestro.v1.MaestroA2ADelegationEvent",
			...data,
		},
	};
}
