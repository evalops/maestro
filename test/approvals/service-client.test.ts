import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionApprovalRequest } from "../../src/agent/action-approval.js";
import {
	requestApprovalWithApprovalsService,
	resetApprovalsDownstreamForTests,
	resolveApprovalsServiceConfig,
} from "../../src/approvals/service-client.js";

const approvalRequest: ActionApprovalRequest = {
	id: "approval-1",
	toolName: "bash",
	args: { command: "git push" },
	reason: "Publishing changes requires approval",
};

describe("approvals service client", () => {
	afterEach(() => {
		resetApprovalsDownstreamForTests();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("resolves shared Platform configuration for approvals", () => {
		vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "https://platform.test/");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "evalops-token");
		vi.stubEnv("MAESTRO_EVALOPS_WORKSPACE_ID", "workspace-platform");
		vi.stubEnv("MAESTRO_AGENT_ID", "agent-platform");
		vi.stubEnv("MAESTRO_SURFACE", "cli");

		expect(resolveApprovalsServiceConfig(undefined)).toMatchObject({
			baseUrl: "https://platform.test",
			token: "evalops-token",
			workspaceId: "workspace-platform",
			agentId: "agent-platform",
			surface: "cli",
		});
	});

	it("fails open and opens the configured circuit for optional approval requests", async () => {
		const fetchMock = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const config = resolveApprovalsServiceConfig({
			baseUrl: "https://approvals.test",
			circuitFailureThreshold: 1,
			circuitResetTimeoutMs: 60_000,
			circuitSuccessThreshold: 1,
			maxAttempts: 1,
			timeoutMs: 500,
			workspaceId: "workspace-1",
		});

		if (!config) {
			throw new Error("expected approvals config");
		}
		await expect(
			requestApprovalWithApprovalsService(config, approvalRequest),
		).resolves.toBeNull();
		await expect(
			requestApprovalWithApprovalsService(config, approvalRequest),
		).resolves.toBeNull();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fails closed for required approval requests", async () => {
		const fetchMock = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const config = resolveApprovalsServiceConfig({
			baseUrl: "https://approvals.test",
			maxAttempts: 1,
			required: true,
			timeoutMs: 500,
			workspaceId: "workspace-1",
		});

		if (!config) {
			throw new Error("expected approvals config");
		}
		await expect(
			requestApprovalWithApprovalsService(config, approvalRequest),
		).rejects.toThrow("approvals service returned 503");
	});
});
