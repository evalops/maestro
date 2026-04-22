import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, Task } from "../types.js";
import { buildGitHubTaskEnvironment } from "./evalops.js";

const fetchMock = vi.fn();

const createMockConfig = (): Pick<AgentConfig, "maxTokensPerTask"> => ({
	maxTokensPerTask: 500000,
});

const createTask = (overrides: Partial<Task> = {}): Task => ({
	id: "task-123",
	type: "issue",
	sourceIssue: 42,
	title: "Test task title",
	description: "Test description",
	priority: 50,
	createdAt: new Date().toISOString(),
	status: "pending",
	attempts: 0,
	...overrides,
});

describe("buildGitHubTaskEnvironment", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns inherited env when EvalOps auth is not configured", async () => {
		const env = await buildGitHubTaskEnvironment(
			createTask(),
			createMockConfig(),
			{
				PATH: "/usr/bin",
			},
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(env).toMatchObject({
			PATH: "/usr/bin",
			MAESTRO_AGENT_ID: "github_issue_worker",
			MAESTRO_AGENT_RUN_ID: "task-123",
			MAESTRO_EVENT_BUS_ATTR_SOURCE_ISSUE: "42",
			MAESTRO_EVENT_BUS_ATTR_TASK_ID: "task-123",
			MAESTRO_EVENT_BUS_ATTR_TASK_TYPE: "issue",
			MAESTRO_EVENT_BUS_SOURCE: "maestro.github-agent",
			MAESTRO_MAX_OUTPUT_TOKENS: "500000",
			MAESTRO_REQUEST_ID: "github:issue:42",
			MAESTRO_RUNTIME_MODE: "headless",
			MAESTRO_SESSION_ID: "task-123",
			MAESTRO_SURFACE: "github-agent",
		});
	});

	it("requests a delegated token and overlays the child auth env", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				token: "delegated-token",
				expires_at: "2026-04-12T16:00:00Z",
			}),
		});

		const env = await buildGitHubTaskEnvironment(
			createTask({ id: "task-456", type: "pr-review" }),
			createMockConfig(),
			{
				MAESTRO_EVALOPS_ACCESS_TOKEN: "parent-token",
				MAESTRO_EVALOPS_ORG_ID: "org_123",
				MAESTRO_EVALOPS_PROVIDER: "anthropic",
				MAESTRO_EVALOPS_ENVIRONMENT: "staging",
				MAESTRO_EVALOPS_CREDENTIAL_NAME: "team-shared",
				PATH: "/usr/bin",
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:8080/v1/delegation-tokens",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			headers: {
				Authorization: "Bearer parent-token",
				"Content-Type": "application/json",
			},
		});
		expect(
			JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
		).toMatchObject({
			agent_id: "task-456",
			agent_type: "github_review_worker",
			capabilities: ["github_review_task"],
			run_id: "task-456",
			surface: "maestro-github-agent",
			ttl_seconds: 3600,
		});
		expect(env).toMatchObject({
			MAESTRO_AGENT_ID: "github_review_worker",
			MAESTRO_AGENT_RUN_ID: "task-456",
			MAESTRO_EVALOPS_ACCESS_TOKEN: "delegated-token",
			MAESTRO_EVALOPS_ORG_ID: "org_123",
			MAESTRO_EVALOPS_PROVIDER: "anthropic",
			MAESTRO_EVALOPS_ENVIRONMENT: "staging",
			MAESTRO_EVALOPS_CREDENTIAL_NAME: "team-shared",
			MAESTRO_EVENT_BUS_ATTR_SOURCE_ISSUE: "42",
			MAESTRO_EVENT_BUS_ATTR_TASK_ID: "task-456",
			MAESTRO_EVENT_BUS_ATTR_TASK_TYPE: "pr-review",
			MAESTRO_EVENT_BUS_SOURCE: "maestro.github-agent",
			MAESTRO_MAX_OUTPUT_TOKENS: "500000",
			MAESTRO_REQUEST_ID: "github:pr-review:42",
			MAESTRO_RUNTIME_MODE: "headless",
			MAESTRO_SESSION_ID: "task-456",
			MAESTRO_SURFACE: "github-agent",
			PATH: "/usr/bin",
		});
	});

	it("falls back to inherited auth and warns when delegation fails", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			json: async () => ({
				error: "identity unavailable",
			}),
		});
		const warnings: string[] = [];

		const env = await buildGitHubTaskEnvironment(
			createTask(),
			createMockConfig(),
			{
				MAESTRO_EVALOPS_ACCESS_TOKEN: "parent-token",
				MAESTRO_EVALOPS_ORG_ID: "org_123",
				PATH: "/usr/bin",
			},
			(message) => warnings.push(message),
		);

		expect(env).toMatchObject({
			MAESTRO_AGENT_ID: "github_issue_worker",
			MAESTRO_AGENT_RUN_ID: "task-123",
			MAESTRO_EVALOPS_ACCESS_TOKEN: "parent-token",
			MAESTRO_EVALOPS_ORG_ID: "org_123",
			MAESTRO_EVENT_BUS_ATTR_SOURCE_ISSUE: "42",
			MAESTRO_EVENT_BUS_ATTR_TASK_ID: "task-123",
			MAESTRO_EVENT_BUS_ATTR_TASK_TYPE: "issue",
			MAESTRO_EVENT_BUS_SOURCE: "maestro.github-agent",
			MAESTRO_MAX_OUTPUT_TOKENS: "500000",
			MAESTRO_REQUEST_ID: "github:issue:42",
			MAESTRO_RUNTIME_MODE: "headless",
			MAESTRO_SESSION_ID: "task-123",
			MAESTRO_SURFACE: "github-agent",
			PATH: "/usr/bin",
		});
		expect(warnings).toEqual([
			expect.stringContaining(
				"Failed to issue delegated EvalOps token for GitHub worker; using inherited auth: identity unavailable",
			),
		]);
	});
});
