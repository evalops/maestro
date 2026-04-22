import { describe, expect, it } from "vitest";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_CONNECT_SERVICES,
	PLATFORM_HTTP_ROUTES,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "../../src/platform/core-services.js";

describe("Platform core service contract names", () => {
	it("pins Connect service and method paths used by Maestro clients", () => {
		expect(platformConnectServicePath(PLATFORM_CONNECT_SERVICES.prompts)).toBe(
			"/prompts.v1.PromptService",
		);
		expect(
			platformConnectMethodPath(PLATFORM_CONNECT_METHODS.prompts.resolve),
		).toBe("/prompts.v1.PromptService/Resolve");
		expect(
			platformConnectMethodPath(PLATFORM_CONNECT_METHODS.meter.ingestWideEvent),
		).toBe("/meter.v1.MeterService/IngestWideEvent");
		expect(
			platformConnectMethodPath(PLATFORM_CONNECT_METHODS.meter.queryWideEvents),
		).toBe("/meter.v1.MeterService/QueryWideEvents");
		expect(
			platformConnectMethodPath(
				PLATFORM_CONNECT_METHODS.meter.getEventDashboard,
			),
		).toBe("/meter.v1.MeterService/GetEventDashboard");
		expect(
			platformConnectMethodPath(
				PLATFORM_CONNECT_METHODS.approvals.requestApproval,
			),
		).toBe("/approvals.v1.ApprovalService/RequestApproval");
		expect(
			platformConnectMethodPath(
				PLATFORM_CONNECT_METHODS.governance.evaluateAction,
			),
		).toBe("/governance.v1.GovernanceService/EvaluateAction");
		expect(
			platformConnectMethodPath(
				PLATFORM_CONNECT_METHODS.connectors.listConnections,
			),
		).toBe("/connectors.v1.ConnectorService/ListConnections");
		expect(
			platformConnectMethodPath(
				PLATFORM_CONNECT_METHODS.llmGateway.createMessage,
			),
		).toBe("/llmgateway.v1.GatewayService/CreateMessage");
	});

	it("keeps durable memory on the existing HTTP JSON route", () => {
		expect(PLATFORM_HTTP_ROUTES.memory.recall).toBe("/v1/memories/recall");
	});

	it("pins identity HTTP routes used by EvalOps login and delegation", () => {
		expect(PLATFORM_HTTP_ROUTES.identity.authGoogleStart).toBe(
			"/v1/auth/google/start",
		);
		expect(PLATFORM_HTTP_ROUTES.identity.tokenRefresh).toBe(
			"/v1/tokens/refresh",
		);
		expect(PLATFORM_HTTP_ROUTES.identity.tokenRevoke).toBe("/v1/tokens/revoke");
		expect(PLATFORM_HTTP_ROUTES.identity.delegationTokens).toBe(
			"/v1/delegation-tokens",
		);
	});
});
