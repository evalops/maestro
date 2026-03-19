/**
 * Configuration Substitution Utilities
 *
 * Functions for substituting environment variables and file references
 * in configuration text. Useful for JSONC config files that need to
 * reference secrets or external content.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expandTildePath } from "./path-expansion.js";

/**
 * Logger interface for warning about missing env vars.
 * Allows callers to provide their own logging implementation.
 */
export interface SubstitutionLogger {
	warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default no-op logger for when no logging is needed.
 */
const noopLogger: SubstitutionLogger = {
	warn: () => {},
};

/**
 * Substitute environment variables in config text.
 *
 * Replaces `{env:VAR_NAME}` with the value of `process.env.VAR_NAME`.
 * If the variable is not set, returns empty string and optionally logs a warning.
 *
 * @param text - Configuration text containing {env:VAR_NAME} placeholders
 * @param logger - Optional logger for warnings about missing variables
 * @returns Text with environment variables substituted
 *
 * @example
 * ```typescript
 * const config = '{"apiKey": "{env:API_KEY}"}';
 * process.env.API_KEY = "secret123";
 * substituteEnvVars(config); // '{"apiKey": "secret123"}'
 * ```
 */
export function substituteEnvVars(
	text: string,
	logger: SubstitutionLogger = noopLogger,
): string {
	return text.replace(/\{env:([^}]+)\}/g, (_match, varName: string) => {
		const name = varName.trim();
		const value = process.env[name];
		if (value === undefined) {
			logger.warn("Environment variable not set, using empty string", {
				varName: name,
			});
			return "";
		}
		return value;
	});
}

/**
 * Substitute file references in config text.
 *
 * Replaces `{file:path}` with the contents of the file, properly escaped
 * for JSON strings (handles newlines, quotes, etc.).
 *
 * Path resolution:
 * - `~/path` → resolved from home directory
 * - `/absolute/path` → used as-is
 * - `relative/path` → resolved from configDir
 *
 * Skips processing in comment lines (// or /* or *).
 *
 * @param text - Configuration text containing {file:path} placeholders
 * @param configDir - Base directory for resolving relative paths
 * @returns Text with file contents substituted
 * @throws Error if file cannot be read
 *
 * @example
 * ```typescript
 * const config = '{"cert": "{file:./cert.pem}"}';
 * substituteFileRefs(config, "/app/config");
 * // Reads /app/config/cert.pem and inserts escaped contents
 * ```
 */
export function substituteFileRefs(text: string, configDir: string): string {
	const lines = text.split("\n");
	let result = "";

	for (const line of lines) {
		// Skip commented lines (don't process file refs in comments)
		const trimmed = line.trim();
		if (
			trimmed.startsWith("//") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("*")
		) {
			result += `${line}\n`;
			continue;
		}

		let processedLine = line;
		const matches = [...line.matchAll(/\{file:([^}]+)\}/g)];

		for (const match of matches) {
			let filePath = match[1]?.trim();
			if (!filePath) continue;

			filePath = expandTildePath(filePath);

			// Handle relative paths
			if (!isAbsolute(filePath)) {
				filePath = join(configDir, filePath);
			}

			try {
				const fileContent = readFileSync(filePath, "utf-8").trim();
				// Escape for JSON string (handle newlines, quotes, etc.)
				const escaped = JSON.stringify(fileContent).slice(1, -1);
				processedLine = processedLine.replace(match[0], escaped);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to read file reference "${match[0]}" in config: ${filePath}\n${errMsg}`,
				);
			}
		}

		result += `${processedLine}\n`;
	}

	return result;
}
