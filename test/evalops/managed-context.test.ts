import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
	readEvalOpsEnv,
} from "../../src/evalops/env-aliases.js";
import {
	formatManagedEvalOpsStatus,
	resolveManagedEvalOpsContext,
} from "../../src/evalops/managed-context.js";
import type { OAuthCredentials } from "../../src/oauth/storage.js";
import { saveOAuthCredentials } from "../../src/oauth/storage.js";

const baseCredentials: OAuthCredentials = {
	type: "oauth",
	access: "evalops-access",
	refresh: "evalops-refresh",
	expires: Date.now() + 60_000,
	metadata: {
		email: "jonathan@evalops.dev",
		organizationId: "org_evalops",
		providerRef: {
			provider: "openai",
			environment: "prod",
		},
		agentMcp: {
			type: "agent-mcp",
			apiKey: "eoak_live_123",
			createdAt: "2026-05-06T01:00:00.000Z",
			endpoint: "https://app.evalops.dev/mcp",
			integrationProfile: "managed_runtime",
			registeredAt: "2026-05-06T01:01:00.000Z",
			surface: "cli",
			agentId: "agent_123",
			keyPrefix: "eoak_live",
			memoryMode: "durable",
			runId: "run_123",
			runtimeOwner: "evalops",
			sessionExpiresAt: "2026-05-06T02:01:00.000Z",
			shimType: "sdk",
			traceMode: "otlp",
			workspaceId: "workspace_evalops",
		},
	},
};

