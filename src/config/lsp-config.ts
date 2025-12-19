/**
 * LSP Configuration - Language Server Protocol Settings
 *
 * This module manages configuration for LSP (Language Server Protocol)
 * integrations. It allows users to customize or disable LSP servers,
 * control diagnostic behavior, and configure server-specific settings.
 *
 * ## Configuration File
 *
 * Location: `~/.composer/config.json`
 *
 * ```json
 * {
 *   "lsp": {
 *     "enabled": true,
 *     "blockingSeverity": 1,
 *     "maxDiagnosticsPerFile": 10,
 *     "maxFilesInContext": 5,
 *     "servers": {
 *       "typescript": {
 *         "enabled": true,
 *         "command": "typescript-language-server",
 *         "args": ["--stdio"]
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * ## Server Overrides
 *
 * Each server can be customized with:
 * - `enabled`: Enable/disable the server
 * - `command`: Override the server command
 * - `args`: Override command arguments
 * - `env`: Additional environment variables
 * - `extensions`: File extensions to associate
 * - `initializationOptions`: LSP initialization options
 *
 * ## Diagnostic Settings
 *
 * | Setting              | Default | Description                       |
 * |----------------------|---------|-----------------------------------|
 * | blockingSeverity     | 1       | Minimum severity to block on      |
 * | maxDiagnosticsPerFile| 10      | Max diagnostics shown per file    |
 * | maxFilesInContext    | 5       | Max files with errors in context  |
 *
 * @module config/lsp-config
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { LspServerConfig } from "../lsp/index.js";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";
import { PATHS } from "./constants.js";

const logger = createLogger("config:lsp");

const CONFIG_PATH = join(PATHS.COMPOSER_HOME, "config.json");

const serverOverrideSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	command: Type.Optional(Type.String({ minLength: 1 })),
	args: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	extensions: Type.Optional(
		Type.Array(
			Type.String({
				pattern: "^\\.",
			}),
		),
	),
	initializationOptions: Type.Optional(
		Type.Record(Type.String(), Type.Unknown()),
	),
});

const configSchema = Type.Object({
	lsp: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true })),
			servers: Type.Optional(Type.Record(Type.String(), serverOverrideSchema)),
			blockingSeverity: Type.Optional(
				Type.Integer({ minimum: 1, description: "LSP blocking severity" }),
			),
			maxDiagnosticsPerFile: Type.Optional(
				Type.Integer({
					minimum: 1,
					default: 10,
					description: "Max diagnostics shown in read tool",
				}),
			),
			maxFilesInContext: Type.Optional(
				Type.Integer({
					minimum: 1,
					default: 5,
					description: "Max files with errors shown in context",
				}),
			),
		},
		{ default: { enabled: true } },
	),
});
type LspConfig = Static<typeof configSchema>["lsp"];

const validateConfig = compileTypeboxSchema(configSchema);

let cachedConfig: LspConfig | null = null;

function loadRawConfig(): LspConfig {
	if (cachedConfig) {
		return cachedConfig;
	}
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = { enabled: true };
		return cachedConfig;
	}
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const result = safeJsonParse<{ lsp?: LspConfig }>(raw, "LSP config");

		if (!result.success) {
			throw new Error(
				`Failed to parse config: ${"error" in result ? result.error.message : "Unknown error"}`,
			);
		}

		const data = result.data;
		if (!validateConfig(data)) {
			const message =
				validateConfig.errors
					?.map(
						(err) => `${err.instancePath || "/"} ${err.message ?? "invalid"}`,
					)
					.join("; ") ?? "Invalid config";
			throw new Error(message);
		}
		// After validation, lsp is guaranteed to exist (schema has default)
		cachedConfig = data.lsp ?? { enabled: true };
		return cachedConfig;
	} catch (error) {
		logger.error(
			"Failed to parse config",
			error instanceof Error ? error : new Error(String(error)),
		);
		cachedConfig = { enabled: true };
		return cachedConfig;
	}
}

export function getLspConfig(): LspConfig {
	return loadRawConfig();
}

export function applyServerOverrides(
	defaults: LspServerConfig[],
): LspServerConfig[] {
	const config = getLspConfig();
	if (!config.enabled) {
		return [];
	}
	if (!config.servers) {
		return defaults;
	}
	return defaults
		.map((server) => {
			const override = config.servers?.[server.id];
			if (!override) {
				return server;
			}
			if (override.enabled === false) {
				return null;
			}
			return {
				...server,
				command: override.command ?? server.command,
				args: override.args ?? server.args,
				env: override.env ? { ...server.env, ...override.env } : server.env,
				extensions: override.extensions ?? server.extensions,
				initializationOptions:
					override.initializationOptions ?? server.initializationOptions,
			};
		})
		.filter(Boolean) as LspServerConfig[];
}
