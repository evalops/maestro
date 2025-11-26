/**
 * JWT Authentication System
 * Handles token generation, validation, and refresh
 */

import jwt from "jsonwebtoken";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("auth");

const DEFAULT_SECRET = "composer-default-secret-change-in-production";
const JWT_SECRET = process.env.COMPOSER_JWT_SECRET || DEFAULT_SECRET;
const JWT_EXPIRY = process.env.COMPOSER_JWT_EXPIRY || "24h";
const REFRESH_TOKEN_EXPIRY = "7d";

if (JWT_SECRET === DEFAULT_SECRET) {
	if (process.env.NODE_ENV === "production") {
		throw new Error(
			"COMPOSER_JWT_SECRET must be set in production environment",
		);
	}
	logger.warn(
		"Using default JWT secret! Set COMPOSER_JWT_SECRET in production",
	);
}

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
 * Verify and decode JWT token
 */
export function verifyToken(token: string): JwtPayload | null {
	try {
		const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
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

	const value = Number.parseInt(match[1], 10);
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
