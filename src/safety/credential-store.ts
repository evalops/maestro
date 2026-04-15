/**
 * Credential Store - Secure In-Memory Credential Vault
 *
 * This module provides secure storage for credentials (API keys, tokens, etc.)
 * that are detected during agent execution. Instead of blocking tool calls
 * containing credentials, we:
 *
 * 1. Detect the credential in tool arguments
 * 2. Store it securely in memory with a unique reference ID
 * 3. Replace the raw credential with a reference token
 * 4. Resolve references back to real values at execution time
 *
 * This approach allows users to provide test API keys without triggering
 * "credential leaked" errors, while still maintaining security by keeping
 * raw credentials out of the conversation context.
 *
 * ## Reference Format
 *
 * Credentials are replaced with: `{{CRED:type:id}}`
 * - `type`: The credential type (e.g., "api_key", "token")
 * - `id`: A unique identifier for retrieval
 *
 * ## Usage
 *
 * ```typescript
 * import { credentialStore } from './credential-store';
 *
 * // Store a credential and get a reference
 * const ref = credentialStore.store('sk-ant-abc123', 'api_key');
 * // Returns: '{{CRED:api_key:a1b2c3}}'
 *
 * // Resolve a reference back to the real value
 * const value = credentialStore.resolve('{{CRED:api_key:a1b2c3}}');
 * // Returns: 'sk-ant-abc123'
 *
 * // Resolve all references in a string
 * const resolved = credentialStore.resolveAll('curl -H "Authorization: Bearer {{CRED:api_key:a1b2c3}}"');
 * // Returns: 'curl -H "Authorization: Bearer sk-ant-abc123"'
 * ```
 *
 * ## Security Notes
 *
 * - Credentials are stored in memory only (not persisted to disk)
 * - Each session has its own credential store
 * - References are opaque and don't reveal credential content
 * - Store is cleared when the process exits
 *
 * @module safety/credential-store
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("safety:credential-store");

/**
 * Credential types that can be stored
 */
export type CredentialType =
	| "api_key"
	| "token"
	| "password"
	| "secret"
	| "private_key"
	| "connection_string"
	| "unknown";

/**
 * Stored credential metadata
 */
interface StoredCredential {
	/** The actual credential value */
	value: string;
	/** Type of credential */
	type: CredentialType;
	/** When the credential was stored */
	storedAt: number;
	/** How many times it's been resolved */
	resolveCount: number;
}

/**
 * Reference pattern for matching credential references in strings
 * Matches: {{CRED:type:id}}
 */
const REFERENCE_PATTERN = /\{\{CRED:([a-z_]+):([a-f0-9]+)\}\}/g;

/**
 * Generate a short unique ID for credential references
 */
function generateId(): string {
	return randomBytes(6).toString("hex");
}

/**
 * Credential Store class - manages secure credential storage
 */
export class CredentialStore {
	private credentials = new Map<string, StoredCredential>();
	private valueToRef = new Map<string, string>();

	/**
	 * Store a credential and return a reference token
	 *
	 * If the same credential value is stored multiple times, the same
	 * reference is returned (deduplication).
	 *
	 * @param value - The raw credential value
	 * @param type - The type of credential
	 * @returns A reference token like `{{CRED:api_key:a1b2c3}}`
	 */
	store(value: string, type: CredentialType = "unknown"): string {
		// Check if we already have this value stored
		const existingRef = this.valueToRef.get(value);
		if (existingRef) {
			logger.debug("Credential already stored, returning existing reference", {
				type,
				refId: existingRef.match(/:([a-f0-9]+)\}\}/)?.[1],
			});
			return existingRef;
		}

		// Generate a new reference
		const id = generateId();
		const reference = `{{CRED:${type}:${id}}}`;

		// Store the credential
		this.credentials.set(id, {
			value,
			type,
			storedAt: Date.now(),
			resolveCount: 0,
		});
		this.valueToRef.set(value, reference);

		logger.debug("Stored credential", {
			type,
			refId: id,
			valueLength: value.length,
		});

		return reference;
	}

	/**
	 * Resolve a single reference token to its original value
	 *
	 * @param reference - A reference token like `{{CRED:api_key:a1b2c3}}`
	 * @returns The original credential value, or undefined if not found
	 */
	resolve(reference: string): string | undefined {
		const match = reference.match(/\{\{CRED:([a-z_]+):([a-f0-9]+)\}\}/);
		if (!match) {
			return undefined;
		}

		const id = match[2];
		if (!id) {
			return undefined;
		}
		const credential = this.credentials.get(id);
		if (!credential) {
			logger.warn("Attempted to resolve unknown credential reference", {
				refId: id,
			});
			return undefined;
		}

		credential.resolveCount++;
		return credential.value;
	}

	/**
	 * Resolve all credential references in a string
	 *
	 * @param input - String potentially containing credential references
	 * @returns String with all references replaced with actual values
	 */
	resolveAll(input: string): string {
		return input.replace(REFERENCE_PATTERN, (match, _type, id) => {
			const credential = this.credentials.get(id);
			if (!credential) {
				logger.warn("Unknown credential reference in string", { refId: id });
				return match; // Keep the reference if not found
			}
			credential.resolveCount++;
			return credential.value;
		});
	}

	/**
	 * Recursively resolve all credential references in an object
	 *
	 * @param obj - Object potentially containing credential references in string values
	 * @returns New object with all references resolved
	 */
	resolveInObject<T>(obj: T): T {
		if (obj === null || obj === undefined) {
			return obj;
		}

		if (typeof obj === "string") {
			return this.resolveAll(obj) as T;
		}

		if (Array.isArray(obj)) {
			return obj.map((item) => this.resolveInObject(item)) as T;
		}

		if (typeof obj === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(obj)) {
				result[key] = this.resolveInObject(value);
			}
			return result as T;
		}

		return obj;
	}

	/**
	 * Check if a string contains any credential references
	 */
	hasReferences(input: string): boolean {
		REFERENCE_PATTERN.lastIndex = 0; // Reset regex state
		return REFERENCE_PATTERN.test(input);
	}

	/**
	 * Get the number of stored credentials
	 */
	get size(): number {
		return this.credentials.size;
	}

	/**
	 * Clear all stored credentials
	 */
	clear(): void {
		const count = this.credentials.size;
		this.credentials.clear();
		this.valueToRef.clear();
		if (count > 0) {
			logger.debug("Cleared credential store", { clearedCount: count });
		}
	}

	/**
	 * Get statistics about stored credentials (for debugging)
	 */
	getStats(): {
		count: number;
		types: Record<CredentialType, number>;
		totalResolves: number;
	} {
		const types: Record<CredentialType, number> = {
			api_key: 0,
			token: 0,
			password: 0,
			secret: 0,
			private_key: 0,
			connection_string: 0,
			unknown: 0,
		};
		let totalResolves = 0;

		for (const cred of this.credentials.values()) {
			types[cred.type]++;
			totalResolves += cred.resolveCount;
		}

		return {
			count: this.credentials.size,
			types,
			totalResolves,
		};
	}
}

/**
 * Default credential store instance (one per process)
 */
export const credentialStore = new CredentialStore();

/**
 * Create a new credential store instance (for testing or isolation)
 */
export function createCredentialStore(): CredentialStore {
	return new CredentialStore();
}
