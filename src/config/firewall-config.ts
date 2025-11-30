import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { safeJsonParse } from "../utils/json.js";
import { createLogger } from "../utils/logger.js";
import { compileTypeboxSchema } from "../utils/typebox-ajv.js";

const logger = createLogger("config:firewall");

const CONFIG_PATH = join(homedir(), ".composer", "firewall.json");

const firewallConfigSchema = Type.Object({
	containment: Type.Optional(
		Type.Object({
			trustedPaths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Additional absolute paths (and their subdirectories) where file modifications are allowed",
				}),
			),
		}),
	),
});

export type FirewallConfig = Static<typeof firewallConfigSchema>;

const validateConfig = compileTypeboxSchema(firewallConfigSchema);

let cachedConfig: FirewallConfig | null = null;

function loadRawConfig(): FirewallConfig {
	if (cachedConfig) {
		return cachedConfig;
	}
	if (!existsSync(CONFIG_PATH)) {
		// Default config
		cachedConfig = {};
		return cachedConfig;
	}
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const result = safeJsonParse<FirewallConfig>(raw, "Firewall config");

		if (!result.success) {
			logger.error(
				`Failed to parse firewall config: ${"error" in result ? result.error.message : "Unknown error"}`,
			);
			return {};
		}

		const data = result.data;
		if (!validateConfig(data)) {
			logger.error(
				`Invalid firewall config: ${validateConfig.errors?.map((e) => e.message).join(", ")}`,
			);
			return {};
		}
		cachedConfig = data;
		return cachedConfig;
	} catch (error) {
		logger.error(
			"Failed to load firewall config",
			error instanceof Error ? error : new Error(String(error)),
		);
		return {};
	}
}

export function getFirewallConfig(): FirewallConfig {
	return loadRawConfig();
}

/**
 * Reset cache for tests
 */
export function resetFirewallConfigCache(): void {
	cachedConfig = null;
}
