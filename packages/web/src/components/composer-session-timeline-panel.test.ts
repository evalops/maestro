import { fixture, html } from "@open-wc/testing";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../services/api-client.js";
import "./composer-session-timeline-panel.js";
import type { ComposerSessionTimelinePanel } from "./composer-session-timeline-panel.js";

describe("ComposerSessionTimelinePanel", () => {
	it("loads and renders a session timeline", async () => {
		const getSessionTimeline = vi.fn().mockResolvedValue({
			sessionId: "session-1",
			source: "local",
			generatedAt: "2024-01-01T00:00:00.000Z",
			platformBacked: false,
			pendingRequestCount: 1,
			items: [
				{
					id: "message:user-1",
					sessionId: "session-1",
					timestamp: "2024-01-01T00:00:01.000Z",
					type: "message.user",
					title: "User message",
					visibility: "user",
					source: "local",
					status: "completed",
					summary: "Fix the failing tests",
				},
				{
					id: "pending:approval-1",
					sessionId: "session-1",
					timestamp: "2024-01-01T00:00:02.000Z",
					type: "wait.pending",
					title: "Waiting for approval: Shell Command",
					visibility: "user",
					source: "platform",
					status: "pending",
					toolName: "bash",
					toolCallId: "approval-1",
					pendingRequestId: "approval-1",
					pendingRequestKind: "approval",
					toolExecutionId: "te_1",
					approvalRequestId: "apr_1",
					artifactId: "skill_remote_1",
				},
			],
		});
		const apiClient = { getSessionTimeline } as unknown as ApiClient;

		const element = await fixture<ComposerSessionTimelinePanel>(
			html`<composer-session-timeline-panel
				.apiClient=${apiClient}
				.sessionId=${"session-1"}
			></composer-session-timeline-panel>`,
		);

		await element.updateComplete;
		await Promise.resolve();
		await element.updateComplete;

		expect(getSessionTimeline).toHaveBeenCalledWith("session-1");
		const text = element.shadowRoot?.textContent ?? "";
		expect(text).toContain("Run timeline");
		expect(text).toContain("Waiting for approval: Shell Command");
		expect(text).toContain("te_1");
		expect(text).toContain("apr_1");
		expect(text).toContain("skill_remote_1");
		expect(text).toContain("Platform");
	});

	it("does not fetch without a selected session", async () => {
		const getSessionTimeline = vi.fn();
		const apiClient = { getSessionTimeline } as unknown as ApiClient;

		await fixture<ComposerSessionTimelinePanel>(
			html`<composer-session-timeline-panel
				.apiClient=${apiClient}
			></composer-session-timeline-panel>`,
		);

		expect(getSessionTimeline).not.toHaveBeenCalled();
	});
});
