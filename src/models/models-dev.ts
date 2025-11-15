import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Models.dev integration
 * Fetches and caches model definitions from https://models.dev/api.json
 */

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_DIR = join(homedir(), ".composer");
const CACHE_FILE = join(CACHE_DIR, "models-dev-cache.json");
const CACHE_MAX_AGE_MS = 1000 * 60 * 60; // 1 hour

interface ModelsDev {
	[providerId: string]: {
		id: string;
		name: string;
		api?: string;
		npm?: string;
		env?: string[];
		models: {
			[modelId: string]: {
				id: string;
				name: string;
				release_date?: string;
				attachment?: boolean;
				reasoning?: boolean;
				temperature?: boolean;
				tool_call?: boolean;
				cost: {
					input: number;
					output: number;
					cache_read?: number;
					cache_write?: number;
				};
				limit: {
					context: number;
					output: number;
				};
				modalities?: {
					input?: string[];
					output?: string[];
				};
				experimental?: boolean;
				status?: "alpha" | "beta" | "deprecated";
			};
		};
	};
}

let cachedData: ModelsDev | null = null;
let lastFetchTime = 0;

/**
 * Read cached models.dev data from disk
 */
function readCache(): ModelsDev | null {
	try {
		if (!existsSync(CACHE_FILE)) {
			return null;
		}
		
		const data = readFileSync(CACHE_FILE, "utf-8");
		const parsed = JSON.parse(data);
		
		// Check cache age
		const stats = require("fs").statSync(CACHE_FILE);
		const age = Date.now() - stats.mtimeMs;
		
		if (age > CACHE_MAX_AGE_MS) {
			console.log("[Models.dev] Cache expired, will refresh");
			return null;
		}
		
		return parsed as ModelsDev;
	} catch (error) {
		console.warn("[Models.dev] Failed to read cache:", error);
		return null;
	}
}

/**
 * Write models.dev data to cache
 */
function writeCache(data: ModelsDev): void {
	try {
		// Ensure directory exists
		if (!existsSync(CACHE_DIR)) {
			require("fs").mkdirSync(CACHE_DIR, { recursive: true });
		}
		
		writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
		console.log("[Models.dev] Cache updated");
	} catch (error) {
		console.warn("[Models.dev] Failed to write cache:", error);
	}
}

/**
 * Fetch fresh data from models.dev API
 */
async function fetchFromApi(): Promise<ModelsDev | null> {
	try {
		console.log("[Models.dev] Fetching from API...");
		
		const response = await fetch(MODELS_DEV_URL, {
			signal: AbortSignal.timeout(10000), // 10 second timeout
			headers: {
				"User-Agent": "composer-cli",
			},
		});
		
		if (!response.ok) {
			console.warn(`[Models.dev] API returned ${response.status}`);
			return null;
		}
		
		const data = await response.json() as ModelsDev;
		console.log(`[Models.dev] Fetched ${Object.keys(data).length} providers`);
		
		// Cache the fresh data
		writeCache(data);
		lastFetchTime = Date.now();
		
		return data;
	} catch (error) {
		console.warn("[Models.dev] Failed to fetch from API:", error);
		return null;
	}
}

/**
 * Get models.dev data (cached or fresh)
 */
export async function getModelsDev(): Promise<ModelsDev | null> {
	// Return cached in-memory data if available and fresh
	if (cachedData && Date.now() - lastFetchTime < CACHE_MAX_AGE_MS) {
		return cachedData;
	}
	
	// Try reading from disk cache
	const diskCache = readCache();
	if (diskCache) {
		cachedData = diskCache;
		lastFetchTime = Date.now();
		return diskCache;
	}
	
	// Fetch fresh data from API
	const freshData = await fetchFromApi();
	if (freshData) {
		cachedData = freshData;
		return freshData;
	}
	
	// If all else fails, return null
	return null;
}

/**
 * Refresh models.dev data in the background
 * Non-blocking, updates cache for next time
 */
export function refreshModelsDev(): void {
	// Non-blocking background refresh
	fetchFromApi().catch(() => {
		// Silently fail, cache will be used next time
	});
}

/**
 * Clear the models.dev cache
 */
export function clearModelsDevCache(): void {
	try {
		if (existsSync(CACHE_FILE)) {
			require("fs").unlinkSync(CACHE_FILE);
			console.log("[Models.dev] Cache cleared");
		}
		cachedData = null;
		lastFetchTime = 0;
	} catch (error) {
		console.warn("[Models.dev] Failed to clear cache:", error);
	}
}

/**
 * Start background refresh interval (optional)
 * Refreshes every hour to keep cache fresh
 */
export function startAutoRefresh(): void {
	const interval = setInterval(() => {
		refreshModelsDev();
	}, CACHE_MAX_AGE_MS);
	
	// Don't block process exit
	interval.unref();
	
	console.log("[Models.dev] Auto-refresh enabled (1 hour interval)");
}
