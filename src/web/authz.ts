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
const SHARED_SECRET = process.env.COMPOSER_AUTH_SHARED_SECRET?.trim() || null;
const JWT_SECRET = process.env.COMPOSER_JWT_SECRET?.trim() || null;

function base64UrlDecode(input: string): string {
	return Buffer.from(
		input.replace(/-/g, "+").replace(/_/g, "/"),
		"base64",
	).toString("utf-8");
}

function verifySharedToken(token: string): string | null {
	if (!SHARED_SECRET) return null;
	// Format: base64url(userId).signature
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const user = parts[0];
	const providedSig = parts[1];
	let userId: string;
	try {
		userId = base64UrlDecode(user);
	} catch {
		return null;
	}
	const hmac = createHash("sha256");
	hmac.update(userId + SHARED_SECRET);
	const expected = hmac.digest("hex");
	if (!secureCompare(providedSig, expected)) return null;
	return userId;
}

function verifyHs256Jwt(token: string): { sub?: string } | null {
	if (!JWT_SECRET) return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [h, p, sig] = parts;
	const data = `${h}.${p}`;
	const expected = createHash("sha256")
		.update(data + JWT_SECRET)
		.digest("base64url");
	if (!secureCompare(sig, expected)) return null;
	try {
		const payload = JSON.parse(base64UrlDecode(p)) as { sub?: string };
		return payload;
	} catch {
		return null;
	}
}

export function requireApiAuth(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): boolean {
	const bearer = getRequestToken(req);
	const jwtPayload = bearer ? verifyHs256Jwt(bearer) : null;
	const userId = bearer ? verifySharedToken(bearer) : null;
	if (jwtPayload?.sub) {
		return true;
	}
	if (userId) {
		return true; // shared-secret bearer token authenticated
	}
	if (WEB_API_KEY) {
		return authenticateRequest(req, res, corsHeaders, WEB_API_KEY);
	}
	sendJson(
		res,
		401,
		{
			error:
				"Authentication required. Provide shared-secret bearer token or COMPOSER_WEB_API_KEY.",
		},
		corsHeaders,
		req,
	);
	return false;
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
	const jwtPayload = token ? verifyHs256Jwt(token) : null;
	if (jwtPayload?.sub) {
		return `user:${jwtPayload.sub}`;
	}
	if (token && SHARED_SECRET) {
		const user = verifySharedToken(token);
		if (user) return `user:${user}`;
	}
	if (!token) return "anon";
	const digest = createHash("sha256").update(token).digest("hex");
	return `key:${digest.slice(0, 16)}`;
}
