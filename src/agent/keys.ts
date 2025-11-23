import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type StoredKey = {
	apiKey?: string;
	authType?: "api-key" | "chatgpt" | "anthropic-oauth";
};

type KeyStore = Record<string, StoredKey>;

const DEFAULT_KEYS_PATH = join(
	process.env.HOME ?? process.cwd(),
	".composer",
	"keys.json",
);
const PROJECT_KEYS_PATH = join(process.cwd(), ".composer", "keys.json");

function getFactoryPaths(): { keysPath: string; configPath: string } {
	const factoryHome =
		process.env.FACTORY_HOME ?? join(process.env.HOME ?? "", ".factory");
	return {
		keysPath: join(factoryHome, "keys.json"),
		configPath: join(factoryHome, "config.json"),
	};
}

function loadStore(pathOverride?: string): KeyStore {
	const path =
		pathOverride ?? process.env.COMPOSER_KEYS_PATH ?? DEFAULT_KEYS_PATH;
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as KeyStore;
		return parsed ?? {};
	} catch {
		return {};
	}
}

export function getStoredCredentials(providerId: string): {
	apiKey?: string;
	authType?: StoredKey["authType"];
} {
	const stores = [loadStore(), loadStore(PROJECT_KEYS_PATH)];

	// Factory keys.json (if present)
	const { keysPath: factoryKeysPath, configPath: factoryConfigPath } =
		getFactoryPaths();
	stores.push(loadStore(factoryKeysPath));

	// Factory config.json (api_keys map or custom_models api_key)
	if (existsSync(factoryConfigPath)) {
		try {
			const raw = readFileSync(factoryConfigPath, "utf8");
			const parsed = JSON.parse(raw) as {
				api_keys?: Record<string, string>;
				custom_models?: Array<{ provider?: string; api_key?: string }>;
			};
			const apiKeys = parsed.api_keys ?? {};
			const models = parsed.custom_models ?? [];
			const aggregated: Record<string, StoredKey> = {};
			for (const [prov, key] of Object.entries(apiKeys)) {
				if (key) aggregated[prov] = { apiKey: key, authType: "api-key" };
			}
			for (const entry of models) {
				const prov = entry.provider ?? "factory";
				if (entry.api_key && !aggregated[prov]) {
					aggregated[prov] = { apiKey: entry.api_key, authType: "api-key" };
				}
			}
			stores.push(aggregated);
		} catch {
			// ignore malformed factory config
		}
	}

	for (const store of stores) {
		const cred = store[providerId];
		if (cred?.apiKey) return cred;
	}
	return {};
}
