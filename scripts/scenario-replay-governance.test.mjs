import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildScenarioReplayGovernanceRequest,
	postScenarioReplayGovernanceRequest,
	resolveScenarioReplayGovernanceConfig,
} from "./scenario-replay-governance.mjs";

const configuredEnv = {
	MAESTRO_TOOL_EXECUTION_SERVICE_URL:
		"https://platform.example/toolexecution.v1.ToolExecutionService/ExecuteTool",
	MAESTRO_TOOL_EXECUTION_SERVICE_TOKEN: "token",
	MAESTRO_TOOL_EXECUTION_ORGANIZATION_ID: "org_1",
	MAESTRO_TOOL_EXECUTION_WORKSPACE_ID: "workspace_1",
	GITHUB_SERVER_URL: "https://github.com",
	GITHUB_REPOSITORY: "evalops/maestro-internal",
	GITHUB_RUN_ID: "123",
	GITHUB_RUN_ATTEMPT: "2",
	GITHUB_WORKFLOW: "scenario replay",
	GITHUB_JOB: "scenario-replay",
	GITHUB_SHA: "abc123",
	GITHUB_REF_NAME: "feature",
	GITHUB_EVENT_NAME: "pull_request",
	GITHUB_ACTOR: "octocat",
};

test("resolveScenarioReplayGovernanceConfig requires all Platform settings", () => {
	assert.equal(resolveScenarioReplayGovernanceConfig({}), null);
	assert.deepEqual(resolveScenarioReplayGovernanceConfig(configuredEnv), {
		baseUrl: "https://platform.example",
		token: "token",
		organizationId: "org_1",
		workspaceId: "workspace_1",
		timeoutMs: 2500,
	});
});

test("buildScenarioReplayGovernanceRequest creates governed failure evidence", () => {
	const config = resolveScenarioReplayGovernanceConfig(configuredEnv);
	const request = buildScenarioReplayGovernanceRequest({
		config,
		env: configuredEnv,
		summary: {
			generatedAt: "2026-05-10T00:00:00.000Z",
			fixtures: 2,
		},
		failures: [
			{
				group: "scripted-replay",
				fixture: "failure.json",
				junitPath: "tmp/scenario-replay/scripted-replay/failure.xml",
				exitCode: 1,
			},
		],
	});

	assert.equal(request.linkage.workspaceId, "workspace_1");
	assert.equal(request.linkage.organizationId, "org_1");
	assert.equal(request.linkage.surface, "SURFACE_MAESTRO");
	assert.equal(request.linkage.correlationId, "https://github.com/evalops/maestro-internal/actions/runs/123");
	assert.equal(request.tool.namespace, "evalops.maestro");
	assert.equal(request.tool.capability, "scenario.replay.gate");
	assert.equal(request.riskLevel, "RISK_LEVEL_LOW");
	assert.equal(
		request.idempotencyKey,
		"maestro:scenario-replay-gate:evalops/maestro-internal:123:2:abc123",
	);
	assert.equal(request.arguments.failureCount, 1);
	assert.equal(request.metadata.failure_count, "1");
});

test("postScenarioReplayGovernanceRequest sends Connect JSON", async () => {
	const config = resolveScenarioReplayGovernanceConfig(configuredEnv);
	const calls = [];
	const response = await postScenarioReplayGovernanceRequest({
		config,
		request: { idempotencyKey: "key" },
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return new Response(
				JSON.stringify({ execution: { id: "tool_execution_1" } }),
				{ status: 200 },
			);
		},
	});

	assert.deepEqual(response, { execution: { id: "tool_execution_1" } });
	assert.equal(
		calls[0].url,
		"https://platform.example/toolexecution.v1.ToolExecutionService/ExecuteTool",
	);
	assert.equal(calls[0].init.headers.Authorization, "Bearer token");
	assert.equal(calls[0].init.headers["Connect-Protocol-Version"], "1");
	assert.equal(calls[0].init.headers["X-Organization-ID"], "org_1");
	assert.equal(JSON.parse(calls[0].init.body).idempotencyKey, "key");
});
