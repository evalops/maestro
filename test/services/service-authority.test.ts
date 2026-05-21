import { describe, expect, it } from "vitest";
import { IntelligentRouterService } from "../../src/services/intelligent-router/service.js";
import {
	SERVICE_AUTHORITY_MATRIX_VERSION,
	listServiceAuthorities,
	resolveServiceAuthority,
	serviceAuthorityEnvName,
} from "../../src/services/service-authority.js";
import { WorkspaceConfigService } from "../../src/services/workspace-config/service.js";

describe("service authority matrix", () => {
	it("marks enterprise services as Platform-authoritative when Platform is configured", () => {
		const authority = resolveServiceAuthority("workspace_config", {
			MAESTRO_PLATFORM_BASE_URL: "https://platform.test",
		});

		expect(authority).toMatchObject({
			matrixVersion: SERVICE_AUTHORITY_MATRIX_VERSION,
			id: "workspace_config",
			owner: "platform",
			mode: "platform_authoritative",
			readAuthority: "platform",
			writeAuthority: "platform",
			localWritesAllowed: false,
			platformPrimitive: "WorkspacePolicy",
		});
	});

	it("recognizes legacy EvalOps base URL aliases as Platform configuration", () => {
		for (const envName of [
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"PLATFORM_BASE_URL",
		] as const) {
			const authority = resolveServiceAuthority("workspace_config", {
				[envName]: "https://platform.test",
			});

			expect(authority).toMatchObject({
				mode: "platform_authoritative",
				readAuthority: "platform",
				writeAuthority: "platform",
				reason: "Platform base URL is configured",
			});
		}
	});

	it("keeps explicit standalone mode on the Maestro offline adapter", () => {
		const authority = resolveServiceAuthority("intelligent_router", {
			MAESTRO_PLATFORM_BASE_URL: "https://platform.test",
			MAESTRO_STANDALONE: "1",
		});

		expect(authority).toMatchObject({
			id: "intelligent_router",
			mode: "offline_adapter",
			readAuthority: "maestro",
			writeAuthority: "maestro",
			localWritesAllowed: true,
		});
	});

	it("accepts common truthy forms for offline mode flags", () => {
		for (const [name, value] of [
			["MAESTRO_STANDALONE", "true"],
			["MAESTRO_OFFLINE", "yes"],
			["MAESTRO_OFFLINE", "on"],
		] as const) {
			const authority = resolveServiceAuthority("intelligent_router", {
				MAESTRO_PLATFORM_BASE_URL: "https://platform.test",
				[name]: value,
			});

			expect(authority).toMatchObject({
				id: "intelligent_router",
				mode: "offline_adapter",
				readAuthority: "maestro",
				writeAuthority: "maestro",
				localWritesAllowed: true,
			});
		}
	});

	it("supports service-specific authority overrides", () => {
		const envName = serviceAuthorityEnvName("traces");
		const authority = resolveServiceAuthority("traces", {
			[envName]: "platform",
		});

		expect(envName).toBe("MAESTRO_TRACES_AUTHORITY");
		expect(authority).toMatchObject({
			id: "traces",
			mode: "platform_authoritative",
			localWritesAllowed: true,
			reason: "service-specific or global authority override selected Platform",
		});
	});

	it("lists every tracked service with a deterministic resolution", () => {
		const authorities = listServiceAuthorities({
			MAESTRO_OFFLINE: "1",
		});

		expect(authorities.map((authority) => authority.id)).toEqual([
			"approvals",
			"compliance",
			"governance",
			"intelligent_router",
			"revenue_attribution",
			"traces",
			"usage_analytics",
			"workspace_config",
		]);
		expect(
			authorities
				.filter((authority) => authority.localFallbackAllowed)
				.every((authority) => authority.mode === "offline_adapter"),
		).toBe(true);
		expect(
			authorities.find((authority) => authority.id === "revenue_attribution"),
		).toMatchObject({
			mode: "platform_unavailable",
			readAuthority: "platform",
			writeAuthority: "platform",
			localWritesAllowed: false,
		});
	});

	it("keeps services without local fallback on Platform authority when offline", () => {
		const authority = resolveServiceAuthority("revenue_attribution", {
			MAESTRO_OFFLINE: "1",
		});

		expect(authority).toMatchObject({
			id: "revenue_attribution",
			mode: "platform_unavailable",
			readAuthority: "platform",
			writeAuthority: "platform",
			localWritesAllowed: false,
			reason:
				"offline authority override requested but this service has no Maestro local fallback",
		});
	});

	it("exposes authority on representative local service adapters", () => {
		const workspaceService = new WorkspaceConfigService(
			() => {
				throw new Error("not used");
			},
			() => false,
		);
		const routerService = new IntelligentRouterService();

		expect(workspaceService.getAuthority()).toMatchObject({
			id: "workspace_config",
			owner: "platform",
		});
		expect(routerService.getAuthority()).toMatchObject({
			id: "intelligent_router",
			owner: "platform",
		});
	});
});
