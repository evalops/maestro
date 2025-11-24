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

function loadStore(): KeyStore {
	const path = process.env.COMPOSER_KEYS_PATH ?? DEFAULT_KEYS_PATH;
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
	const store = loadStore();
	return store[providerId] ?? {};
}
