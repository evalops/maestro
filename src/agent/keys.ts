import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PATHS } from "../config/constants.js";
import { getHomeDir, resolveEnvPath } from "../utils/path-expansion.js";

type StoredKey = {
	apiKey?: string;
	authType?: "api-key" | "anthropic-oauth";
};

type KeyStore = Record<string, StoredKey>;

const DEFAULT_KEYS_PATH = join(PATHS.MAESTRO_HOME, "keys.json");
const PROJECT_KEYS_PATH = join(process.cwd(), ".maestro", "keys.json");

function getFactoryPaths(): { keysPath: string; configPath: string } {
	const factoryHome =
		resolveEnvPath(process.env.FACTORY_HOME) ?? join(getHomeDir(), ".factory");
	return {
		keysPath: join(factoryHome, "keys.json"),
		configPath: join(factoryHome, "config.json"),
	};
}

function sanitizePath(pathOverride?: string): string | undefined {
	const candidate =
		pathOverride ??
		resolveEnvPath(process.env.MAESTRO_KEYS_PATH) ??
		DEFAULT_KEYS_PATH;
	if (!candidate) return undefined;
	const resolved = resolve(candidate);
	const allowedRoots = [getHomeDir(), PATHS.MAESTRO_HOME, process.cwd()].map(
		(p) => resolve(p),
	);
	// Use proper path containment check - require path separator after root
	// to prevent /home/user-evil matching when root is /home/user
	const isAllowed = allowedRoots.some((root) => {
		if (resolved === root) return true;
		return resolved.startsWith(root + sep);
	});
	if (!isAllowed) return undefined;
	return resolved;
}

function loadStore(pathOverride?: string): KeyStore {
	const path = sanitizePath(pathOverride);
	if (!path || !existsSync(path)) return {};
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
	const stores = [loadStore(PROJECT_KEYS_PATH), loadStore()];

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
		if (cred?.apiKey) {
			const authType =
				cred.authType === "anthropic-oauth"
					? "anthropic-oauth"
					: cred.authType === "api-key"
						? "api-key"
						: undefined;
			return { apiKey: cred.apiKey, authType };
		}
	}
	return {};
}
