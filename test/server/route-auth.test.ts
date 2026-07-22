import { describe, expect, it } from "vitest";
import { createEnterpriseRoutes } from "../../src/api/enterprise-routes.js";
import { isDatabaseConfigured } from "../../src/db/client.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import {
	ENTERPRISE_ROUTE_AUTH_POLICIES,
	ROUTE_AUTH_POLICIES,
	findRouteAuthPolicy,
	withRouteAuthPolicies,
} from "../../src/server/route-auth.js";
import type { Route } from "../../src/server/router.js";
import { createRoutes } from "../../src/server/routes.js";

async function failUnused<T>(): Promise<T> {
	throw new Error("Unexpected test dependency call");
}

function createContext(): WebServerContext {
	return {
		corsHeaders: { "Access-Control-Allow-Origin": "*" },
		staticMaxAge: 0,
		defaultApprovalMode: "default",
		defaultProvider: "openai",
		defaultModelId: "gpt-4o-mini",
		getRegisteredModel: () => failUnused(),
		getCurrentSelection: () => ({
			provider: "openai",
			modelId: "gpt-4o-mini",
		}),
		ensureCredential: () => failUnused(),
		setModelSelection: () => {},
		acquireSse: () => null,
		releaseSse: () => {},
		headlessRuntimeService: {} as WebServerContext["headlessRuntimeService"],
	};
}

describe("route auth registry", () => {
	it("attaches an explicit auth policy to every server route", () => {
		const routes = createRoutes(createContext());
		const expectedRouteCount =
			ROUTE_AUTH_POLICIES.length +
			(isDatabaseConfigured() ? ENTERPRISE_ROUTE_AUTH_POLICIES.length : 0);

		expect(routes.length).toBe(expectedRouteCount);
		expect(routes.every((route) => Boolean(route.auth))).toBe(true);
	});

	it("fails startup validation when a mutation route has no policy", () => {
		const routes: Route[] = [
			{
				method: "POST",
				path: "/api/unregistered",
				handler: () => {},
			},
		];

		expect(() => withRouteAuthPolicies(routes, [])).toThrow(
			"Missing route auth policies: POST /api/unregistered",
		);
	});

	it("keeps enterprise routes covered when database-backed routes are enabled", () => {
		const routes = createEnterpriseRoutes({
			"Access-Control-Allow-Origin": "*",
		});
		const protectedRoutes = withRouteAuthPolicies(
			routes,
			ENTERPRISE_ROUTE_AUTH_POLICIES,
		);

		expect(protectedRoutes.length).toBe(ENTERPRISE_ROUTE_AUTH_POLICIES.length);
		expect(protectedRoutes.every((route) => Boolean(route.auth))).toBe(true);
	});

	it("matches dynamic route policies for owner and artifact routes", () => {
		const routes = createRoutes(createContext());

		expect(
			findRouteAuthPolicy(
				"GET",
				"/api/sessions/session-1/artifacts/report.html/view",
				routes,
			),
		).toEqual({ level: "owner", allowArtifactAccess: true });
		expect(
			findRouteAuthPolicy("PATCH", "/api/sessions/session-1", routes),
		).toEqual({ level: "owner" });
	});
});
