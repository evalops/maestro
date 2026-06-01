import type { ComposerPendingRequest } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import { buildComposerRunTimeline } from "../../src/server/session-timeline.js";

describe("buildComposerRunTimeline", () => {
	it("counts persisted pending requests and dedupes live pending requests", () => {
		const sessionId = "session-pending-count";
		const request: ComposerPendingRequest = {
			id: "pending-approval-1",
			kind: "approval",
			status: "pending",
			visibility: "user",
			sessionId,
			toolCallId: "call-edit",
			toolName: "edit",
			displayName: "Edit docs",
			args: { path: "docs/run.md" },
			reason: "Governed edit approval is pending.",
			createdAt: "2026-05-09T10:00:03.800Z",
			source: "platform",
			platform: {
				source: "tool_execution",
				toolExecutionId: "texec-call-edit",
				approvalRequestId: "approval-call-edit",
			},
		};

		const timeline = buildComposerRunTimeline({
			sessionId,
			generatedAt: "2026-05-09T10:00:04.000Z",
			entries: [
				{
					type: "custom",
					id: "pending-approval-entry",
					parentId: "tool-1",
					timestamp: "2026-05-09T10:00:03.800Z",
					customType: "pending_request",
					data: { request },
				},
			],
			pendingRequests: [request],
		});

		expect(timeline.pendingRequestCount).toBe(1);
		expect(
			timeline.items.filter((item) => item.type === "wait.pending"),
		).toHaveLength(1);
		expect(timeline.items[0]).toMatchObject({
			type: "wait.pending",
			pendingRequestId: "pending-approval-1",
			approvalRequestId: "approval-call-edit",
			toolExecutionId: "texec-call-edit",
		});
	});
});
