import type { ComposerPendingRequest } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import {
	attachPendingRequestMetadata,
	formatPendingRequestStatus,
} from "../../packages/web/src/components/pending-request-metadata.js";

function pendingRequest(expiresAt: string): ComposerPendingRequest {
	return {
		id: "approval-1",
		kind: "approval",
		status: "pending",
		visibility: "user",
		toolCallId: "tool-call-1",
		toolName: "bash",
		args: { command: "echo hi" },
		reason: "Needs approval",
		createdAt: "2026-04-24T00:00:00.000Z",
		expiresAt,
		source: "platform",
	};
}

describe("pending request metadata", () => {
	it("formats exact-expiry waits as timed out in the past", () => {
		const nowMs = Date.parse("2026-04-24T00:05:00.000Z");
		const value = attachPendingRequestMetadata(
			{},
			pendingRequest(new Date(nowMs).toISOString()),
		);

		const status = formatPendingRequestStatus(value, nowMs);

		expect(status).toContain("Platform wait");
		expect(status).toContain("Timed out less than 1 minute ago");
		expect(status).not.toContain("Timed out in");
	});

	it("keeps future expirations phrased as upcoming", () => {
		const nowMs = Date.parse("2026-04-24T00:05:00.000Z");
		const value = attachPendingRequestMetadata(
			{},
			pendingRequest(new Date(nowMs + 1).toISOString()),
		);

		expect(formatPendingRequestStatus(value, nowMs)).toContain(
			"Expires in less than 1 minute",
		);
	});

	it("rounds hours from the original duration", () => {
		const nowMs = Date.parse("2026-04-24T00:05:00.000Z");
		const value = attachPendingRequestMetadata(
			{},
			pendingRequest(new Date(nowMs + 89.5 * 60_000).toISOString()),
		);

		expect(formatPendingRequestStatus(value, nowMs)).toContain(
			"Expires in 1 hour",
		);
	});
});
