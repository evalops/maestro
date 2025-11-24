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

	const body = JSON.stringify(payload);
	const headers: Record<string, string | number> = {
		"Content-Type": "application/json",
		...(corsHeaders || {}),
	};

	// Check for compression support
	// Note: In a real production setup, Nginx/Cloudflare usually handles this.
	// But for a self-contained server, we do it here.
	const req = (res as any).req as IncomingMessage; // Access request from response
	const acceptEncoding = req?.headers["accept-encoding"] || "";

	// Only compress if larger than 1KB
	if (body.length > 1024) {
		if (acceptEncoding.includes("gzip")) {
			headers["Content-Encoding"] = "gzip";
			res.writeHead(status, headers);
			const gzip = createGzip();
			gzip.pipe(res);
			gzip.end(body);
			return;
		}

		if (acceptEncoding.includes("deflate")) {
			headers["Content-Encoding"] = "deflate";
			res.writeHead(status, headers);
			const deflate = createDeflate();
			deflate.pipe(res);
			deflate.end(body);
			return;
		}
	}

	res.writeHead(status, headers);
	res.end(body);
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
	const status = Status.fromError(error);
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
	);
	return true;
}
