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
const FACTORY_HOME = process.env.FACTORY_HOME ?? join(process.env.HOME ?? "", ".factory");
const FACTORY_KEYS_PATH = join(FACTORY_HOME, "keys.json");
const FACTORY_CONFIG_PATH = join(FACTORY_HOME, "config.json");

function loadStore(pathOverride?: string): KeyStore {
	const path = pathOverride ?? process.env.COMPOSER_KEYS_PATH ?? DEFAULT_KEYS_PATH;
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
	const stores = [loadStore(DEFAULT_KEYS_PATH), loadStore(PROJECT_KEYS_PATH)];

	// Factory keys.json (if present)
	stores.push(loadStore(FACTORY_KEYS_PATH));

	// Factory config.json (api_keys map or custom_models api_key)
	if (existsSync(FACTORY_CONFIG_PATH)) {
		try {
			const raw = readFileSync(FACTORY_CONFIG_PATH, "utf8");
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
