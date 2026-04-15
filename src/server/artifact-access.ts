import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { getRequestHeader } from "./server-utils.js";

export const ARTIFACT_ACCESS_QUERY_PARAM = "composerArtifactToken";
export const ARTIFACT_ACCESS_HEADER = "x-composer-artifact-access";
export const MAESTRO_ARTIFACT_ACCESS_QUERY_PARAM = "maestroArtifactToken";
export const MAESTRO_ARTIFACT_ACCESS_HEADER = "x-maestro-artifact-access";

const DEFAULT_ARTIFACT_ACCESS_TTL_MS = 5 * 60 * 1000;
const CONFIGURED_ARTIFACT_ACCESS_TTL_MS = Number.parseInt(
	process.env.MAESTRO_ARTIFACT_ACCESS_TTL_MS || "",
	10,
);
const ARTIFACT_ACCESS_TTL_MS =
	Number.isFinite(CONFIGURED_ARTIFACT_ACCESS_TTL_MS) &&
	CONFIGURED_ARTIFACT_ACCESS_TTL_MS > 0
		? CONFIGURED_ARTIFACT_ACCESS_TTL_MS
		: DEFAULT_ARTIFACT_ACCESS_TTL_MS;

const ARTIFACT_ACCESS_SECRET =
	process.env.MAESTRO_ARTIFACT_ACCESS_SECRET?.trim() ||
	process.env.MAESTRO_AUTH_SHARED_SECRET?.trim() ||
	process.env.MAESTRO_JWT_SECRET?.trim() ||
	process.env.MAESTRO_WEB_API_KEY?.trim() ||
	randomBytes(32).toString("hex");

const ARTIFACT_ACCESS_ACTIONS = ["view", "file", "events", "zip"] as const;

export type ArtifactAccessAction = (typeof ARTIFACT_ACCESS_ACTIONS)[number];

export interface ArtifactAccessGrant {
	sessionId: string;
	scope: string | null;
	filename?: string;
	actions: ArtifactAccessAction[];
	expiresAt: number;
}

export interface IssuedArtifactAccessGrant extends ArtifactAccessGrant {
	token: string;
	expiresAtIso: string;
}

const ARTIFACT_ACCESS_ACTION_SET = new Set<ArtifactAccessAction>(
	ARTIFACT_ACCESS_ACTIONS,
);

type ArtifactRouteMatch = {
	action: ArtifactAccessAction;
	sessionId: string;
	filename?: string;
	filenameFilter?: string | null;
};

function safeDecodeURIComponent(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function normalizeActions(
	actions: Iterable<ArtifactAccessAction>,
): ArtifactAccessAction[] {
	return Array.from(new Set(actions)).filter((action) =>
		ARTIFACT_ACCESS_ACTION_SET.has(action),
	);
}

function signArtifactAccessPayload(payload: string): string {
	return createHmac("sha256", ARTIFACT_ACCESS_SECRET)
		.update(payload)
		.digest("base64url");
}

function secureTokenCompare(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	if (leftBytes.length !== rightBytes.length) return false;
	return timingSafeEqual(leftBytes, rightBytes);
}

function parseArtifactRouteMatch(
	req: IncomingMessage,
): ArtifactRouteMatch | null {
	let url: URL;
	try {
		url = new URL(req.url || "/", "http://localhost");
	} catch {
		return null;
	}

	const { pathname, searchParams } = url;

	const zipMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts\.zip$/);
	if (zipMatch) {
		const sessionId = safeDecodeURIComponent(zipMatch[1] || "");
		if (!sessionId) return null;
		return {
			action: "zip",
			sessionId,
		};
	}

	const eventsMatch = pathname.match(
		/^\/api\/sessions\/([^/]+)\/artifacts\/events$/,
	);
	if (eventsMatch) {
		const sessionId = safeDecodeURIComponent(eventsMatch[1] || "");
		if (!sessionId) return null;
		return {
			action: "events",
			sessionId,
			filenameFilter: searchParams.get("filename"),
		};
	}

	const viewMatch = pathname.match(
		/^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)\/view$/,
	);
	if (viewMatch) {
		const sessionId = safeDecodeURIComponent(viewMatch[1] || "");
		const filename = safeDecodeURIComponent(viewMatch[2] || "");
		if (!sessionId || !filename) return null;
		return {
			action: "view",
			sessionId,
			filename,
		};
	}

	const fileMatch = pathname.match(
		/^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)$/,
	);
	if (fileMatch) {
		const sessionId = safeDecodeURIComponent(fileMatch[1] || "");
		const filename = safeDecodeURIComponent(fileMatch[2] || "");
		if (!sessionId || !filename) return null;
		return {
			action: "file",
			sessionId,
			filename,
		};
	}

	return null;
}

