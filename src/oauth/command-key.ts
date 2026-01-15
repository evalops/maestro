/**
 * Command-Based API Key Retrieval
 *
 * Allows users to retrieve API keys from external commands, enabling secure
 * storage in password managers, keychains, or other secret stores.
 *
 * ## Usage
 *
 * Configure API keys with a `cmd:` prefix to execute a command:
 *
 * ```json
 * {
 *   "anthropic": {
 *     "apiKey": "cmd:security find-generic-password -ws 'anthropic'"
 *   }
 * }
 * ```
 *
 * ## Supported Secret Managers
 *
 * - **macOS Keychain**: `cmd:security find-generic-password -ws 'service-name'`
 * - **1Password CLI**: `cmd:op read 'op://vault/item/field'`
 * - **Bitwarden CLI**: `cmd:bw get password anthropic-api-key`
 * - **HashiCorp Vault**: `cmd:vault kv get -field=api_key secret/anthropic`
 * - **AWS Secrets Manager**: `cmd:aws secretsmanager get-secret-value --secret-id anthropic --query SecretString --output text`
 * - **GCP Secret Manager**: `cmd:gcloud secrets versions access latest --secret=anthropic-api-key`
 * - **Azure Key Vault**: `cmd:az keyvault secret show --vault-name my-vault --name anthropic-key --query value -o tsv`
 * - **gopass**: `cmd:gopass show -o anthropic/api-key`
 * - **pass**: `cmd:pass show anthropic/api-key`
 *
 * ## Caching
 *
 * Retrieved keys are cached in memory for the duration of the session to avoid
 * repeated command executions. The cache can be cleared manually if needed.
 */

import { execSync } from "node:child_process";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("oauth:command-key");

/**
 * Prefix indicating a command-based key
 */
export const COMMAND_PREFIX = "cmd:";

/**
 * Cache timeout for command results (5 minutes)
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Maximum command execution time (10 seconds)
 */
const COMMAND_TIMEOUT_MS = 10 * 1000;

/**
 * Cached command result
 */
interface CachedResult {
	value: string;
	timestamp: number;
}

/**
 * In-memory cache for command results
 */
const commandCache = new Map<string, CachedResult>();

/**
 * Check if a value is a command-based key
 */
export function isCommandKey(value: string): boolean {
	return value.startsWith(COMMAND_PREFIX);
}

/**
 * Extract the command from a command-based key value
 */
export function extractCommand(value: string): string {
	if (!isCommandKey(value)) {
		throw new Error(`Value is not a command key: ${value.slice(0, 20)}...`);
	}
	return value.slice(COMMAND_PREFIX.length).trim();
}

/**
 * Execute a command and return its output
 */
function executeCommand(command: string): string {
	try {
		const result = execSync(command, {
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
			// Don't inherit environment to avoid leaking secrets via commands
			env: {
				...process.env,
				// Clear potentially sensitive env vars that could interfere
				AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
				AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
				GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
				AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID,
				AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET,
				OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN,
			},
		});

		// Trim whitespace and newlines from output
		return result.trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("Command execution failed", {
			commandPreview: command.slice(0, 50),
			errorType: error instanceof Error ? error.name : "unknown",
		});
		throw new Error(`Failed to execute API key command: ${message}`);
	}
}

/**
 * Resolve a command-based API key
 *
 * @param value - The command key value (e.g., "cmd:security find-generic-password -ws 'anthropic'")
 * @param useCache - Whether to use cached results (default true)
 * @returns The resolved API key value
 */
export function resolveCommandKey(value: string, useCache = true): string {
	if (!isCommandKey(value)) {
		return value;
	}

	const command = extractCommand(value);

	// Check cache
	if (useCache) {
		const cached = commandCache.get(command);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			logger.debug("Using cached command result", {
				commandPreview: command.slice(0, 30),
			});
			return cached.value;
		}
	}

	// Execute command
	logger.info("Executing API key command", {
		commandPreview: command.slice(0, 30),
	});

	const result = executeCommand(command);

	if (!result) {
		throw new Error(`Command returned empty result: ${command.slice(0, 30)}...`);
	}

	// Cache result
	commandCache.set(command, {
		value: result,
		timestamp: Date.now(),
	});

	return result;
}

/**
 * Clear the command result cache
 */
export function clearCommandCache(): void {
	commandCache.clear();
	logger.info("Command cache cleared");
}

/**
 * Clear cached result for a specific command
 */
export function clearCommandCacheEntry(command: string): void {
	commandCache.delete(command);
}

/**
 * Resolve an API key value, handling both direct values and command-based values
 *
 * @param value - The API key value (direct or cmd: prefixed)
 * @returns The resolved API key
 */
export function resolveApiKey(value: string): string {
	if (isCommandKey(value)) {
		return resolveCommandKey(value);
	}
	return value;
}

/**
 * Batch resolve multiple API keys
 *
 * @param keys - Map of key names to values (may include cmd: prefixed values)
 * @returns Map of key names to resolved values
 */
export function resolveApiKeys(
	keys: Record<string, string>,
): Record<string, string> {
	const resolved: Record<string, string> = {};

	for (const [name, value] of Object.entries(keys)) {
		try {
			resolved[name] = resolveApiKey(value);
		} catch (error) {
			logger.warn("Failed to resolve API key", {
				keyName: name,
				errorType: error instanceof Error ? error.name : "unknown",
			});
			// Keep original value if resolution fails
			resolved[name] = value;
		}
	}

	return resolved;
}

/**
 * Validate that a command-based key can be resolved
 * Useful for config validation
 */
export function validateCommandKey(value: string): { valid: boolean; error?: string } {
	if (!isCommandKey(value)) {
		return { valid: true };
	}

	try {
		const result = resolveCommandKey(value, false);
		if (!result) {
			return { valid: false, error: "Command returned empty result" };
		}
		return { valid: true };
	} catch (error) {
		return {
			valid: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Common command templates for popular secret managers
 */
export const COMMAND_TEMPLATES = {
	macos_keychain: (service: string) =>
		`cmd:security find-generic-password -ws '${service}'`,

	onepassword: (vault: string, item: string, field = "credential") =>
		`cmd:op read 'op://${vault}/${item}/${field}'`,

	bitwarden: (itemName: string) => `cmd:bw get password '${itemName}'`,

	vault: (path: string, field: string) =>
		`cmd:vault kv get -field=${field} ${path}`,

	aws_secrets: (secretId: string) =>
		`cmd:aws secretsmanager get-secret-value --secret-id ${secretId} --query SecretString --output text`,

	gcp_secrets: (secretName: string, version = "latest") =>
		`cmd:gcloud secrets versions access ${version} --secret=${secretName}`,

	azure_keyvault: (vaultName: string, secretName: string) =>
		`cmd:az keyvault secret show --vault-name ${vaultName} --name ${secretName} --query value -o tsv`,

	gopass: (path: string) => `cmd:gopass show -o ${path}`,

	pass: (path: string) => `cmd:pass show ${path}`,
};
