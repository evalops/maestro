import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

const ENV_FILES = [".env.local", ".env"];
const BLOCKED_DOTENV_KEYS = new Set([
	"HOME",
	"FACTORY_HOME",
	"MAESTRO_HOME",
	"MAESTRO_CONFIG",
	"MAESTRO_LLM_GATEWAY_URL",
	"MAESTRO_MODELS_FILE",
	"MAESTRO_TRUST_PROJECT_MODEL_CONFIG",
	"USERPROFILE",
]);
const normalizeEnvKey = (key: string) => key.toUpperCase();

export function loadEnv(): string[] {
	const loadedKeys = new Set<string>();
	for (const file of ENV_FILES) {
		const resolved = join(process.cwd(), file);
		if (existsSync(resolved)) {
			const before = new Set(Object.keys(process.env));
			const beforeNormalized = new Set([...before].map(normalizeEnvKey));
			const result = config({ path: resolved, override: false });
			const after = new Set(Object.keys(process.env));
			for (const key of Object.keys(result.parsed ?? {})) {
				const normalizedKey = normalizeEnvKey(key);
				const wasLoadedByDotenv = !before.has(key) && after.has(key);
				if (wasLoadedByDotenv && BLOCKED_DOTENV_KEYS.has(normalizedKey)) {
					Reflect.deleteProperty(process.env, key);
					continue;
				}
				if (wasLoadedByDotenv && !beforeNormalized.has(normalizedKey)) {
					loadedKeys.add(key);
				}
			}
		}
	}
	return [...loadedKeys];
}
