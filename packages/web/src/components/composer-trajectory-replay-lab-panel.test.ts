import { fixture, html } from "@open-wc/testing";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../services/api-client.js";
import "./composer-trajectory-replay-lab-panel.js";
import type { ComposerTrajectoryReplayLabPanel } from "./composer-trajectory-replay-lab-panel.js";

describe("ComposerTrajectoryReplayLabPanel", () => {
	it("loads and renders trajectory replay lab artifacts", async () => {
		const getSessionReplayLab = vi.fn().mockResolvedValue(replayLab());
		const apiClient = { getSessionReplayLab } as unknown as ApiClient;

		const element = await fixture<ComposerTrajectoryReplayLabPanel>(
			html`<composer-trajectory-replay-lab-panel
				.apiClient=${apiClient}
				.sessionId=${"session-lab-1"}
			></composer-trajectory-replay-lab-panel>`,
		);

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		expect(getSessionReplayLab).toHaveBeenCalledWith("session-lab-1");
		const text = element.shadowRoot?.textContent ?? "";
		expect(text).toContain("Trajectory replay lab");
		expect(text).toContain("Repo inspection complete");
		expect(text).toContain("Assistant response");
		expect(text).toContain("Events");
		expect(text).toContain("Deltas");
	});

	it("switches between replay and score views without refetching", async () => {
		const getSessionReplayLab = vi.fn().mockResolvedValue(replayLab());
		const apiClient = { getSessionReplayLab } as unknown as ApiClient;
		const element = await fixture<ComposerTrajectoryReplayLabPanel>(
			html`<composer-trajectory-replay-lab-panel
				.apiClient=${apiClient}
				.sessionId=${"session-lab-1"}
			></composer-trajectory-replay-lab-panel>`,
		);
		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		const buttons = [...(element.shadowRoot?.querySelectorAll("button") ?? [])];
		buttons.find((button) => button.textContent?.trim() === "replay")?.click();
		await element.updateComplete;
		expect(element.shadowRoot?.textContent ?? "").toContain("Replay deltas");
		expect(element.shadowRoot?.textContent ?? "").toContain("No replay deltas");

		buttons.find((button) => button.textContent?.trim() === "score")?.click();
		await element.updateComplete;
		expect(element.shadowRoot?.textContent ?? "").toContain("Score findings");
		expect(element.shadowRoot?.textContent ?? "").toContain(
			"final-event-has-evidence",
		);
		expect(getSessionReplayLab).toHaveBeenCalledTimes(1);
	});

	it("does not fetch without a selected session", async () => {
		const getSessionReplayLab = vi.fn();
		const apiClient = { getSessionReplayLab } as unknown as ApiClient;

		await fixture<ComposerTrajectoryReplayLabPanel>(
			html`<composer-trajectory-replay-lab-panel
				.apiClient=${apiClient}
			></composer-trajectory-replay-lab-panel>`,
		);

		expect(getSessionReplayLab).not.toHaveBeenCalled();
	});
});

function replayLab() {
	return {
		schemaVersion: "evalops.maestro.agent-trajectory-replay-lab.v1",
		generatedAt: "2026-05-18T00:00:05.000Z",
		run: {
			id: "session-lab-1",
			sessionId: "session-lab-1",
			source: "local",
			generatedAt: "2026-05-18T00:00:04.000Z",
			platformBacked: false,
		},
		summary: {
			timelineItems: 4,
			trajectoryEvents: 4,
			replayDeltas: 0,
			replayErrors: 0,
			replayWarnings: 0,
			scoreRules: 1,
			scoreFailures: 0,
			scoreWarnings: 0,
			jumpTargets: 4,
			phases: 3,
			toolCalls: 1,
		},
		timeline: {
			items: [
				{
					id: "tool-result:call-read",
					timestamp: "2026-05-18T00:00:02.000Z",
					type: "tool.completed",
					title: "read completed",
					status: "completed",
					visibility: "user",
					source: "local",
					toolName: "read",
					toolExecutionId: "tool_exec_read_1",
				},
			],
		},
		trajectory: {
			counts: {
				events: 2,
				byPhase: { verify: 1, think: 1 },
				byKind: { tool: 1, message: 1 },
				byStatus: { completed: 2 },
			},
			events: [
				{
					id: "trajectory:tool-result:call-read",
					sequence: 1,
					timestamp: "2026-05-18T00:00:02.000Z",
					kind: "tool",
					phase: "verify",
					actor: "tool",
					type: "tool.completed",
					status: "completed",
					title: "read completed",
					toolName: "read",
					relatedIds: ["call-read"],
				},
				{
					id: "trajectory:message:assistant-final",
					sequence: 2,
					timestamp: "2026-05-18T00:00:03.000Z",
					kind: "message",
					phase: "think",
					actor: "assistant",
					type: "message.assistant",
					status: "completed",
					title: "Assistant response",
					summary: "Repo inspection complete.",
				},
			],
		},
		replay: {
			counts: {
				deltas: 0,
				errors: 0,
				warnings: 0,
				toolCalls: 1,
				phases: 2,
			},
			phases: [
				{
					phase: "verify",
					events: 1,
					firstSequence: 1,
					lastSequence: 1,
				},
			],
			toolCalls: [
				{
					toolCallId: "call-read",
					toolName: "read",
					requestedSequence: 1,
					resultSequences: [2],
					terminalStatus: "completed",
				},
			],
			deltas: [],
		},
		score: {
			counts: {
				rules: 1,
				passed: 1,
				failed: 0,
				warnings: 0,
			},
			findings: [
				{
					ruleId: "final-event-has-evidence",
					status: "pass",
					severity: "error",
					message: "Final trajectory event has evidence anchors.",
					eventIds: ["trajectory:message:assistant-final"],
					remediation: "No action required.",
				},
			],
		},
		inspection: {
			counts: {
				jumpTargets: 4,
				replayDeltas: 0,
				scoreFindings: 1,
				scoreFailures: 0,
				scoreWarnings: 0,
			},
			finalAnswer: {
				eventId: "trajectory:message:assistant-final",
				timelineItemIds: ["message:assistant-final"],
				title: "Assistant response",
				summary: "Repo inspection complete.",
			},
		},
	};
}
