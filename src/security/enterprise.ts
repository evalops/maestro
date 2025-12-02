/**
 * Enterprise Security Features
 *
 * - Webhook HMAC signing for tamper-proof alerts
 * - IP allowlist/blocklist for network access control
 * - Token revocation for session management
 * - TOTP 2FA support
 * - Audit log integrity verification
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("security:enterprise");

// ============================================================================
// WEBHOOK HMAC SIGNING
// ============================================================================

export interface WebhookSignatureOptions {
	/** Secret key for HMAC signing */
	secret: string;
	/** Algorithm to use (default: sha256) */
	algorithm?: "sha256" | "sha384" | "sha512";
	/** Header name for the signature (default: X-Composer-Signature) */
	headerName?: string;
	/** Timestamp tolerance in seconds for replay protection (default: 300) */
	timestampTolerance?: number;
}

export interface SignedWebhookPayload {
	/** The original payload */
	payload: string;
	/** Unix timestamp when signed */
	timestamp: number;
	/** HMAC signature */
	signature: string;
}

/**
 * Sign a webhook payload with HMAC for integrity verification
 */
export function signWebhookPayload(
	payload: string | object,
	options: WebhookSignatureOptions,
): SignedWebhookPayload {
	const algorithm = options.algorithm || "sha256";
	const payloadStr =
		typeof payload === "string" ? payload : JSON.stringify(payload);
	const timestamp = Math.floor(Date.now() / 1000);

	// Create signature over timestamp.payload to prevent replay attacks
	const signatureBase = `${timestamp}.${payloadStr}`;
	const signature = crypto
		.createHmac(algorithm, options.secret)
		.update(signatureBase)
		.digest("hex");

	return {
		payload: payloadStr,
		timestamp,
		signature: `v1=${signature}`,
	};
}

/**
 * Verify a webhook signature
 */
export function verifyWebhookSignature(
	payload: string,
	signature: string,
	timestamp: number,
	options: WebhookSignatureOptions,
): { valid: boolean; error?: string } {
	const algorithm = options.algorithm || "sha256";
	const tolerance = options.timestampTolerance ?? 300;

	// Check timestamp freshness
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - timestamp) > tolerance) {
		return { valid: false, error: "Timestamp outside tolerance window" };
	}

	// Parse signature format (v1=hex)
	const match = signature.match(/^v1=([a-f0-9]+)$/i);
	if (!match) {
		return { valid: false, error: "Invalid signature format" };
	}

	// Compute expected signature
	const signatureBase = `${timestamp}.${payload}`;
	const expected = crypto
		.createHmac(algorithm, options.secret)
		.update(signatureBase)
		.digest("hex");

	// Timing-safe comparison
	const providedBuffer = Buffer.from(match[1], "hex");
	const expectedBuffer = Buffer.from(expected, "hex");

	if (providedBuffer.length !== expectedBuffer.length) {
		return { valid: false, error: "Signature length mismatch" };
	}

	if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
		return { valid: false, error: "Signature mismatch" };
	}

	return { valid: true };
}

/**
 * Create HTTP headers for signed webhook delivery
 */
export function createWebhookHeaders(
	signed: SignedWebhookPayload,
	headerName = "X-Composer-Signature",
): Record<string, string> {
	return {
		"Content-Type": "application/json",
		[headerName]: signed.signature,
		"X-Composer-Timestamp": signed.timestamp.toString(),
		"X-Composer-Request-Id": crypto.randomUUID(),
	};
}

// ============================================================================
// IP ALLOWLIST/BLOCKLIST
// ============================================================================

export interface IpAccessRule {
	/** CIDR notation (e.g., "192.168.1.0/24") or single IP */
	pattern: string;
	/** Whether this is an allow or deny rule */
	type: "allow" | "deny";
	/** Optional description */
	description?: string;
}

export interface IpAccessConfig {
	/** Default action when no rules match */
	defaultAction: "allow" | "deny";
	/** Rules evaluated in order, first match wins */
	rules: IpAccessRule[];
}

/**
 * Parse CIDR notation to IP range
 */
function parseCidr(cidr: string): { start: bigint; end: bigint } | null {
	const parts = cidr.split("/");
	const ip = parts[0];
	const prefix = parts.length > 1 ? Number.parseInt(parts[1], 10) : 32;

	if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
		return null;
	}

	const ipParts = ip.split(".").map(Number);
	if (
		ipParts.length !== 4 ||
		ipParts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
	) {
		return null;
	}

	const ipNum = BigInt(
		((ipParts[0] << 24) |
			(ipParts[1] << 16) |
			(ipParts[2] << 8) |
			ipParts[3]) >>>
			0,
	);
	const mask = BigInt(0xffffffff) << BigInt(32 - prefix);
	const start = ipNum & mask;
	const end = start | (~mask & BigInt(0xffffffff));

	return { start, end };
}

