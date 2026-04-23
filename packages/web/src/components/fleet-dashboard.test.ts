import { fixture, html } from "@open-wc/testing";
import { assert, describe, it, vi } from "vitest";
import type { FleetDashboardResponse } from "../services/enterprise-api.js";
import "./fleet-dashboard.js";
import type { FleetDashboard } from "./fleet-dashboard.js";

function fleetSnapshot(
	overrides: Partial<FleetDashboardResponse> = {},
): FleetDashboardResponse {
	return {
		generatedAt: "2026-04-20T19:00:00.000Z",
		summary: {
			totalInstances: 1,
			healthyInstances: 1,
			degradedInstances: 0,
			unhealthyInstances: 0,
			idleInstances: 0,
			activeTasks: 2,
			errorRate: 0.125,
		},
		process: {
			memoryRssBytes: 128 * 1024 * 1024,
			heapUsedBytes: 64 * 1024 * 1024,
			heapTotalBytes: 96 * 1024 * 1024,
			cpuUserMicros: 120_000,
			cpuSystemMicros: 30_000,
			uptimeSeconds: 300,
		},
		instances: [
			{
				instanceId: "workspace:session-1",
				sessionId: "session-1",
				scopeKey: "workspace",
				model: "gpt-5.4",
				provider: "openai",
				cwd: "/repo",
				gitBranch: "main",
				health: "healthy",
				status: "Responding",
				isReady: true,
				isResponding: true,
				activeTasks: {
					total: 2,
					activeTools: 1,
					utilityCommands: 1,
					fileWatches: 0,
					pendingApprovals: 0,
					pendingClientTools: 0,
					pendingMcpElicitations: 0,
					pendingUserInputs: 0,
					pendingToolRetries: 0,
				},
				resourceUtilization: {
					connections: 1,
					subscribers: 1,
					activeTasks: 2,
				},
				errorStats: {
					errors: 1,
					toolErrors: 0,
					runs: 8,
					toolExecutions: 0,
					errorRate: 0.125,
				},
				startedAt: "2026-04-20T18:55:00.000Z",
				updatedAt: "2026-04-20T19:00:00.000Z",
			},
		],
		...overrides,
	};
}

describe("FleetDashboard", () => {
	it("renders fleet summary and agent instance rows", async () => {
		const getFleetStatus = vi.fn(async () => fleetSnapshot());
		const element = await fixture<FleetDashboard>(
			html`<fleet-dashboard
				.api=${{ getFleetStatus }}
				.refreshMs=${0}
			></fleet-dashboard>`,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		const text = element.shadowRoot?.textContent ?? "";
		assert.include(text, "Instances");
		assert.include(text, "session-1");
		assert.include(text, "gpt-5.4");
		assert.include(text, "12.5%");
		assert.include(text, "Mission Control");
		assert.include(text, "Provider Footprint");
		assert.equal(getFleetStatus.mock.calls.length, 1);
	});

	it("renders attention signals and provider footprint rollups", async () => {
		const base = fleetSnapshot();
		const getFleetStatus = vi.fn(async () =>
			fleetSnapshot({
				summary: {
					totalInstances: 2,
					healthyInstances: 1,
					degradedInstances: 1,
					unhealthyInstances: 0,
					idleInstances: 0,
					activeTasks: 5,
					errorRate: 0.18,
				},
				instances: [
					base.instances[0]!,
					{
						...base.instances[0]!,
						instanceId: "workspace:session-2",
						sessionId: "session-2",
						model: "claude-sonnet",
						provider: "anthropic",
						health: "degraded",
						status: "Waiting for approval",
						isResponding: false,
						activeTasks: {
							...base.instances[0]!.activeTasks,
							total: 3,
							pendingApprovals: 2,
							pendingToolRetries: 1,
						},
						resourceUtilization: {
							...base.instances[0]!.resourceUtilization,
							connections: 2,
							subscribers: 3,
							activeTasks: 3,
						},
						errorStats: {
							errors: 2,
							toolErrors: 1,
							runs: 10,
							toolExecutions: 5,
							errorRate: 0.2,
						},
						lastError: "approval timeout",
					},
				],
			}),
		);
		const element = await fixture<FleetDashboard>(
			html`<fleet-dashboard
				.api=${{ getFleetStatus }}
				.refreshMs=${0}
			></fleet-dashboard>`,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		const text = element.shadowRoot?.textContent ?? "";
		assert.include(text, "Human Attention");
		assert.include(text, "session-2");
		assert.include(text, "2 approval");
		assert.include(text, "1 retry");
		assert.include(text, "approval timeout");
		assert.include(text, "openai/gpt-5.4");
		assert.include(text, "anthropic/claude-sonnet");
		assert.include(text, "2 / 3");
	});

	it("renders an empty state when no agents are running", async () => {
		const getFleetStatus = vi.fn(async () =>
			fleetSnapshot({
				summary: {
					totalInstances: 0,
					healthyInstances: 0,
					degradedInstances: 0,
					unhealthyInstances: 0,
					idleInstances: 0,
					activeTasks: 0,
					errorRate: 0,
				},
				instances: [],
			}),
		);
		const element = await fixture<FleetDashboard>(
			html`<fleet-dashboard
				.api=${{ getFleetStatus }}
				.refreshMs=${0}
			></fleet-dashboard>`,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await element.updateComplete;

		assert.include(
			element.shadowRoot?.textContent ?? "",
			"No running agent instances.",
		);
	});
});
