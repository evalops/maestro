import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	authenticateRequest,
	getRequestToken,
	secureCompare,
	sendJson,
} from "./server-utils.js";

const WEB_API_KEY = process.env.COMPOSER_WEB_API_KEY?.trim() || null;
const CSRF_TOKEN = process.env.COMPOSER_WEB_CSRF_TOKEN?.trim() || null;

export function requireApiAuth(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): boolean {
	if (!WEB_API_KEY) {
		sendJson(
			res,
			401,
			{
				error:
					"COMPOSER_WEB_API_KEY required. Set COMPOSER_WEB_API_KEY and COMPOSER_WEB_CSRF_TOKEN for protected endpoints.",
			},
			corsHeaders,
			req,
		);
		return false;
	}
	return authenticateRequest(req, res, corsHeaders, WEB_API_KEY);
}

export function requireCsrf(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): boolean {
	const method = (req.method || "GET").toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
		return true;
	}
	if (!CSRF_TOKEN) {
		sendJson(
			res,
			403,
			{
				error:
					"COMPOSER_WEB_CSRF_TOKEN is required for state-changing requests",
			},
			corsHeaders,
			req,
		);
		return false;
	}
	const header =
		req.headers["x-composer-csrf"] ||
		req.headers["x-csrf-token"] ||
		req.headers["x-xsrf-token"];
	const value = Array.isArray(header) ? header[0] : header;
	if (!value || !secureCompare(String(value), CSRF_TOKEN)) {
		sendJson(
			res,
			403,
			{ error: "Forbidden: invalid CSRF token" },
			corsHeaders,
			req,
		);
		return false;
	}
	return true;
}

// Derive a stable subject key from provided token (API key) for per-user scoping
export function getAuthSubject(req: IncomingMessage): string {
	const token = getRequestToken(req);
	if (!token) return "anon";
	const digest = createHash("sha256").update(token).digest("hex");
	return `key:${digest.slice(0, 16)}`;
}