/**
 * Convert IP string to numeric
 */
function ipToNumber(ip: string): bigint | null {
	// Handle IPv4-mapped IPv6
	let cleanIp = ip;
	if (ip.startsWith("::ffff:")) {
		cleanIp = ip.substring(7);
	}

	const parts = cleanIp.split(".").map(Number);
	if (
		parts.length !== 4 ||
		parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
	) {
		return null;
	}

	return BigInt(
		((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0,
	);
}

/**
 * Check if IP matches a pattern (CIDR or exact)
 */
function ipMatchesPattern(ip: string, pattern: string): boolean {
	const ipNum = ipToNumber(ip);
	if (ipNum === null) return false;

	const range = parseCidr(pattern);
	if (!range) {
		// Try exact match
		const patternNum = ipToNumber(pattern);
		return patternNum !== null && ipNum === patternNum;
	}

	return ipNum >= range.start && ipNum <= range.end;
}

/**
 * Check if an IP is allowed based on access rules
 */
export function checkIpAccess(
	ip: string,
	config: IpAccessConfig,
): { allowed: boolean; matchedRule?: IpAccessRule } {
	for (const rule of config.rules) {
		if (ipMatchesPattern(ip, rule.pattern)) {
			return {
				allowed: rule.type === "allow",
				matchedRule: rule,
			};
		}
	}

	return { allowed: config.defaultAction === "allow" };
}

/**
 * Create middleware for IP access control
 */
export function createIpAccessMiddleware(
	getConfig: () => IpAccessConfig | null,
	corsHeaders: Record<string, string>,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
	return (req, res, next) => {
		const config = getConfig();
		if (!config) {
			// No config means allow all
			return next();
		}

		let ip = req.socket.remoteAddress || "unknown";
		// Normalize IPv4-mapped IPv6
		if (ip.startsWith("::ffff:")) {
			ip = ip.substring(7);
		}

		const result = checkIpAccess(ip, config);

		if (!result.allowed) {
			logger.warn("IP access denied", {
				ip,
				matchedRule: result.matchedRule?.pattern,
			});

			res.writeHead(403, {
				"Content-Type": "application/json",
				...corsHeaders,
			});
			res.end(JSON.stringify({ error: "Access denied: IP not allowed" }));
			return;
		}

		return next();
	};
}

// ============================================================================
// TOKEN REVOCATION
// ============================================================================

/**
 * In-memory token revocation list with TTL
 * For production, use Redis or database-backed storage
 */
class TokenRevocationList {
	private revoked = new Map<string, number>(); // token hash -> expiry timestamp
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor() {
		// Clean up expired entries every minute
		this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
	}

	/**
	 * Revoke a token by storing its hash until expiry
	 */
	revoke(tokenHash: string, expiresAt: Date): void {
		this.revoked.set(tokenHash, expiresAt.getTime());
		logger.info("Token revoked", {
			tokenHash: `${tokenHash.substring(0, 8)}...`,
		});
	}

	/**
	 * Check if a token is revoked
	 */
	isRevoked(tokenHash: string): boolean {
		const expiry = this.revoked.get(tokenHash);
		if (!expiry) return false;

		// If past expiry, the token would be invalid anyway
		if (Date.now() > expiry) {
			this.revoked.delete(tokenHash);
			return false;
		}

		return true;
	}

	/**
	 * Hash a token for storage (don't store raw tokens)
	 */
	static hashToken(token: string): string {
		return crypto.createHash("sha256").update(token).digest("hex");
	}

	/**
	 * Clean up expired entries
	 */
	private cleanup(): void {
		const now = Date.now();
		let cleaned = 0;
		for (const [hash, expiry] of this.revoked.entries()) {
			if (now > expiry) {
				this.revoked.delete(hash);
				cleaned++;
			}
		}
		if (cleaned > 0) {
			logger.debug("Cleaned up expired revocations", { count: cleaned });
		}
	}

	/**
	 * Destroy the cleanup interval
	 */
	destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
	}

	/**
	 * Get count of revoked tokens (for metrics)
	 */
	get size(): number {
		return this.revoked.size;
	}
}

// Singleton instance
let revocationList: TokenRevocationList | null = null;

export function getRevocationList(): TokenRevocationList {
	if (!revocationList) {
		revocationList = new TokenRevocationList();
	}
	return revocationList;
}

/**
 * Revoke a JWT token
 */
export function revokeToken(token: string, expiresAt: Date): void {
	const hash = TokenRevocationList.hashToken(token);
	getRevocationList().revoke(hash, expiresAt);
}

/**
 * Check if a JWT token is revoked
 */
export function isTokenRevoked(token: string): boolean {
	const hash = TokenRevocationList.hashToken(token);
	return getRevocationList().isRevoked(hash);
}

// ============================================================================
// TOTP 2FA
// ============================================================================

const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30; // seconds
const TOTP_ALGORITHM = "sha1"; // Standard for Google Authenticator compatibility

/**
 * Generate a TOTP secret for user enrollment
 */
export function generateTotpSecret(): string {
	// 20 bytes = 160 bits, standard for TOTP
	return base32Encode(crypto.randomBytes(20));
}

/**
 * Base32 encoding for TOTP secrets
 */
function base32Encode(buffer: Buffer): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0;
	let value = 0;
	let output = "";

	for (const byte of buffer) {
		value = (value << 8) | byte;
		bits += 8;

		while (bits >= 5) {
			output += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}

	if (bits > 0) {
		output += alphabet[(value << (5 - bits)) & 31];
	}

	return output;
}

/**
 * Base32 decoding for TOTP secrets
 */
function base32Decode(encoded: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const cleanedInput = encoded.toUpperCase().replace(/=+$/, "");

	let bits = 0;
	let value = 0;
	const output: number[] = [];

	for (const char of cleanedInput) {
		const idx = alphabet.indexOf(char);
		if (idx === -1) continue; // Skip invalid chars

		value = (value << 5) | idx;
		bits += 5;

		if (bits >= 8) {
			output.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}

	return Buffer.from(output);
}

/**
 * Generate TOTP code for a given secret and time
 */
export function generateTotp(secret: string, time?: number): string {
	const counter = Math.floor((time ?? Date.now() / 1000) / TOTP_PERIOD);
	const counterBuffer = Buffer.alloc(8);
	counterBuffer.writeBigUInt64BE(BigInt(counter));

	const secretBuffer = base32Decode(secret);
	const hmac = crypto
		.createHmac(TOTP_ALGORITHM, secretBuffer)
		.update(counterBuffer)
		.digest();

	// Dynamic truncation
	const offset = hmac[hmac.length - 1] & 0xf;
	const code =
		((hmac[offset] & 0x7f) << 24) |
		((hmac[offset + 1] & 0xff) << 16) |
		((hmac[offset + 2] & 0xff) << 8) |
		(hmac[offset + 3] & 0xff);

	return (code % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a TOTP code with time skew tolerance
 */
export function verifyTotp(
	secret: string,
	code: string,
	windowSize = 1,
): { valid: boolean; drift?: number } {
	const now = Date.now() / 1000;

	for (let i = -windowSize; i <= windowSize; i++) {
		const time = now + i * TOTP_PERIOD;
		const expected = generateTotp(secret, time);

		// Timing-safe comparison
		if (
			code.length === expected.length &&
			crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))
		) {
			return { valid: true, drift: i };
		}
	}

	return { valid: false };
}

/**
 * Generate backup codes for 2FA recovery
 */
export function generateBackupCodes(count = 10): string[] {
	const codes: string[] = [];
	for (let i = 0; i < count; i++) {
		// 8-character alphanumeric codes, grouped as XXXX-XXXX
		const code = crypto.randomBytes(4).toString("hex").toUpperCase();
		codes.push(`${code.slice(0, 4)}-${code.slice(4, 8)}`);
	}
	return codes;
}

/**
 * Hash backup codes for storage (store hashed, not plain)
 */
export function hashBackupCode(code: string): string {
	return crypto
		.createHash("sha256")
		.update(code.replace("-", "").toUpperCase())
		.digest("hex");
}

/**
 * Generate otpauth:// URI for QR code enrollment
 */
export function generateTotpUri(
	secret: string,
	email: string,
	issuer = "Composer",
): string {
	const encodedEmail = encodeURIComponent(email);
	const encodedIssuer = encodeURIComponent(issuer);
	return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

// ============================================================================
// AUDIT LOG INTEGRITY
// ============================================================================

/**
 * Generate hash chain entry for audit log integrity
 */
export function hashAuditEntry(
	entry: {
		id: string;
		timestamp: Date;
		action: string;
		userId: string;
		metadata?: unknown;
	},
	previousHash: string,
): string {
	const data = JSON.stringify({
		id: entry.id,
		timestamp: entry.timestamp.toISOString(),
		action: entry.action,
		userId: entry.userId,
		metadata: entry.metadata,
		previousHash,
	});

	return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Verify audit log chain integrity
 */
export function verifyAuditChain(
	entries: Array<{
		id: string;
		timestamp: Date;
		action: string;
		userId: string;
		metadata?: unknown;
		integrityHash?: string;
	}>,
	genesisHash = "0".repeat(64),
): { valid: boolean; brokenAt?: number } {
	let previousHash = genesisHash;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const expectedHash = hashAuditEntry(entry, previousHash);

		if (entry.integrityHash && entry.integrityHash !== expectedHash) {
			return { valid: false, brokenAt: i };
		}

		previousHash = expectedHash;
	}

	return { valid: true };
}