export function issueArtifactAccessGrant(input: {
	sessionId: string;
	scope?: string | null;
	filename?: string;
	actions: ArtifactAccessAction[];
	now?: number;
	expiresInMs?: number;
}): IssuedArtifactAccessGrant {
	const now = input.now ?? Date.now();
	const expiresAt = now + (input.expiresInMs ?? ARTIFACT_ACCESS_TTL_MS);
	const grant: ArtifactAccessGrant = {
		sessionId: input.sessionId,
		scope: input.scope ?? null,
		filename: input.filename,
		actions: normalizeActions(input.actions),
		expiresAt,
	};

	const payload = Buffer.from(JSON.stringify(grant), "utf8").toString(
		"base64url",
	);
	const signature = signArtifactAccessPayload(payload);

	return {
		...grant,
		token: `${payload}.${signature}`,
		expiresAtIso: new Date(expiresAt).toISOString(),
	};
}

export function verifyArtifactAccessToken(
	token: string,
	now = Date.now(),
): ArtifactAccessGrant | null {
	const [payload, signature] = token.split(".");
	if (!payload || !signature) return null;

	const expectedSignature = signArtifactAccessPayload(payload);
	if (!secureTokenCompare(signature, expectedSignature)) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;
	const candidate = parsed as Partial<ArtifactAccessGrant>;
	if (
		typeof candidate.sessionId !== "string" ||
		candidate.sessionId.length === 0
	) {
		return null;
	}
	if (candidate.scope !== null && typeof candidate.scope !== "string") {
		return null;
	}
	if (
		candidate.filename !== undefined &&
		(typeof candidate.filename !== "string" || candidate.filename.length === 0)
	) {
		return null;
	}
	if (!Array.isArray(candidate.actions) || candidate.actions.length === 0) {
		return null;
	}
	const actions = normalizeActions(candidate.actions as ArtifactAccessAction[]);
	if (actions.length === 0) return null;
	if (
		typeof candidate.expiresAt !== "number" ||
		!Number.isFinite(candidate.expiresAt)
	) {
		return null;
	}
	if (candidate.expiresAt <= now) return null;

	return {
		sessionId: candidate.sessionId,
		scope: candidate.scope ?? null,
		filename: candidate.filename,
		actions,
		expiresAt: candidate.expiresAt,
	};
}

export function getArtifactAccessGrantFromRequest(
	req: IncomingMessage,
	now = Date.now(),
): ArtifactAccessGrant | null {
	const token = getArtifactAccessTokenFromRequest(req);
	if (!token) return null;

	const grant = verifyArtifactAccessToken(token, now);
	if (!grant) return null;

	const routeMatch = parseArtifactRouteMatch(req);
	if (!routeMatch) return null;
	if (grant.sessionId !== routeMatch.sessionId) return null;
	if (!grant.actions.includes(routeMatch.action)) return null;

	if (routeMatch.filename) {
		if (!grant.filename || grant.filename !== routeMatch.filename) {
			return null;
		}
	}

	if (routeMatch.action === "events" && grant.filename) {
		if (
			!routeMatch.filenameFilter ||
			routeMatch.filenameFilter !== grant.filename
		) {
			return null;
		}
	}

	return grant;
}

export function getArtifactAccessTokenFromRequest(
	req: IncomingMessage,
): string | null {
	return getRequestHeader(
		req,
		ARTIFACT_ACCESS_HEADER,
		MAESTRO_ARTIFACT_ACCESS_HEADER,
	);
}

export function redactArtifactAccessTokenInUrl(
	rawUrl: string | null | undefined,
): string {
	if (!rawUrl) return "/";
	try {
		const url = new URL(rawUrl, "http://localhost");
		if (
			!url.searchParams.has(ARTIFACT_ACCESS_QUERY_PARAM) &&
			!url.searchParams.has(MAESTRO_ARTIFACT_ACCESS_QUERY_PARAM)
		) {
			return rawUrl;
		}
		const params = Array.from(url.searchParams.entries()).map(
			([key, value]) => {
				if (
					key === ARTIFACT_ACCESS_QUERY_PARAM ||
					key === MAESTRO_ARTIFACT_ACCESS_QUERY_PARAM
				) {
					return `${key}=[REDACTED]`;
				}
				return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
			},
		);
		return `${url.pathname}${params.length > 0 ? `?${params.join("&")}` : ""}`;
	} catch {
		return rawUrl.replace(
			new RegExp(
				`((?:${ARTIFACT_ACCESS_QUERY_PARAM}|${MAESTRO_ARTIFACT_ACCESS_QUERY_PARAM})=)[^&\\s]+`,
				"g",
			),
			"$1[REDACTED]",
		);
	}
}
