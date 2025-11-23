import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { LspServerConfig } from "../lsp/index.js";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";

const logger = createLogger("config:lsp");

const CONFIG_PATH = join(homedir(), ".composer", "config.json");

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
		cachedConfig = data.lsp;
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
