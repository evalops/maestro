import type { IncomingMessage, ServerResponse } from "node:http";
import { warmHashCache } from "../../audit/integrity.js";
import {
	cleanupExpiredRevocations,
	warmUserRevocationCache,
} from "../../auth/token-revocation.js";
import { cleanupRateLimits, cleanupUsedCodes } from "../../auth/totp.js";
import { isDbAvailable } from "../../db/client.js";
import { cleanupWebhookQueue } from "../../webhooks/delivery.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

export interface CleanupResult {
	success: boolean;
	results: {
		revokedTokens: number | null;
		totpCodes: number | null;
		rateLimits: number | null;
		webhooks: number | null;
	};
	totalCleaned: number;
	durationMs: number;
}

export interface CacheWarmResult {
	success: boolean;
	results: {
		revocationCache: number | null;
		hashCache: number | null;
	};
	durationMs: number;
}

export async function handleAdminCleanup(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
): Promise<void> {
	if (req.method !== "POST") {
		sendJson(res, 405, { error: "Method not allowed" }, cors, req);
		return;
	}

	if (!isDbAvailable()) {
		sendJson(res, 503, { error: "Database not available" }, cors, req);
		return;
	}

	try {
		const start = performance.now();

		const results = await Promise.allSettled([
			cleanupExpiredRevocations(),
			cleanupUsedCodes(),
			cleanupRateLimits(),
			cleanupWebhookQueue(),
		]);

		const counts = {
			revokedTokens:
				results[0].status === "fulfilled" ? results[0].value : null,
			totpCodes: results[1].status === "fulfilled" ? results[1].value : null,
			rateLimits: results[2].status === "fulfilled" ? results[2].value : null,
			webhooks: results[3].status === "fulfilled" ? results[3].value : null,
		};

		let totalCleaned = 0;
		for (const v of Object.values(counts)) {
			totalCleaned += v ?? 0;
		}

		const result: CleanupResult = {
			success: results.every((r) => r.status === "fulfilled"),
			results: counts,
			totalCleaned,
			durationMs: Math.round(performance.now() - start),
		};

		sendJson(res, 200, result, cors, req);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

export async function handleAdminWarmCaches(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
): Promise<void> {
	if (req.method !== "POST") {
		sendJson(res, 405, { error: "Method not allowed" }, cors, req);
		return;
	}

	if (!isDbAvailable()) {
		sendJson(res, 503, { error: "Database not available" }, cors, req);
		return;
	}

	try {
		const start = performance.now();

		const results = await Promise.allSettled([
			warmUserRevocationCache(),
			warmHashCache(),
		]);

		const result: CacheWarmResult = {
			success: results.every((r) => r.status === "fulfilled"),
			results: {
				revocationCache:
					results[0].status === "fulfilled" ? results[0].value : null,
				hashCache: results[1].status === "fulfilled" ? results[1].value : null,
			},
			durationMs: Math.round(performance.now() - start),
		};

		sendJson(res, 200, result, cors, req);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}
