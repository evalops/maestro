import { afterEach, describe, expect, it } from "vitest";
import { maestroTraceIdentityAttributes } from "../../src/agent/tracing.js";

const ENV_KEYS = [
	"MAESTRO_EVALOPS_ORG_ID",
	"MAESTRO_EVALOPS_USER_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"MAESTRO_SESSION_ID",
	"MAESTRO_AGENT_RUN_ID",
	"MAESTRO_AGENT_RUN_STEP_ID",
	"TRACE_ID",
	"MAESTRO_REQUEST_ID",
	"MAESTRO_SURFACE",
];
const originalEnv = new Map(
	ENV_KEYS.map((key) => [key, process.env[key] as string | undefined]),
);

describe("agent tracing identity attributes", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv.get(key);
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
	});

	it("uses EvalOps org, user, workspace, and session defaults for spans", () => {
		process.env.MAESTRO_EVALOPS_ORG_ID = "org_123";
		process.env.MAESTRO_EVALOPS_USER_ID = "user_123";
		process.env.MAESTRO_EVALOPS_WORKSPACE_ID = "workspace_123";
		process.env.MAESTRO_SESSION_ID = "session_123";
		process.env.MAESTRO_AGENT_RUN_ID = "run_123";
		process.env.MAESTRO_AGENT_RUN_STEP_ID = "step_123";
		process.env.TRACE_ID = "trace_123";
		process.env.MAESTRO_REQUEST_ID = "request_123";
		process.env.MAESTRO_SURFACE = "web";

		expect(maestroTraceIdentityAttributes()).toMatchObject({
			"organization.id": "org_123",
			"evalops.organization_id": "org_123",
			"enduser.id": "user_123",
			"user.id": "user_123",
			"agent.user.id": "user_123",
			"workspace.id": "workspace_123",
			"evalops.workspace_id": "workspace_123",
			"agent.session.id": "session_123",
			"maestro.session_id": "session_123",
			"maestro.agent_run_id": "run_123",
			"maestro.agent_run_step_id": "step_123",
			"trace.id": "trace_123",
			"request.id": "request_123",
			"maestro.surface": "MAESTRO_SURFACE_WEB",
		});
	});

	it("lets explicit span context override process defaults", () => {
		process.env.MAESTRO_EVALOPS_ORG_ID = "org_default";
		process.env.MAESTRO_EVALOPS_USER_ID = "user_default";
		process.env.MAESTRO_SESSION_ID = "session_default";

		expect(
			maestroTraceIdentityAttributes({
				organizationId: "org_override",
				userId: "user_override",
				sessionId: "session_override",
			}),
		).toMatchObject({
			"organization.id": "org_override",
			"enduser.id": "user_override",
			"agent.session.id": "session_override",
		});
	});

	it("omits placeholder identity values from span attributes", () => {
		expect(maestroTraceIdentityAttributes()).toMatchObject({
			"agent.session.id": undefined,
			"maestro.session_id": undefined,
		});
	});
});
