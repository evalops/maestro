/**
 * Shared payload sanitization core.
 *
 * Keep this module focused on synchronous redaction/truncation so session
 * persistence can sanitize messages without importing the broader context
 * firewall checking and credential-store surfaces before fresh exec startup.
 */

import { createLogger } from "../utils/logger.js";
import {
	redactSensitiveValue,
	truncateWithHash,
	vaultSensitiveValue,
} from "./content-detection.js";
import {
	CREDENTIAL_PATTERN_DEFS,
	type SanitizeOptions,
	isLargeBase64Blob,
	removeControlChars,
	replaceCredentialPatternMatches,
} from "./credential-patterns.js";
import type { CredentialStore } from "./credential-store.js";

const logger = createLogger("safety:context-firewall");

/** Maximum string length before truncation */
const MAX_STRING_LENGTH = 4096;

/** Maximum depth for recursive sanitization */
export const MAX_RECURSION_DEPTH = 20;

/** Maximum array length before truncation */
const MAX_ARRAY_LENGTH = 100;

type ResolvedSanitizeOptions = Omit<
	Required<SanitizeOptions>,
	"credentialStore"
> & {
	credentialStore?: CredentialStore;
};

/**
 * Credential Fragment Tracker - Detects split credentials across multiple calls.
 */
export class CredentialFragmentTracker {
	/** Time window for fragment tracking (5 minutes) */
	private readonly windowMs = 5 * 60 * 1000;
	/** Maximum fragments to track */
	private readonly maxFragments = 100;
	/** Fragments with timestamps */
	private fragments: Array<{ value: string; timestamp: number }> = [];
	/** Known credential prefixes to track */
	private readonly credentialPrefixes = [
		"sk-", // OpenAI, Anthropic
		"ghp_", // GitHub Personal Access Token
		"gho_", // GitHub OAuth
		"github_pat_", // GitHub PAT
		"xoxb-", // Slack Bot Token
		"xoxp-", // Slack User Token
		"AKIA", // AWS Access Key ID
		"ya29.", // GCP Access Token
		"eyJ", // JWT/Base64 JSON
		"AIza", // Google API Key
		"npm_", // NPM Token
		"pypi-", // PyPI Token
	];
	/** Minimum fragment length to consider */
	private readonly minFragmentLength = 3;

	recordFragment(value: string): void {
		if (typeof value !== "string" || value.length < this.minFragmentLength) {
			return;
		}

		const isPrefix = this.credentialPrefixes.some((p) =>
			value.toLowerCase().startsWith(p.toLowerCase()),
		);
		const looksLikeCredentialPart =
			isPrefix ||
			/^[a-zA-Z0-9_\-+/=]{8,}$/.test(value) ||
			/^[a-fA-F0-9]{16,}$/.test(value);

		if (!looksLikeCredentialPart) {
			return;
		}

		this.fragments.push({ value, timestamp: Date.now() });
		this.pruneOldFragments();
		this.checkAssembledCredentials();
	}

	private pruneOldFragments(): void {
		const cutoff = Date.now() - this.windowMs;
		this.fragments = this.fragments
			.filter((f) => f.timestamp > cutoff)
			.slice(-this.maxFragments);
	}

	private checkAssembledCredentials(): void {
		const recentFragments = this.fragments.slice(-10);

		for (let i = 0; i < recentFragments.length; i++) {
			for (let len = 2; len <= Math.min(4, recentFragments.length - i); len++) {
				const assembled = recentFragments
					.slice(i, i + len)
					.map((f) => f.value)
					.join("");

				if (this.looksLikeAssembledCredential(assembled)) {
					logger.warn("Potential split credential detected", {
						fragmentCount: len,
						assembledLength: assembled.length,
					});
					this.trackSplitCredentialDetection(len, assembled.length);
				}
			}
		}
	}

