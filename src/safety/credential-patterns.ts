/**
 * Credential Patterns - Pattern definitions and utilities for credential detection
 *
 * Contains types, constants, and compiled patterns used by the context firewall
 * to detect sensitive content like API keys, passwords, private keys, and tokens.
 *
 * @module safety/credential-patterns
 */

import { createHash, randomBytes } from "node:crypto";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Sensitive content finding from detection
 */
export interface SensitiveContentFinding {
	type:
		| "api_key"
		| "aws_secret"
		| "private_key"
		| "jwt_token"
		| "password"
		| "control_char"
		| "base64_blob"
		| "generic_secret";
	path: string;
	description: string;
	severity: "high" | "medium" | "low";
}

/**
 * Sanitization options
 */
export interface SanitizeOptions {
	/** Maximum string length (default: 4096) */
	maxStringLength?: number;
	/** Maximum recursion depth (default: 20) */
	maxDepth?: number;
	/** Maximum array length (default: 100) */
	maxArrayLength?: number;
	/** Remove control characters (default: true) */
	removeControlChars?: boolean;
	/** Redact detected secrets (default: true) */
	redactSecrets?: boolean;
	/** Truncate large base64 blobs (default: true) */
	truncateLargeBlobs?: boolean;
	/**
	 * Vault credentials instead of redacting them (default: false)
	 *
	 * When enabled, detected credentials are stored securely in the credential
	 * store and replaced with references like `{{CRED:api_key:abc123}}`.
	 * These references can be resolved back to the original value at tool
	 * execution time, allowing safe use of test API keys.
	 *
	 * When vaulting is enabled:
	 * - Credentials are stored in memory (not persisted)
	 * - References replace raw values in the sanitized payload
	 * - Tool execution can resolve references to actual values
	 * - Vaulted credentials don't trigger blocking
	 */
	vaultCredentials?: boolean;
	/** Credential store instance for vaulting (default: in-memory singleton) */
	credentialStore?: import("./credential-store.js").CredentialStore;
}

/**
 * Credential pattern definition (without compiled regex)
 *
 * Each pattern is designed to minimize false positives while catching
 * common credential formats. Patterns are stored as source strings and
 * compiled fresh for each check to avoid global regex lastIndex issues.
 */
export interface CredentialPatternDef {
	name: string;
	type: SensitiveContentFinding["type"];
	source: string;
	flags: string;
	severity: SensitiveContentFinding["severity"];
}

// ============================================================================
// PEM / PGP CONSTANTS
// ============================================================================

const PEM_PRIVATE_KEY_BEGIN = [
	"-----BEGIN ",
	"(?:RSA |EC |DSA |OPENSSH )?PRIVATE",
	" KEY-----",
].join("");
const PEM_PRIVATE_KEY_END = [
	"-----END ",
	"(?:RSA |EC |DSA |OPENSSH )?PRIVATE",
	" KEY-----",
].join("");
const PGP_PRIVATE_KEY_BLOCK = ["PGP", " PRIVATE", " KEY", " BLOCK"].join("");

// ============================================================================
// CREDENTIAL PATTERN DEFINITIONS
// ============================================================================

