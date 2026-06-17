import { HOSTED_RUNNER_DRAIN_PATH } from "./handlers/hosted-runner-drain.js";
import { HOSTED_RUNNER_IDENTITY_PATH } from "./handlers/hosted-runner-identity.js";
import { PLATFORM_A2A_PUSH_CALLBACK_PATH } from "./handlers/platform-a2a-push.js";
import type { Route, RouteAuthLevel, RouteAuthPolicy } from "./router.js";

export interface RouteAuthPolicyEntry {
	method: string;
	path: string;
	auth: RouteAuthPolicy;
}

function p(
	method: string,
	path: string,
	level: RouteAuthLevel,
	options: Omit<RouteAuthPolicy, "level"> = {},
): RouteAuthPolicyEntry {
	return { method, path, auth: { level, ...options } };
}

export const ROUTE_AUTH_POLICIES: readonly RouteAuthPolicyEntry[] = [
	p("GET", "/healthz", "public"),
	p("GET", "/readyz", "public"),
	p("GET", HOSTED_RUNNER_IDENTITY_PATH, "public"),
	p("POST", HOSTED_RUNNER_DRAIN_PATH, "public"),
	p("POST", PLATFORM_A2A_PUSH_CALLBACK_PATH, "authenticated"),
	p("GET", "/api/a2a/cockpit", "authenticated"),
	p("POST", "/api/headless/connections", "authenticated"),
	p("POST", "/api/headless/sessions", "authenticated"),
	p("GET", "/api/headless/sessions/:id", "authenticated"),
	p("GET", "/api/headless/sessions/:id/events", "authenticated"),
	p("POST", "/api/headless/sessions/:id/subscribe", "authenticated"),
	p("POST", "/api/headless/sessions/:id/unsubscribe", "authenticated"),
	p("POST", "/api/headless/sessions/:id/heartbeat", "authenticated"),
	p("POST", "/api/headless/sessions/:id/disconnect", "authenticated"),
	p("POST", "/api/headless/sessions/:id/messages", "authenticated"),
	p("GET", "/debug/z", "authenticated"),
	p("GET", "/api/files", "authenticated"),
	p("GET", "/api/commands", "authenticated"),
	p("GET", "/api/command-prefs", "authenticated"),
	p("POST", "/api/command-prefs", "authenticated"),
	p("GET", "/api/models", "authenticated"),
	p("GET", "/api/status", "authenticated"),
	p("POST", "/api/prompt-suggestion", "authenticated"),
	p("POST", "/api/status", "authenticated"),
	p("GET", "/api/bridge/status", "authenticated"),
	p("GET", "/api/config", "authenticated"),
	p("POST", "/api/config", "authenticated"),
	p("GET", "/api/guardian/status", "authenticated"),
	p("POST", "/api/guardian/run", "authenticated"),
	p("POST", "/api/guardian/config", "authenticated"),
	p("GET", "/api/plan", "authenticated"),
	p("POST", "/api/plan", "authenticated"),
	p("GET", "/api/mcp", "authenticated"),
	p("POST", "/api/mcp", "authenticated"),
	p("GET", "/api/package", "authenticated"),
	p("POST", "/api/package", "authenticated"),
	p("GET", "/api/usage", "authenticated"),
	p("GET", "/api/usage/analytics", "authenticated"),
	p("GET", "/api/usage/analytics/:period", "authenticated"),
	p("POST", "/api/traces", "authenticated"),
	p("GET", "/api/traces", "authenticated"),
	p("GET", "/api/traces/:id", "authenticated"),
	p("GET", "/api/workspace-configs", "authenticated"),
	p("POST", "/api/workspace-configs", "authenticated"),
	p("GET", "/api/workspace-configs/:workspaceId", "authenticated"),
	p("PUT", "/api/workspace-configs/:workspaceId", "authenticated"),
	p("DELETE", "/api/workspace-configs/:workspaceId", "authenticated"),
	p("POST", "/api/compliance/generate-report", "authenticated"),
	p("GET", "/api/compliance/controls", "authenticated"),
	p("GET", "/api/compliance/evidence/:controlId", "authenticated"),
	p("POST", "/api/attribution/record-outcome", "authenticated"),
	p("GET", "/api/attribution/roi/:agentId", "authenticated"),
	p("GET", "/api/intelligent-router/decisions", "authenticated"),
	p("POST", "/api/intelligent-router/decisions", "authenticated"),
	p("GET", "/api/intelligent-router/metrics", "authenticated"),
	p("POST", "/api/intelligent-router/metrics", "authenticated"),
	p("GET", "/api/intelligent-router/overrides", "authenticated"),
	p("POST", "/api/intelligent-router/overrides", "authenticated"),
	p("DELETE", "/api/intelligent-router/overrides/:taskType", "authenticated"),
	p("GET", "/api/fleet", "authenticated"),
	p("GET", "/api/background", "authenticated"),
	p("POST", "/api/background", "authenticated"),
	p("GET", "/api/automations", "authenticated"),
	p("POST", "/api/automations", "authenticated"),
	p("POST", "/api/automations/preview", "authenticated"),
	p("GET", "/api/automations/magic-docs", "authenticated"),
	p("PATCH", "/api/automations/:id", "authenticated"),
	p("DELETE", "/api/automations/:id", "authenticated"),
	p("POST", "/api/automations/:id/run", "authenticated"),
	p("GET", "/api/undo", "authenticated"),
	p("POST", "/api/undo", "authenticated"),
	p("GET", "/api/changes", "authenticated"),
	p("GET", "/api/approvals", "authenticated"),
	p("POST", "/api/approvals", "authenticated"),
	p("GET", "/api/framework", "authenticated"),
	p("POST", "/api/framework", "authenticated"),
	p("GET", "/api/tools", "authenticated"),
	p("GET", "/api/review", "authenticated"),
	p("GET", "/api/context", "authenticated"),
	p("GET", "/api/stats", "authenticated"),
	p("GET", "/api/telemetry", "authenticated"),
	p("POST", "/api/telemetry", "authenticated"),
	p("GET", "/api/training", "authenticated"),
	p("POST", "/api/training", "authenticated"),
	p("GET", "/api/diagnostics", "authenticated"),
	p("GET", "/api/lsp", "authenticated"),
	p("POST", "/api/lsp", "authenticated"),
	p("GET", "/api/workflow", "authenticated"),
	p("POST", "/api/workflow", "authenticated"),
	p("GET", "/api/run", "authenticated"),
	p("POST", "/api/run", "authenticated"),
	p("GET", "/api/ollama", "authenticated"),
	p("POST", "/api/ollama", "authenticated"),
	p("GET", "/api/preview", "authenticated"),
	p("GET", "/api/composer", "authenticated"),
	p("POST", "/api/composer", "authenticated"),
	p("GET", "/api/cost", "authenticated"),
	p("POST", "/api/cost", "authenticated"),
	p("GET", "/api/quota", "authenticated"),
	p("POST", "/api/quota", "authenticated"),
	p("GET", "/api/memory", "authenticated"),
	p("POST", "/api/memory", "authenticated"),
	p("GET", "/api/mode", "authenticated"),
	p("POST", "/api/mode", "authenticated"),
	p("GET", "/api/zen", "authenticated"),
	p("POST", "/api/zen", "authenticated"),
	p("GET", "/api/ui", "authenticated"),
	p("POST", "/api/ui", "authenticated"),
	p("GET", "/api/queue", "authenticated"),
	p("POST", "/api/queue", "authenticated"),
	p("GET", "/api/branch", "authenticated"),
	p("POST", "/api/branch", "authenticated"),
	p("GET", "/api/model", "authenticated"),
	p("POST", "/api/model", "authenticated"),
	p("GET", "/api/metrics", "authenticated"),
	p("POST", "/api/chat", "authenticated"),
	p("POST", "/api/pending-requests/:requestId/resume", "owner"),
	p("POST", "/api/chat/approval", "authenticated"),
	p("POST", "/api/chat/client-tool-result", "authenticated"),
	p("POST", "/api/chat/tool-retry", "authenticated"),
	p("POST", "/api/attachments/extract", "authenticated"),
	p("GET", "/api/sessions/:id/artifacts", "owner"),
	p("GET", "/api/sessions/:id/artifact-access", "owner"),
	p("GET", "/api/sessions/:id/artifacts.zip", "owner", {
		allowArtifactAccess: true,
	}),
	p("GET", "/api/sessions/:id/artifacts/events", "owner", {
		allowArtifactAccess: true,
	}),
	p("GET", "/api/sessions/:id/artifacts/:filename", "owner", {
		allowArtifactAccess: true,
	}),
	p("GET", "/api/sessions/:id/artifacts/:filename/view", "owner", {
		allowArtifactAccess: true,
	}),
	p("GET", "/api/sessions/:id/attachments/:attachmentId", "owner"),
	p("POST", "/api/sessions/:id/attachments/:attachmentId/extract", "owner"),
	p("GET", "/api/sessions/:id/timeline", "owner"),
	p("GET", "/api/sessions/:id/replay-lab", "owner"),
	p("GET", "/api/sessions", "authenticated"),
	p("POST", "/api/sessions", "authenticated"),
	p("GET", "/api/sessions/:id", "owner"),
	p("PATCH", "/api/sessions/:id", "owner"),
	p("DELETE", "/api/sessions/:id", "owner"),
	p("POST", "/api/sessions/:id/share", "owner"),
	p("POST", "/api/sessions/:id/export", "owner"),
	p("GET", "/api/sessions/shared/:token", "authenticated"),
	p(
		"GET",
		"/api/sessions/shared/:token/attachments/:attachmentId",
		"authenticated",
	),
	p("POST", "/api/policy/validate", "authenticated"),
	p("POST", "/api/admin/cleanup", "authenticated"),
	p("POST", "/api/admin/warm-caches", "authenticated"),
] as const;

