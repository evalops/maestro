import { loadConfig } from "../../config/index.js";

export type HistoryPersistence = "save-all" | "none";

export interface HistorySettings {
	persistence: HistoryPersistence;
	maxBytes?: number;
}

const DEFAULT_PERSISTENCE: HistoryPersistence = "save-all";

function parsePersistence(value?: string | null): HistoryPersistence | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "none") return "none";
	if (normalized === "save-all" || normalized === "save") return "save-all";
	return null;
}

function parseMaxBytes(value?: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function resolveHistorySettings(
	cwd: string = process.cwd(),
): HistorySettings {
	let persistence = parsePersistence(process.env.COMPOSER_HISTORY_PERSISTENCE);
	let maxBytes = parseMaxBytes(process.env.COMPOSER_HISTORY_MAX_BYTES);

	if (!persistence || maxBytes === undefined) {
		try {
			const config = loadConfig(cwd);
			if (!persistence) {
				const configValue = parsePersistence(
					config.history?.persistence ?? null,
				);
				if (configValue) {
					persistence = configValue;
				}
			}
			if (maxBytes === undefined) {
				const configBytes = config.history?.max_bytes;
				if (typeof configBytes === "number" && Number.isFinite(configBytes)) {
					maxBytes = Math.max(0, Math.floor(configBytes));
				}
			}
		} catch {
			// Ignore config load errors - history settings default to env or defaults.
		}
	}

	return {
		persistence: persistence ?? DEFAULT_PERSISTENCE,
		maxBytes,
	};
}