export const CREDENTIAL_PATTERN_DEFS: CredentialPatternDef[] = [
	// API Keys - various formats
	{
		name: "Generic API Key",
		type: "api_key",
		source:
			"(?:api[_-]?key|apikey|api[_-]?token)[':\"\\s=]+['\"]?([a-zA-Z0-9_\\-]{20,})",
		flags: "gi",
		severity: "high",
	},
	{
		name: "OpenAI API Key",
		type: "api_key",
		source: "sk-[a-zA-Z0-9]{20,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Anthropic API Key",
		type: "api_key",
		source: "sk-ant-[a-zA-Z0-9\\-_]{20,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "GitHub Token",
		type: "api_key",
		source: "gh[pousr]_[a-zA-Z0-9]{36,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Slack Token",
		type: "api_key",
		source: "xox[baprs]-[a-zA-Z0-9\\-]{10,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Stripe Key",
		type: "api_key",
		source: "(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{20,}",
		flags: "g",
		severity: "high",
	},

	// AWS Credentials
	{
		name: "AWS Access Key ID",
		type: "aws_secret",
		source: "AKIA[A-Z0-9]{16}",
		flags: "g",
		severity: "high",
	},
	{
		name: "AWS Secret Access Key",
		type: "aws_secret",
		source:
			"(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?(?:access[_-]?)?key)[':\"\\s=]+['\"]?([a-zA-Z0-9/+=]{40})",
		flags: "gi",
		severity: "high",
	},

	// Private Keys
	{
		name: "RSA Private Key",
		type: "private_key",
		source: `${PEM_PRIVATE_KEY_BEGIN}[\\s\\S]+?${PEM_PRIVATE_KEY_END}`,
		flags: "g",
		severity: "high",
	},
	{
		name: "PGP Private Key",
		type: "private_key",
		source: `-----BEGIN ${PGP_PRIVATE_KEY_BLOCK}-----[\\s\\S]+?-----END ${PGP_PRIVATE_KEY_BLOCK}-----`,
		flags: "g",
		severity: "high",
	},

	// JWT Tokens
	{
		name: "JWT Token",
		type: "jwt_token",
		// IETF JWTs use URL-safe base64 in the header and payload, but
		// real-world signers occasionally emit standard base64 (`+`, `/`,
		// padding) in the signature segment. Accept both so the mask covers
		// the full token instead of truncating at the first non-URL-safe
		// byte and leaking the rest.
		source: "eyJ[a-zA-Z0-9_-]*\\.eyJ[a-zA-Z0-9_-]*\\.[a-zA-Z0-9_\\-+/=]*",
		flags: "g",
		severity: "medium",
	},

	// Password patterns
	{
		name: "Password in URL",
		type: "password",
		source: ":\\/\\/([^:]+:[^@]+)@",
		flags: "g",
		severity: "high",
	},
	{
		name: "Password Assignment",
		type: "password",
		source: "(?:password|passwd|pwd|secret)[':\"\\s=]+['\"]?([^'\"\\s]{8,})",
		flags: "gi",
		severity: "medium",
	},

	// Generic secrets
	{
		name: "Bearer Token",
		type: "generic_secret",
		// Match the Authorization Header char class — base64-padded JWT
		// signatures contain `+`, `/`, `=`, so a narrower class truncates the
		// mask and leaks the signature tail.
		source: "Bearer\\s+([a-zA-Z0-9_\\-\\./+=]+)",
		flags: "gi",
		severity: "medium",
	},
	{
		name: "Basic Auth Token",
		type: "generic_secret",
		// Require ≥16 base64 chars so benign English like "Basic
		// authentication" / "Basic Auth overview" doesn't trip the mask.
		// Real Basic credentials are `base64(user:password)` and almost
		// always longer than this threshold; the hosted recorder enforces
		// the same minimum in its literal pattern list.
		source: "Basic\\s+([A-Za-z0-9+/=]{16,})",
		flags: "gi",
		severity: "medium",
	},
	{
		name: "Authorization Header",
		type: "generic_secret",
		source:
			"Authorization[':\"\\s]+['\"]?(?:Basic\\s+([A-Za-z0-9+/=]{16,})|(?:Bearer|Token)\\s+([a-zA-Z0-9_\\-\\./+=]+))",
		flags: "gi",
		severity: "medium",
	},

	// GCP/Google Cloud Credentials
	{
		name: "GCP Access Token",
		type: "api_key",
		source: "ya29\\.[a-zA-Z0-9\\-_]{20,}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Google API Key",
		type: "api_key",
		source: "AIza[a-zA-Z0-9\\-_]{35}",
		flags: "g",
		severity: "high",
	},
	{
		name: "Google OAuth Refresh Token",
		type: "api_key",
		source: "1//[a-zA-Z0-9\\-_]{40,}",
		flags: "g",
		severity: "high",
	},

	// Azure Credentials
	{
		name: "Azure SAS Token",
		type: "api_key",
		source: "[?&](?:sv|sig|se|sp)=[a-zA-Z0-9%\\-_]{10,}",
		flags: "gi",
		severity: "high",
	},
	{
		name: "Azure Connection String",
		type: "api_key",
		source: "(?:AccountKey|SharedAccessKey)=[a-zA-Z0-9+/=]{40,}",
		flags: "gi",
		severity: "high",
	},
	{
		name: "Azure AD Client Secret",
		type: "api_key",
		// Azure AD client secrets contain ~ and often start with specific patterns
		source:
			"(?:client[_-]?secret|azure[_-]?secret)[':\"\\s=]+['\"]?([a-zA-Z0-9~_\\-\\.]{32,})",
		flags: "gi",
		severity: "high",
	},

	// Base64-Encoded Secrets (detecting common patterns when decoded)
	{
		name: "Base64-Encoded API Key",
		type: "api_key",
		source:
			"(?:api[_-]?key|token|secret|password)[':\"\\s=]+['\"]?([A-Za-z0-9+/=]{24,})",
		flags: "gi",
		severity: "high",
	},

	// Hex-Encoded Secrets (32+ hex chars often indicate secrets)
	{
		name: "Hex-Encoded Secret",
		type: "generic_secret",
		source: "(?:secret|key|token)[':\"\\s=]+['\"]?([a-fA-F0-9]{32,})",
		flags: "gi",
		severity: "medium",
	},

	// Database Connection Strings
	{
		name: "MongoDB Connection String",
		type: "generic_secret",
		source: "mongodb(?:\\+srv)?:\\/\\/[^\\s]+",
		flags: "gi",
		severity: "high",
	},
	{
		name: "PostgreSQL Connection String",
		type: "generic_secret",
		source: "postgres(?:ql)?:\\/\\/[^\\s]+",
		flags: "gi",
		severity: "high",
	},
	{
		name: "MySQL Connection String",
		type: "generic_secret",
		source: "mysql:\\/\\/[^\\s]+",
		flags: "gi",
		severity: "high",
	},

	// NPM/Registry Tokens
	{
		name: "NPM Token",
		type: "api_key",
		source: "npm_[a-zA-Z0-9]{36}",
		flags: "g",
		severity: "high",
	},
	{
		name: "PyPI Token",
		type: "api_key",
		source: "pypi-[a-zA-Z0-9]{60,}",
		flags: "g",
		severity: "high",
	},
];

