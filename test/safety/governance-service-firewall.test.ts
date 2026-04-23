import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionApprovalContext } from "../../src/agent/action-approval.js";
import { ActionFirewall } from "../../src/safety/action-firewall.js";
import { resetActionFirewallGovernanceDownstreamForTests } from "../../src/safety/governance-service-client.js";
import { SemanticJudge } from "../../src/safety/semantic-judge.js";

const fetchMock = vi.fn();

function makeBashContext(command: string): ActionApprovalContext {
	return {
		toolName: "bash",
		args: { command },
		user: { id: "user-1", orgId: "workspace-from-context" },
		userIntent: "run a shell command",
	};
}

function configureGovernanceEnv(): void {
	process.env.GOVERNANCE_SERVICE_URL = "https://governance.test/";
	process.env.GOVERNANCE_SERVICE_TOKEN = "governance-token";
	process.env.GOVERNANCE_SERVICE_MAX_ATTEMPTS = "1";
	process.env.GOVERNANCE_SERVICE_TIMEOUT_MS = "500";
}

function clearGovernanceEnv(): void {
	for (const name of [
		"GOVERNANCE_SERVICE_URL",
		"MAESTRO_GOVERNANCE_SERVICE_URL",
		"MAESTRO_PLATFORM_BASE_URL",
		"MAESTRO_EVALOPS_BASE_URL",
		"EVALOPS_BASE_URL",
		"GOVERNANCE_SERVICE_TOKEN",
		"MAESTRO_GOVERNANCE_SERVICE_TOKEN",
		"MAESTRO_EVALOPS_ACCESS_TOKEN",
		"EVALOPS_TOKEN",
		"GOVERNANCE_SERVICE_WORKSPACE_ID",
		"MAESTRO_GOVERNANCE_WORKSPACE_ID",
		"MAESTRO_EVALOPS_WORKSPACE_ID",
		"MAESTRO_WORKSPACE_ID",
		"GOVERNANCE_SERVICE_AGENT_ID",
		"MAESTRO_GOVERNANCE_AGENT_ID",
		"MAESTRO_EVALOPS_AGENT_ID",
		"MAESTRO_AGENT_ID",
		"GOVERNANCE_SERVICE_REQUIRED",
		"MAESTRO_GOVERNANCE_SERVICE_REQUIRED",
		"GOVERNANCE_SERVICE_MAX_ATTEMPTS",
		"MAESTRO_GOVERNANCE_SERVICE_MAX_ATTEMPTS",
		"GOVERNANCE_SERVICE_TIMEOUT_MS",
		"MAESTRO_GOVERNANCE_SERVICE_TIMEOUT_MS",
		"GOVERNANCE_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
		"MAESTRO_GOVERNANCE_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
		"GOVERNANCE_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
		"MAESTRO_GOVERNANCE_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
		"GOVERNANCE_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
		"MAESTRO_GOVERNANCE_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
	]) {
		delete process.env[name];
	}
}

