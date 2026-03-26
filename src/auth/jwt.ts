/**
 * JWT Authentication System
 * Handles token generation, validation, and refresh
 */

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { createLogger } from "../utils/logger.js";
import {
	isTokenIssuedBeforeRevocation,
	isTokenRevokedSync,
} from "./token-revocation.js";

const logger = createLogger("auth");

const envSecret = process.env.MAESTRO_JWT_SECRET || process.env.JWT_SECRET;
let JWT_SECRET: string;

if (envSecret && envSecret.trim().length >= 32) {
	JWT_SECRET = envSecret;
} else if (process.env.NODE_ENV === "test") {
	JWT_SECRET = crypto.randomBytes(32).toString("hex");
	logger.warn(
		"Generated ephemeral JWT secret for tests; set MAESTRO_JWT_SECRET for predictable behavior",
	);
} else {
	throw new Error(
		"MAESTRO_JWT_SECRET must be set and at least 32 characters long",
	);
}

const JWT_EXPIRY = process.env.MAESTRO_JWT_EXPIRY || "24h";
const REFRESH_TOKEN_EXPIRY = "7d";

export interface JwtPayload {
	userId: string;
	email: string;
	orgId: string;
	roleId: string;
	type: "access" | "refresh";
}

export interface TokenPair {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

/**
 * Generate JWT tokens (access + refresh)
 */
export function generateTokenPair(
	payload: Omit<JwtPayload, "type">,
): TokenPair {
	const expiresInSeconds = parseExpiry(JWT_EXPIRY);
	const refreshExpiresInSeconds = parseExpiry(REFRESH_TOKEN_EXPIRY);

	const accessToken = jwt.sign(
		{ ...payload, type: "access" } as JwtPayload,
		JWT_SECRET,
		{ expiresIn: expiresInSeconds },
	);

	const refreshToken = jwt.sign(
		{ ...payload, type: "refresh" } as JwtPayload,
		JWT_SECRET,
		{ expiresIn: refreshExpiresInSeconds },
	);

	return {
		accessToken,
		refreshToken,
		expiresIn: expiresInSeconds,
	};
}

/**
 * Verify and decode JWT token.
 * Checks both JWT validity and revocation status.
 */
export function verifyToken(token: string): JwtPayload | null {
	try {
		// First check individual token revocation (fast, cache-based check)
		if (isTokenRevokedSync(token)) {
			logger.debug("Token is revoked");
			return null;
		}

		const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload & {
			iat?: number;
		};

		// Check if user has a "revoke all before" timestamp
		if (
			decoded.iat &&
			isTokenIssuedBeforeRevocation(decoded.userId, decoded.iat)
		) {
			logger.debug("Token was issued before user revocation timestamp");
			return null;
		}

		return decoded;
	} catch (error) {
		logger.debug("Token verification failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Verify token with async revocation check (checks database).
 * Use this when you need to ensure revocation is checked against DB.
 * Fails closed by default - returns null if DB check fails.
 */
export async function verifyTokenAsync(
	token: string,
	options: { failClosed?: boolean } = {},
): Promise<JwtPayload | null> {
	try {
		// Import dynamically to avoid circular dependency at module load
		const { isTokenRevoked } = await import("./token-revocation.js");

		if (
			await isTokenRevoked(token, { failClosed: options.failClosed ?? true })
		) {
			logger.debug("Token is revoked (async check)");
			return null;
		}

		const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload & {
			iat?: number;
		};

		// Check if user has a "revoke all before" timestamp
		if (
			decoded.iat &&
			isTokenIssuedBeforeRevocation(decoded.userId, decoded.iat)
		) {
			logger.debug("Token was issued before user revocation timestamp");
			return null;
		}

		return decoded;
	} catch (error) {
		logger.debug("Token verification failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Extract token from Authorization header
 */
export function extractBearerToken(
	authHeader: string | undefined,
): string | null {
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return null;
	}
	return authHeader.substring(7);
}

/**
 * Parse expiry string to seconds
 */
function parseExpiry(expiry: string): number {
	const match = expiry.match(/^(\d+)([smhd])$/);
	if (!match) return 86400; // Default 24 hours

	const value = Number.parseInt(match[1]!, 10);
	const unit = match[2];

	switch (unit) {
		case "s":
			return value;
		case "m":
			return value * 60;
		case "h":
			return value * 3600;
		case "d":
			return value * 86400;
		default:
			return 86400;
	}
}