export const STATIC_SECRET_REDACTION_PATTERN_DEFS: CredentialPatternDef[] = [
	...CREDENTIAL_PATTERN_DEFS,
	{
		name: "Static Secret Token",
		type: "api_key",
		source: "sk-[A-Za-z0-9-_]{16,}",
		flags: "gi",
		severity: "low",
	},
	{
		name: "Static Keyword Secret",
		type: "generic_secret",
		source:
			"\\b(?:token|secret|password|key)[^\\S\\r\\n]*[:=][^\\S\\r\\n]*([^\\s\"']{8,})",
		flags: "gi",
		severity: "low",
	},
	{
		name: "Static AWS Access Key ID",
		type: "aws_secret",
		source: "\\b(?:A3T[A-Z]|AKIA|ASIA|AGPA|AIDA|ANPA|ANVA|AROA)[A-Z0-9]{16}\\b",
		flags: "g",
		severity: "low",
	},
	{
		name: "Long Hex Secret",
		type: "generic_secret",
		source: "\\b[a-fA-F0-9]{64,}\\b",
		flags: "g",
		severity: "low",
	},
	{
		name: "Static JWT Token",
		type: "jwt_token",
		source:
			"\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b",
		flags: "g",
		severity: "low",
	},
];

// ============================================================================
// PATTERN UTILITIES
// ============================================================================

export type CredentialPatternMasker = (
	secret: string,
	def: CredentialPatternDef,
) => string;

/**
 * Create a fresh regex from pattern definition
 * This avoids global regex lastIndex state issues
 */
export function createPatternRegex(def: CredentialPatternDef): RegExp {
	return new RegExp(def.source, def.flags);
}

function createGlobalPatternRegex(def: CredentialPatternDef): RegExp {
	const flags = def.flags.includes("g") ? def.flags : `${def.flags}g`;
	return new RegExp(def.source, flags);
}

function captureArgs(args: unknown[]): string[] {
	const lastArg = args[args.length - 1];
	const hasNamedGroups =
		lastArg !== null && typeof lastArg === "object" && !Array.isArray(lastArg);
	const captureEnd = args.length - (hasNamedGroups ? 3 : 2);
	return args
		.slice(1, captureEnd)
		.filter(
			(capture): capture is string =>
				typeof capture === "string" && capture.length > 0,
		);
}

function replaceLiteral(
	value: string,
	search: string,
	replacement: string,
): string {
	return search.length === 0 ? value : value.split(search).join(replacement);
}

export function replaceCredentialPatternMatches(
	value: string,
	maskSecret: CredentialPatternMasker,
	patternDefs: readonly CredentialPatternDef[] = STATIC_SECRET_REDACTION_PATTERN_DEFS,
): string {
	let result = value;
	const stagedReplacements = new Map<string, string>();
	let stagedReplacementIndex = 0;
	// Per-call random nonce so attacker input containing a literal sentinel
	// cannot collide with our staged replacements. Without this, an input
	// like `<<MSTR RPL 0>>` would be substituted with the first staged
	// credential reference during the finalization split/join, which in
	// vault mode (`{{CRED:...}}`) lets attacker-controlled text inject a
	// stored credential at the resolver. 12 bytes hex = 96 bits, far more
	// than enough to make collision negligible.
	const nonce = randomBytes(12).toString("hex");
	const stageReplacement = (replacement: string): string => {
		const sentinel = `<<MSTR-RPL-${nonce}-${stagedReplacementIndex++}>>`;
		stagedReplacements.set(sentinel, replacement);
		return sentinel;
	};

	for (const def of patternDefs) {
		const pattern = createGlobalPatternRegex(def);
		result = result.replace(pattern, (...args: unknown[]) => {
			const match = args[0] as string;
			const captures = captureArgs(args);
			if (captures.length === 0) {
				return stageReplacement(maskSecret(match, def));
			}
			let redacted = match;
			for (const capture of captures) {
				redacted = replaceLiteral(
					redacted,
					capture,
					stageReplacement(maskSecret(capture, def)),
				);
			}
			return redacted;
		});
	}
	for (const [sentinel, replacement] of stagedReplacements) {
		result = replaceLiteral(result, sentinel, replacement);
	}
	return result;
}

/**
 * Control characters that should be removed (0x00-0x1f except common whitespace, and 0x7f)
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character range
export const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Pattern to detect large base64-like blobs
 */
export const BASE64_BLOB_PATTERN = /^[A-Za-z0-9+/=]{1000,}$/;

/**
 * Check if a string looks like a large base64 blob
 */
export function isLargeBase64Blob(value: string): boolean {
	return value.length > 1000 && BASE64_BLOB_PATTERN.test(value);
}

/**
 * Generate a truncation hash for a string
 */
export function truncationHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Remove control characters from a string
 */
export function removeControlChars(value: string): string {
	return value.replace(CONTROL_CHAR_PATTERN, "");
}
