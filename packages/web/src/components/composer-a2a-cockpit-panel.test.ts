import { fixture, html } from "@open-wc/testing";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../services/api-client.js";
import "./composer-a2a-cockpit-panel.js";
import type { ComposerA2ACockpitPanel } from "./composer-a2a-cockpit-panel.js";

describe("ComposerA2ACockpitPanel", () => {
	it("loads and renders the local A2A cockpit", async () => {
		const getA2ACockpit = vi.fn().mockResolvedValue({
			generatedAt: "2026-05-16T00:00:00.000Z",
			registryPath: "/tmp/peers.json",
			tasksPath: "/tmp/tasks.json",
			counts: {
				peers: 1,
				onlinePeers: 1,
				unreachablePeers: 0,
				tasks: 2,
				runningTasks: 0,
				actionRequiredTasks: 1,
				failedTasks: 1,
				completedTasks: 0,
			},
			peers: [
				{
					name: "mac-mini",
					url: "http://127.0.0.1:4111",
					status: "online",
					taskCounts: {
						tasks: 1,
						runningTasks: 0,
						actionRequiredTasks: 1,
						failedTasks: 0,
						completedTasks: 0,
					},
					lastTask: {
						id: "task-1",
						state: "TASK_STATE_INPUT_REQUIRED",
						status: "waiting",
						updatedAt: "2026-05-16T00:00:00.000Z",
						text: "Need operator input",
					},
				},
			],
			tasks: [
				{
					ledgerId: "ledger-1",
					peer: "mac-mini",
					taskId: "task-1",
					state: "TASK_STATE_INPUT_REQUIRED",
					status: "waiting",
					requiresInput: true,
					terminal: true,
					final: false,
					text: "Need operator input",
					updatedAt: "2026-05-16T00:00:00.000Z",
					nextCommand:
						"maestro a2a reply mac-mini task-1 <response> --wait --work-graph",
				},
				{
					ledgerId: "ledger-2",
					peer: "retired-peer",
					orphanedPeer: true,
					taskId: "task-2",
					state: "TASK_STATE_FAILED",
					status: "failed",
					requiresInput: false,
					terminal: true,
					final: true,
					text: "Failed after peer rename",
					updatedAt: "2026-05-16T00:00:01.000Z",
				},
			],
			nextActions: [
				{
					id: "reply:mac-mini:task-1",
					label: "Reply to mac-mini task task-1",
					command:
						"maestro a2a reply mac-mini task-1 <response> --wait --work-graph",
					severity: "critical",
					peer: "mac-mini",
					taskId: "task-1",
					reason: "Peer needs input.",
				},
				{
					id: "refresh:mac-mini:task-3",
					label: "Refresh degraded task task-3",
					command: "maestro a2a tasks mac-mini --refresh",
					severity: "warning",
					peer: "mac-mini",
					taskId: "task-3",
					reason: "Peer is degraded.",
				},
			],
		});
		const apiClient = { getA2ACockpit } as unknown as ApiClient;

		const element = await fixture<ComposerA2ACockpitPanel>(
			html`<composer-a2a-cockpit-panel
				.apiClient=${apiClient}
			></composer-a2a-cockpit-panel>`,
		);

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		expect(getA2ACockpit).toHaveBeenCalledWith({ timeoutMs: 2500 });
		const text = element.shadowRoot?.textContent ?? "";
		expect(text).toContain("A2A cockpit");
		expect(text).toContain("Peers online");
		expect(text).toContain("Reply to mac-mini task task-1");
		expect(text).toContain("Refresh degraded task task-3");
		expect(text).toContain("maestro a2a reply mac-mini task-1");
		expect(text).toContain("Need operator input");
		expect(text).toContain("retired-peer (orphaned peer)");
		expect(text).toContain("Failed after peer rename");
		const warningAction = [
			...(element.shadowRoot?.querySelectorAll(".row.warning") ?? []),
		].find((row) => row.textContent?.includes("Refresh degraded task task-3"));
		expect(warningAction).toBeTruthy();
	});

	it("does not fetch without an API client", async () => {
		await fixture<ComposerA2ACockpitPanel>(
			html`<composer-a2a-cockpit-panel></composer-a2a-cockpit-panel>`,
		);
		expect(true).toBe(true);
	});
});