describe("ActionFirewall governance service", () => {
	beforeEach(() => {
		clearGovernanceEnv();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	it("uses shared Platform configuration for governance service checks", async () => {
		process.env.MAESTRO_PLATFORM_BASE_URL = "https://platform.test/";
		process.env.MAESTRO_EVALOPS_ACCESS_TOKEN = "evalops-token";
		process.env.MAESTRO_EVALOPS_WORKSPACE_ID = "workspace-platform";
		process.env.MAESTRO_AGENT_ID = "agent-platform";
		process.env.GOVERNANCE_SERVICE_MAX_ATTEMPTS = "1";
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					evaluation: {
						decision: "allow",
					},
				}),
				{ status: 200 },
			),
		);

		const firewall = new ActionFirewall();
		const verdict = await firewall.evaluate(makeBashContext("echo hello"));

		expect(verdict).toEqual({ action: "allow" });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://platform.test/governance.v1.GovernanceService/EvaluateAction",
		);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer evalops-token",
		});
		expect(JSON.parse(String(init.body))).toMatchObject({
			workspaceId: "workspace-from-context",
			agentId: "agent-platform",
		});
	});

	afterEach(() => {
		clearGovernanceEnv();
		resetActionFirewallGovernanceDownstreamForTests();
		vi.unstubAllGlobals();
	});

	it("delegates rule evaluation to the governance service when configured", async () => {
		configureGovernanceEnv();
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					evaluation: {
						decision: "ACTION_DECISION_ALLOW",
						reasons: [],
						matchedRules: [],
					},
				}),
				{ status: 200 },
			),
		);

		const firewall = new ActionFirewall();
		const verdict = await firewall.evaluate(
			makeBashContext("rm -rf /tmp/test"),
		);

		expect(verdict).toEqual({ action: "allow" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://governance.test/governance.v1.GovernanceService/EvaluateAction",
		);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer governance-token",
			"Connect-Protocol-Version": "1",
			"Content-Type": "application/json",
		});

		const body = JSON.parse(String(init.body)) as {
			actionPayload: string;
			actionType: string;
			agentId: string;
			workspaceId: string;
		};
		expect(body).toMatchObject({
			actionType: "bash",
			agentId: "maestro",
			workspaceId: "workspace-from-context",
		});
		const actionPayload = JSON.parse(
			Buffer.from(body.actionPayload, "base64").toString("utf8"),
		) as { args: { command: string }; toolName: string };
		expect(actionPayload).toMatchObject({
			toolName: "bash",
			args: { command: "rm -rf /tmp/test" },
		});
	});

	it("falls back to local firewall rules when optional governance service fails", async () => {
		configureGovernanceEnv();
		fetchMock.mockRejectedValue(new Error("connection refused"));

		const firewall = new ActionFirewall();
		const verdict = await firewall.evaluate(
			makeBashContext("rm -rf /tmp/test"),
		);

		expect(verdict.action).toBe("require_approval");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("still runs the local semantic judge after governance service allows", async () => {
		configureGovernanceEnv();
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					evaluation: {
						decision: "allow",
					},
				}),
				{ status: 200 },
			),
		);
		const judgeFunc = vi.fn().mockResolvedValue(
			JSON.stringify({
				safe: false,
				reason: "Command does not match the user intent",
			}),
		);

		const firewall = new ActionFirewall();
		firewall.setSemanticJudge(new SemanticJudge(judgeFunc));
		const verdict = await firewall.evaluate(makeBashContext("echo hello"));

		expect(verdict).toMatchObject({
			action: "require_approval",
			ruleId: "semantic-judge",
			reason: "Command does not match the user intent",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(judgeFunc).toHaveBeenCalledTimes(1);
	});

	it("blocks when the required governance service is unavailable", async () => {
		configureGovernanceEnv();
		process.env.GOVERNANCE_SERVICE_REQUIRED = "1";
		fetchMock.mockRejectedValue(new Error("connection refused"));

		const firewall = new ActionFirewall();
		const verdict = await firewall.evaluate(makeBashContext("echo hello"));

		expect(verdict).toMatchObject({
			action: "block",
			ruleId: "governance-service-unavailable",
		});
		expect("reason" in verdict ? verdict.reason : "").toContain(
			"Governance service unavailable",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("opens the configured circuit after repeated optional governance service failures", async () => {
		configureGovernanceEnv();
		process.env.GOVERNANCE_SERVICE_CIRCUIT_FAILURE_THRESHOLD = "1";
		process.env.GOVERNANCE_SERVICE_CIRCUIT_RESET_TIMEOUT_MS = "60000";
		process.env.GOVERNANCE_SERVICE_CIRCUIT_SUCCESS_THRESHOLD = "1";
		fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));

		const firewall = new ActionFirewall();

		await expect(
			firewall.evaluate(makeBashContext("echo one")),
		).resolves.toEqual({
			action: "allow",
		});
		await expect(
			firewall.evaluate(makeBashContext("echo two")),
		).resolves.toEqual({
			action: "allow",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
