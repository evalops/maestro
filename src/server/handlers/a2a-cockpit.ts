import type { IncomingMessage, ServerResponse } from "node:http";
import { buildA2ACockpit } from "../../platform/a2a-cockpit.js";
import type { A2AOwnershipScope } from "../../platform/a2a-ownership.js";
import { getVerifiedRequestPrincipal } from "../authz.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";
import { resolveSessionScope } from "../session-scope.js";

const DEFAULT_WEB_A2A_COCKPIT_TIMEOUT_MS = 2_500;
const MAX_WEB_A2A_COCKPIT_TIMEOUT_MS = 10_000;

export async function handleA2ACockpit(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	try {
		if (req.method !== "GET") {
			throw new ApiError(405, "Method not allowed");
		}
		const url = new URL(req.url ?? "/api/a2a/cockpit", "http://localhost");
		rejectHostedPathOverrides(url);
		const cockpit = await buildA2ACockpit({
			registryPath: undefined,
			tasksPath: undefined,
			timeoutMs:
				positiveIntegerQuery(url, "timeoutMs", {
					max: MAX_WEB_A2A_COCKPIT_TIMEOUT_MS,
				}) ?? DEFAULT_WEB_A2A_COCKPIT_TIMEOUT_MS,
			peer: optionalQueryString(url, "peer"),
			limit: positiveIntegerQuery(url, "limit"),
			ownershipScope: ownershipScopeForRequest(req),
		});
		sendJson(res, 200, cockpit, corsHeaders, req);
	} catch (error) {
		respondWithApiError(res, error, 500, corsHeaders, req);
	}
}

function ownershipScopeForRequest(
	req: IncomingMessage,
): A2AOwnershipScope | undefined {
	const scopeKey = resolveSessionScope(req);
	if (!scopeKey) {
		return undefined;
	}
	const principal = getVerifiedRequestPrincipal(req);
	return {
		scopeKey,
		...(principal?.subject ? { subject: principal.subject } : {}),
		...(principal?.userId ? { userId: principal.userId } : {}),
		...(principal?.keyId ? { keyId: principal.keyId } : {}),
		...(principal?.workspaceId ? { workspaceId: principal.workspaceId } : {}),
		...(principal?.orgId ? { orgId: principal.orgId } : {}),
		...(principal?.teamId ? { teamId: principal.teamId } : {}),
	};
}

function rejectHostedPathOverrides(url: URL): void {
	const blockedParams = ["registry", "tasks"].filter((key) =>
		url.searchParams.has(key),
	);
	if (blockedParams.length > 0) {
		throw new ApiError(
			400,
			`${blockedParams.join(", ")} query parameter${
				blockedParams.length === 1 ? " is" : "s are"
			} not supported by the hosted A2A cockpit`,
		);
	}
}

function optionalQueryString(url: URL, key: string): string | undefined {
	const value = url.searchParams.get(key)?.trim();
	return value ? value : undefined;
}

function positiveIntegerQuery(
	url: URL,
	key: string,
	options: { max?: number } = {},
): number | undefined {
	const value = optionalQueryString(url, key);
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new ApiError(400, `${key} must be a positive integer`);
	}
	if (options.max !== undefined && parsed > options.max) {
		throw new ApiError(400, `${key} must be at most ${options.max}`);
	}
	return parsed;
}
