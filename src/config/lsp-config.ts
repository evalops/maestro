import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LspServerConfig } from "../lsp/index.js";
import { resolveWorkspaceRoot } from "../workspace/root-resolver.js";

const CONFIG_PATH = join(homedir(), ".composer", "config.json");

const serverOverrideSchema = z.object({
	enabled: z.boolean().optional(),
	command: z.string().min(1).optional(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string()).optional(),
	extensions: z.array(z.string().regex(/^\./)).optional(),
	initializationOptions: z.record(z.unknown()).optional(),
});

const configSchema = z.object({
	lsp: z
		.object({
			enabled: z.boolean().default(true),
			servers: z.record(serverOverrideSchema).optional(),
			blockingSeverity: z.number().int().positive().optional(),
		})
		.default({ enabled: true }),
});
type LspConfig = z.infer<typeof configSchema>["lsp"];

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
		const parsed = configSchema.parse(JSON.parse(raw));
		cachedConfig = parsed.lsp;
		return parsed.lsp;
	} catch (error) {
		console.error("[lsp-config] Failed to parse", error);
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
