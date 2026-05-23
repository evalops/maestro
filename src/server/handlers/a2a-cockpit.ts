import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildA2ACockpit } from "../../platform/a2a-cockpit.js";
import { sanitizeSessionScope } from "../../session/scope.js";
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
		const storagePaths = scopedA2AStoragePaths(req);
		const cockpit = await buildA2ACockpit({
			registryPath: storagePaths?.registryPath,
			tasksPath: storagePaths?.tasksPath,
			timeoutMs:
				positiveIntegerQuery(url, "timeoutMs", {
					max: MAX_WEB_A2A_COCKPIT_TIMEOUT_MS,
				}) ?? DEFAULT_WEB_A2A_COCKPIT_TIMEOUT_MS,
			peer: optionalQueryString(url, "peer"),
			limit: positiveIntegerQuery(url, "limit"),
		});
		sendJson(res, 200, cockpit, corsHeaders, req);
	} catch (error) {
		respondWithApiError(res, error, 500, corsHeaders, req);
	}
}

function scopedA2AStoragePaths(
	req: IncomingMessage,
): { registryPath: string; tasksPath: string } | undefined {
	const scope = resolveSessionScope(req);
	const safeScope = scope ? sanitizeSessionScope(scope) : "";
	if (!safeScope) {
		return undefined;
	}
	const scopedDir = join(homedir(), ".maestro", "a2a", "scopes", safeScope);
	return {
		registryPath: join(scopedDir, "peers.json"),
		tasksPath: join(scopedDir, "tasks.json"),
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