	private looksLikeAssembledCredential(value: string): boolean {
		const credentialPatterns = [
			/^sk-[a-zA-Z0-9]{40,}$/,
			/^ghp_[a-zA-Z0-9]{36}$/,
			/^AKIA[A-Z0-9]{16}$/,
			/^[a-zA-Z0-9]{32,}$/,
			/^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/,
		];

		return credentialPatterns.some((p) => p.test(value));
	}

	private trackSplitCredentialDetection(
		fragmentCount: number,
		totalLength: number,
	): void {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const {
				trackContextFirewall,
			} = require("../telemetry/security-events.js");
			trackContextFirewall({
				findingTypes: ["split_credential"],
				findingCount: 1,
				blocked: true,
				metadata: { fragmentCount, totalLength },
			});
		} catch {
			logger.warn("Split credential tracking failed");
		}
	}

	clear(): void {
		this.fragments = [];
	}

	getFragmentCount(): number {
		return this.fragments.length;
	}
}

/** Global credential fragment tracker instance */
export const credentialFragmentTracker = new CredentialFragmentTracker();

function sanitizeString(
	value: string,
	options: ResolvedSanitizeOptions,
): string {
	let result = value;

	credentialFragmentTracker.recordFragment(value);

	if (options.removeControlChars) {
		result = removeControlChars(result);
	}

	if (options.vaultCredentials) {
		if (!options.credentialStore) {
			throw new Error(
				"credentialStore is required when vaultCredentials is true",
			);
		}
		result = replaceCredentialPatternMatches(
			result,
			(secret, def) =>
				vaultSensitiveValue(secret, def.type, options.credentialStore!),
			CREDENTIAL_PATTERN_DEFS,
		);
	} else if (options.redactSecrets) {
		result = replaceCredentialPatternMatches(
			result,
			(secret, def) => redactSensitiveValue(secret, def.type),
			CREDENTIAL_PATTERN_DEFS,
		);
	}

	if (options.truncateLargeBlobs && isLargeBase64Blob(result)) {
		result = truncateWithHash(result, 200, "base64");
	}

	if (result.length > options.maxStringLength) {
		result = truncateWithHash(result, options.maxStringLength, "truncated");
	}

	return result;
}

function sanitizeValue(
	value: unknown,
	options: ResolvedSanitizeOptions,
	depth: number,
): unknown {
	if (depth > options.maxDepth) {
		return "[MAX_DEPTH_EXCEEDED]";
	}

	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === "string") {
		return sanitizeString(value, options);
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}

	if (Array.isArray(value)) {
		const sanitized = value
			.slice(0, options.maxArrayLength)
			.map((item) => sanitizeValue(item, options, depth + 1));
		if (value.length > options.maxArrayLength) {
			sanitized.push(
				`[...${value.length - options.maxArrayLength} more items]`,
			);
		}
		return sanitized;
	}

	if (typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			sanitized[key] = sanitizeValue(val, options, depth + 1);
		}
		return sanitized;
	}

	if (typeof value === "bigint") {
		return `[bigint:${value.toString()}]`;
	}

	if (typeof value === "symbol") {
		return `[symbol:${value.description ?? "unnamed"}]`;
	}

	return `[${typeof value}]`;
}

export function sanitizePayload(
	payload: unknown,
	options: SanitizeOptions = {},
): unknown {
	const fullOptions: ResolvedSanitizeOptions = {
		maxStringLength: options.maxStringLength ?? MAX_STRING_LENGTH,
		maxDepth: options.maxDepth ?? MAX_RECURSION_DEPTH,
		maxArrayLength: options.maxArrayLength ?? MAX_ARRAY_LENGTH,
		removeControlChars: options.removeControlChars ?? true,
		redactSecrets: options.redactSecrets ?? true,
		truncateLargeBlobs: options.truncateLargeBlobs ?? true,
		vaultCredentials: options.vaultCredentials ?? false,
		credentialStore: options.credentialStore,
	};

	return sanitizeValue(payload, fullOptions, 0);
}
