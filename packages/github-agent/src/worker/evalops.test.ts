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
			MAESTRO_MAX_OUTPUT_TOKENS: "500000",
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
			MAESTRO_EVALOPS_ACCESS_TOKEN: "delegated-token",
			MAESTRO_EVALOPS_ORG_ID: "org_123",
			MAESTRO_EVALOPS_PROVIDER: "anthropic",
			MAESTRO_EVALOPS_ENVIRONMENT: "staging",
			MAESTRO_EVALOPS_CREDENTIAL_NAME: "team-shared",
			MAESTRO_MAX_OUTPUT_TOKENS: "500000",
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
			MAESTRO_EVALOPS_ACCESS_TOKEN: "parent-token",
			MAESTRO_EVALOPS_ORG_ID: "org_123",
			MAESTRO_MAX_OUTPUT_TOKENS: "500000",
			PATH: "/usr/bin",
		});
		expect(warnings).toEqual([
			expect.stringContaining(
				"Failed to issue delegated EvalOps token for GitHub worker; using inherited auth: identity unavailable",
			),
		]);
	});
});
