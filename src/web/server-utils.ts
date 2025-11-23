import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class ApiError extends Error {
	constructor(
		public statusCode: number,
		message: string,
	) {
		super(message);
	}
}

export function createCorsHeaders(origin: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, X-Composer-Api-Key, X-Composer-Approval-Mode",
		"Access-Control-Max-Age": "86400",
	};
	if (origin !== "*") {
		headers["Access-Control-Allow-Credentials"] = "true";
	}
	return headers;
}

export async function readRequestBody(
	req: IncomingMessage,
	limit = 1_000_000,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let total = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			const nextTotal = total + chunk.length;
			if (nextTotal > limit) {
				req.removeAllListeners("data");
				req.removeAllListeners("end");
				req.destroy();
				reject(new ApiError(413, "Payload too large"));
				return;
			}
			total = nextTotal;
			chunks.push(chunk);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks));
		});
		req.on("error", (error) => {
			reject(error);
		});
	});
}

export async function readJsonBody<T>(
	req: IncomingMessage,
	limit = 1_000_000,
): Promise<T> {
	const raw = await readRequestBody(req, limit);
	if (!raw.length) {
		return {} as T;
	}
	try {
		return JSON.parse(raw.toString()) as T;
	} catch {
		throw new ApiError(400, "Invalid JSON payload");
	}
}

export function sendJson(
	res: ServerResponse,
	status: number,
	payload: unknown,
	corsHeaders?: Record<string, string>,
): void {
	if (res.writableEnded) return;
	res.writeHead(status, {
		"Content-Type": "application/json",
		...(corsHeaders || {}),
	});
	res.end(JSON.stringify(payload));
}

export function secureCompare(value: string, secret: string): boolean {
	const hashProvided = createHash("sha256").update(value).digest();
	const hashSecret = createHash("sha256").update(secret).digest();
	return timingSafeEqual(hashProvided, hashSecret);
}

export function getRequestToken(req: IncomingMessage): string | null {
	const authHeader = req.headers.authorization;
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.slice(7).trim() || null;
	}
	const apiKeyHeader = req.headers["x-composer-api-key"];
	if (Array.isArray(apiKeyHeader)) {
		return apiKeyHeader[0]?.trim() || null;
	}
	if (typeof apiKeyHeader === "string") {
		return apiKeyHeader.trim() || null;
	}
	return null;
}

export function authenticateRequest(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
	webApiKey: string | null,
): boolean {
	if (!webApiKey) {
		return true;
	}
	const provided = getRequestToken(req);
	if (!provided || !secureCompare(provided, webApiKey)) {
		sendJson(res, 401, { error: "Unauthorized" }, corsHeaders);
		return false;
	}
	return true;
}

export function respondWithApiError(
	res: ServerResponse,
	error: unknown,
	fallbackStatus = 500,
	corsHeaders?: Record<string, string>,
): boolean {
	if (error instanceof ApiError) {
		sendJson(res, error.statusCode, { error: error.message }, corsHeaders);
		return true;
	}
	if (fallbackStatus) {
		sendJson(
			res,
			fallbackStatus,
			{
				error: error instanceof Error ? error.message : "Internal server error",
			},
			corsHeaders,
		);
		return true;
	}
	return false;
}