describe("managed EvalOps context", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("keeps shared EvalOps aliases from adopting service-specific org ids", () => {
		expect(EVALOPS_ORGANIZATION_ID_ENV_VARS).not.toContain(
			"MAESTRO_LLM_GATEWAY_ORG_ID",
		);
		expect(EVALOPS_ORGANIZATION_ID_ENV_VARS).not.toContain(
			"MAESTRO_REMOTE_RUNNER_ORG_ID",
		);
		expect(EVALOPS_WORKSPACE_ID_ENV_VARS).toContain(
			"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
		);
		expect(
			readEvalOpsEnv(
				{
					EVALOPS_ORGANIZATION_ID: "org_evalops",
					MAESTRO_LLM_GATEWAY_ORG_ID: "org_gateway",
					MAESTRO_REMOTE_RUNNER_ORG_ID: "org_remote",
					MAESTRO_REMOTE_RUNNER_WORKSPACE_ID: "workspace_remote",
				},
				EVALOPS_ORGANIZATION_ID_ENV_VARS,
			),
		).toBe("org_evalops");
		expect(
			readEvalOpsEnv(
				{
					EVALOPS_WORKSPACE_ID: "workspace_evalops",
					MAESTRO_REMOTE_RUNNER_WORKSPACE_ID: "workspace_remote",
				},
				EVALOPS_WORKSPACE_ID_ENV_VARS,
			),
		).toBe("workspace_evalops");
		expect(
			readEvalOpsEnv(
				{
					MAESTRO_ENTERPRISE_ORG_ID: "org_enterprise",
					MAESTRO_LLM_GATEWAY_ORG_ID: "org_gateway",
					MAESTRO_REMOTE_RUNNER_ORG_ID: "org_remote",
				},
				EVALOPS_ORGANIZATION_ID_ENV_VARS,
			),
		).toBe("org_enterprise");
		expect(
			readEvalOpsEnv(
				{
					MAESTRO_LLM_GATEWAY_ORG_ID: "org_gateway",
					MAESTRO_REMOTE_RUNNER_ORG_ID: "org_remote",
				},
				EVALOPS_ORGANIZATION_ID_ENV_VARS,
			),
		).toBeUndefined();
		expect(
			readEvalOpsEnv(
				{
					MAESTRO_REMOTE_RUNNER_ORG_ID: "org_remote",
				},
				EVALOPS_ORGANIZATION_ID_ENV_VARS,
			),
		).toBeUndefined();
		expect(
			readEvalOpsEnv(
				{
					MAESTRO_REMOTE_RUNNER_WORKSPACE_ID: "workspace_remote",
				},
				EVALOPS_WORKSPACE_ID_ENV_VARS,
			),
		).toBe("workspace_remote");
	});

	it("resolves managed mode from stored init credentials when env is sparse", () => {
		const context = resolveManagedEvalOpsContext(
			{ MAESTRO_SESSION_ID: "session_123" },
			() => baseCredentials,
		);

		expect(context).toMatchObject({
			authenticated: true,
			managed: true,
			mode: "EvalOps managed",
			organizationId: "org_evalops",
			workspaceId: "workspace_evalops",
			userEmail: "jonathan@evalops.dev",
			agentId: "agent_123",
			runId: "run_123",
			sessionId: "session_123",
			controlPlaneUrl: "https://app.evalops.dev/mcp",
			controlPlaneEnvironment: "production",
			integrationProfile: "managed_runtime",
			memoryMode: "durable",
			runtimeOwner: "evalops",
			shimType: "sdk",
			traceIngestion: "live",
			traceMode: "otlp",
			evidencePublisher: "EvalOps",
			inference: "managed",
		});
	});

	it("prefers explicit env identity over stored managed credentials", () => {
		const context = resolveManagedEvalOpsContext(
			{
				EVALOPS_ORGANIZATION_ID: "org_env",
				EVALOPS_WORKSPACE_ID: "workspace_env",
				MAESTRO_AGENT_ID: "agent_env",
				MAESTRO_AGENT_RUN_ID: "run_env",
				MAESTRO_EVALOPS_INTEGRATION_PROFILE: "mcp_only",
				MAESTRO_EVALOPS_MEMORY_MODE: "cerebro",
				MAESTRO_EVALOPS_RUNTIME_OWNER: "customer",
				MAESTRO_EVALOPS_SHIM_TYPE: "shim",
				MAESTRO_EVALOPS_TRACE_MODE: "mcp_events",
			},
			() => baseCredentials,
		);

		expect(context.organizationId).toBe("org_env");
		expect(context.workspaceId).toBe("workspace_env");
		expect(context.agentId).toBe("agent_env");
		expect(context.runId).toBe("run_env");
		expect(context.integrationProfile).toBe("mcp_only");
		expect(context.memoryMode).toBe("cerebro");
		expect(context.runtimeOwner).toBe("customer");
		expect(context.shimType).toBe("shim");
		expect(context.traceMode).toBe("mcp_events");
	});

	it("does not report managed mode without an organization identity", () => {
		const context = resolveManagedEvalOpsContext(
			{ MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token" },
			() => ({
				...baseCredentials,
				metadata: {
					...baseCredentials.metadata,
					organizationId: undefined,
					agentMcp: {
						...(baseCredentials.metadata?.agentMcp as Record<string, unknown>),
						workspaceId: undefined,
					},
				},
			}),
		);

		expect(context.managed).toBe(false);
		expect(context.mode).toBe("EvalOps authenticated");
		expect(context.organizationId).toBeUndefined();
		expect(context.traceIngestion).toBe("not configured");
		expect(context.evidencePublisher).toBe("none");
	});

	it("keeps plain EvalOps login separate from managed agent sessions", () => {
		const loginOnlyContext = resolveManagedEvalOpsContext({}, () => ({
			...baseCredentials,
			metadata: {
				...baseCredentials.metadata,
				agentMcp: undefined,
			},
		}));

		expect(loginOnlyContext.authenticated).toBe(true);
		expect(loginOnlyContext.managed).toBe(false);
		expect(loginOnlyContext.mode).toBe("EvalOps authenticated");
		expect(loginOnlyContext.traceIngestion).toBe("not configured");
	});

	it("invalidates process credential cache when EvalOps credentials change", () => {
		const testDir = mkdtempSync(join(tmpdir(), "maestro-managed-context-"));
		vi.stubEnv("MAESTRO_AGENT_DIR", join(testDir, "agent"));
		try {
			saveOAuthCredentials("evalops", {
				...baseCredentials,
				metadata: {
					...baseCredentials.metadata,
					agentMcp: undefined,
				},
			});
			expect(resolveManagedEvalOpsContext(process.env).managed).toBe(false);

			saveOAuthCredentials("evalops", baseCredentials);
			const context = resolveManagedEvalOpsContext(process.env);

			expect(context.managed).toBe(true);
			expect(context.agentId).toBe("agent_123");
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("uses remote runner and gateway org aliases for managed mode", () => {
		expect(
			resolveManagedEvalOpsContext({
				MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token",
				MAESTRO_REMOTE_RUNNER_ORG_ID: "org_remote",
			}).organizationId,
		).toBe("org_remote");
		expect(
			resolveManagedEvalOpsContext({
				MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token",
				MAESTRO_LLM_GATEWAY_ORG_ID: "org_gateway",
			}).organizationId,
		).toBe("org_gateway");
	});

	it("uses public EvalOps aliases for managed profile metadata", () => {
		const context = resolveManagedEvalOpsContext({
			MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token",
			MAESTRO_REMOTE_RUNNER_ORG_ID: "org_remote",
			MAESTRO_REMOTE_RUNNER_WORKSPACE_ID: "workspace_remote",
			MAESTRO_AGENT_RUN_ID: "run_remote",
			EVALOPS_INTEGRATION_PROFILE: "mcp_only",
			EVALOPS_MEMORY_MODE: "cerebro",
			EVALOPS_RUNTIME_OWNER: "customer",
			EVALOPS_SHIM_TYPE: "shim",
			EVALOPS_TRACE_MODE: "mcp_events",
		});

		expect(context.managed).toBe(true);
		expect(context.integrationProfile).toBe("mcp_only");
		expect(context.memoryMode).toBe("cerebro");
		expect(context.runtimeOwner).toBe("customer");
		expect(context.shimType).toBe("shim");
		expect(context.traceMode).toBe("mcp_events");
	});

	it("requires an agent session before treating env auth as managed", () => {
		const loginOnlyContext = resolveManagedEvalOpsContext({
			MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token",
			MAESTRO_REMOTE_RUNNER_ORG_ID: "org_remote",
		});
		expect(loginOnlyContext.authenticated).toBe(true);
		expect(loginOnlyContext.managed).toBe(false);
		expect(loginOnlyContext.mode).toBe("EvalOps authenticated");

		const managedContext = resolveManagedEvalOpsContext({
			MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token",
			MAESTRO_REMOTE_RUNNER_ORG_ID: "org_remote",
			MAESTRO_REMOTE_RUNNER_WORKSPACE_ID: "workspace_remote",
			MAESTRO_AGENT_RUN_ID: "run_remote",
		});
		expect(managedContext.managed).toBe(true);
		expect(managedContext.organizationId).toBe("org_remote");
		expect(managedContext.workspaceId).toBe("workspace_remote");
		expect(managedContext.runId).toBe("run_remote");
	});

	it("formats a human status block with active EvalOps sinks", () => {
		const output = formatManagedEvalOpsStatus(
			resolveManagedEvalOpsContext(
				{ MAESTRO_SESSION_ID: "session_123" },
				() => baseCredentials,
			),
			{ color: false },
		);

		expect(output).toContain("Mode: EvalOps managed");
		expect(output).toContain("Control plane: production");
		expect(output).toContain("Organization: org_evalops");
		expect(output).toContain("Workspace: workspace_evalops");
		expect(output).toContain("Agent runtime: registered");
		expect(output).toContain("Runtime owner: evalops");
		expect(output).toContain("Trace ingestion: live");
		expect(output).toContain("Evidence publisher: EvalOps");
		expect(output).toContain("Inference: managed");
	});
});
