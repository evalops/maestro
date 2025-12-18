import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { createDeflate, createGzip } from "node:zlib";
import { Code, Status, StatusError } from "./status.js";

const pipe = promisify(pipeline);

export class ApiError extends StatusError {
	constructor(
		public statusCode: number,
		message: string,
		details: Record<string, unknown>[] = [],
	) {
		let code = Code.UNKNOWN;
		switch (statusCode) {
			case 400:
				code = Code.INVALID_ARGUMENT;
				break;
			case 401:
				code = Code.UNAUTHENTICATED;
				break;
			case 403:
				code = Code.PERMISSION_DENIED;
				break;
			case 404:
				code = Code.NOT_FOUND;
				break;
			case 409:
				code = Code.ALREADY_EXISTS;
				break;
			case 429:
				code = Code.RESOURCE_EXHAUSTED;
				break;
			case 500:
				code = Code.INTERNAL;
				break;
			case 501:
				code = Code.UNIMPLEMENTED;
				break;
			case 503:
				code = Code.UNAVAILABLE;
				break;
			case 504:
				code = Code.DEADLINE_EXCEEDED;
				break;
		}
		const status = new Status(
			code,
			message,
			details.map((d) => ({
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				...d,
			})),
		);
		super(status);
		this.statusCode = statusCode;
	}
}

export function createCorsHeaders(origin: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, X-Composer-Api-Key, X-Composer-Approval-Mode, X-Composer-Csrf, X-Csrf-Token, X-Xsrf-Token",
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
	req?: IncomingMessage,
): void {
	if (res.writableEnded || res.headersSent) return;

	const body = JSON.stringify(payload);
	const headers: Record<string, string | number> = {
		"Content-Type": "application/json",
		...(corsHeaders || {}),
	};

	// Prefer explicit request; fall back to ServerResponse.req when available.
	const request =
		req ||
		((res as unknown as { req?: IncomingMessage }).req as
			| IncomingMessage
			| undefined);
	const acceptEncoding =
		request?.headers["accept-encoding"]?.toLowerCase() || "";

	// If we cannot inspect the request, respond uncompressed explicitly.
	if (!request) {
		headers["Content-Encoding"] = "identity";
		res.writeHead(status, headers);
		res.end(body);
		return;
	}

	// Only compress if larger than 1KB
	if (body.length > 1024) {
		if (acceptEncoding.includes("gzip") || acceptEncoding.includes("*")) {
			headers["Content-Encoding"] = "gzip";
			res.writeHead(status, headers);
			const gzip = createGzip();
			// Handle compression stream errors to prevent process crash
			gzip.on("error", (err) => {
				// Stream error during compression - destroy streams cleanly
				gzip.destroy();
				if (!res.writableEnded) {
					res.destroy(err);
				}
			});
			res.on("error", () => {
				// Client disconnect - destroy compression stream
				gzip.destroy();
			});
			gzip.pipe(res);
			gzip.end(body);
			return;
		}

		if (acceptEncoding.includes("deflate")) {
			headers["Content-Encoding"] = "deflate";
			res.writeHead(status, headers);
			const deflate = createDeflate();
			// Handle compression stream errors to prevent process crash
			deflate.on("error", (err) => {
				// Stream error during compression - destroy streams cleanly
				deflate.destroy();
				if (!res.writableEnded) {
					res.destroy(err);
				}
			});
			res.on("error", () => {
				// Client disconnect - destroy compression stream
				deflate.destroy();
			});
			deflate.pipe(res);
			deflate.end(body);
			return;
		}
	}

	res.writeHead(status, headers);
	res.end(body);
}

export function buildContentDisposition(filename: string): string {
	// Avoid header injection via CRLF, and keep the value ASCII-safe.
	const trimmed = (filename || "")
		.replaceAll("\r", "")
		.replaceAll("\n", "")
		.trim();
	const safe = trimmed.length > 0 ? trimmed : "attachment";
	return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`;
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
		sendJson(res, 401, { error: "Unauthorized" }, corsHeaders, req);
		return false;
	}
	return true;
}

export function respondWithApiError(
	res: ServerResponse,
	error: unknown,
	fallbackStatus = 500,
	corsHeaders?: Record<string, string>,
	req?: IncomingMessage,
): boolean {
	const originalStatus = Status.fromError(error);
	// Clone to avoid mutation of original error status
	const status = new Status(
		originalStatus.code,
		originalStatus.message,
		originalStatus.details,
	);
	let statusCode = status.toHttpCode();

	// Preserve explicit status codes from ApiError
	if (error instanceof ApiError) {
		statusCode = error.statusCode;
	} else if (status.code === Code.UNKNOWN && fallbackStatus) {
		// If generic unknown, use fallback if provided
		statusCode = fallbackStatus;
		// Map HTTP fallback back to Status Code if possible for consistency
		if (statusCode === 500) status.code = Code.INTERNAL;
		else if (statusCode === 400) status.code = Code.INVALID_ARGUMENT;
		else if (statusCode === 404) status.code = Code.NOT_FOUND;
	}

	sendJson(
		res,
		statusCode,
		{
			error: status.message,
			code: Code[status.code],
			details: status.details.length ? status.details : undefined,
		},
		corsHeaders,
		req,
	);
	return true;
}