export const ENTERPRISE_ROUTE_AUTH_POLICIES: readonly RouteAuthPolicyEntry[] = [
	p("POST", "/api/auth/register", "public"),
	p("POST", "/api/auth/login", "public"),
	p("GET", "/api/auth/me", "authenticated"),
	p("GET", "/api/usage/quota", "authenticated"),
	p("GET", "/api/usage/org", "authenticated"),
	p("GET", "/api/audit/logs", "authenticated"),
	p("GET", "/api/alerts", "authenticated"),
	p("POST", "/api/alerts/:alertId/read", "authenticated"),
	p("POST", "/api/alerts/:alertId/resolve", "authenticated"),
	p("GET", "/api/org/members", "authenticated"),
	p("POST", "/api/org/members/invite", "authenticated"),
	p("PUT", "/api/org/members/:userId/role", "authenticated"),
	p("PUT", "/api/org/members/:userId/quota", "authenticated"),
	p("DELETE", "/api/org/members/:userId", "authenticated"),
	p("GET", "/api/org/settings", "authenticated"),
	p("PUT", "/api/org/settings", "authenticated"),
	p("GET", "/api/roles", "authenticated"),
	p("GET", "/api/models/approvals", "authenticated"),
	p("POST", "/api/models/approvals/:modelId/approve", "authenticated"),
	p("POST", "/api/models/approvals/:modelId/deny", "authenticated"),
	p("GET", "/api/directory-rules", "authenticated"),
	p("POST", "/api/directory-rules", "authenticated"),
	p("DELETE", "/api/directory-rules/:ruleId", "authenticated"),
] as const;

function routeKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${path}`;
}

function toSegments(pathname: string): string[] {
	if (pathname === "/" || pathname === "") return [];
	return pathname.replace(/^\/+|\/+$/g, "").split("/");
}

function pathMatches(pattern: string, pathname: string): boolean {
	const patternSegments = toSegments(pattern);
	const pathSegments = toSegments(pathname);
	if (patternSegments.length !== pathSegments.length) return false;
	for (let i = 0; i < patternSegments.length; i++) {
		const patternSegment = patternSegments[i]!;
		const pathSegment = pathSegments[i]!;
		if (patternSegment.startsWith(":")) continue;
		if (patternSegment !== pathSegment) return false;
	}
	return true;
}

function validateUniquePolicies(
	policies: readonly RouteAuthPolicyEntry[],
): Map<string, RouteAuthPolicy> {
	const policyByRoute = new Map<string, RouteAuthPolicy>();
	const duplicates: string[] = [];
	for (const policy of policies) {
		const key = routeKey(policy.method, policy.path);
		if (policyByRoute.has(key)) {
			duplicates.push(key);
			continue;
		}
		policyByRoute.set(key, policy.auth);
	}
	if (duplicates.length > 0) {
		throw new Error(
			`Duplicate route auth policy entries: ${duplicates.join(", ")}`,
		);
	}
	return policyByRoute;
}

export function withRouteAuthPolicies(
	routes: readonly Route[],
	policies: readonly RouteAuthPolicyEntry[] = ROUTE_AUTH_POLICIES,
): Route[] {
	const policyByRoute = validateUniquePolicies(policies);
	const routeKeys = new Set<string>();
	const duplicates: string[] = [];
	const missing: string[] = [];

	for (const route of routes) {
		const key = routeKey(route.method, route.path);
		if (routeKeys.has(key)) {
			duplicates.push(key);
		}
		routeKeys.add(key);
		if (!policyByRoute.has(key)) {
			missing.push(key);
		}
	}

	const stale = Array.from(policyByRoute.keys()).filter(
		(key) => !routeKeys.has(key),
	);
	const failures = [
		duplicates.length > 0
			? `Duplicate route definitions: ${duplicates.join(", ")}`
			: null,
		missing.length > 0
			? `Missing route auth policies: ${missing.join(", ")}`
			: null,
		stale.length > 0 ? `Stale route auth policies: ${stale.join(", ")}` : null,
	].filter((value): value is string => Boolean(value));

	if (failures.length > 0) {
		throw new Error(failures.join("; "));
	}

	return routes.map((route) => ({
		...route,
		auth: policyByRoute.get(routeKey(route.method, route.path)),
	}));
}

export function findRouteAuthPolicy(
	method: string,
	pathname: string,
	routes: readonly Route[],
): RouteAuthPolicy | null {
	const targetMethod = method.toUpperCase();
	for (const route of routes) {
		if (route.method.toUpperCase() !== targetMethod) continue;
		if (pathMatches(route.path, pathname)) {
			return route.auth ?? null;
		}
	}
	return null;
}
