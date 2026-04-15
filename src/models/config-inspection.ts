/**
 * Config Inspection and Validation
 * Validate and inspect model configuration for CLI commands.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { expandTildePath } from "../utils/path-expansion.js";
import { getConfigPaths, loadConfig, loadConfigFile } from "./config-loader.js";
import { ensureFactoryData } from "./factory-integration.js";
import { isLocalBaseUrl } from "./url-normalize.js";

/**
 * Validate config without loading it (for CLI validation command)
 */
export interface ConfigValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	summary: {
		configFiles: string[];
		providers: number;
		models: number;
		fileReferences: string[];
		envVars: string[];
	};
}

export function validateConfig(): ConfigValidationResult {
	const result: ConfigValidationResult = {
		valid: true,
		errors: [],
		warnings: [],
		summary: {
			configFiles: [],
			providers: 0,
			models: 0,
			fileReferences: [],
			envVars: [],
		},
	};

	const paths = getConfigPaths();

	// Check each config file
	for (const path of paths) {
		if (!existsSync(path)) {
			continue;
		}

		result.summary.configFiles.push(path);

		try {
			const raw = readFileSync(path, "utf-8");

			// Find file references
			const fileMatches = [...raw.matchAll(/\{file:([^}]+)\}/g)];
			for (const match of fileMatches) {
				const matchedPath = match[1];
				if (!matchedPath) continue;
				let filePath = expandTildePath(matchedPath);
				if (!isAbsolute(filePath)) {
					filePath = join(dirname(path), filePath);
				}

				result.summary.fileReferences.push(filePath);

				if (!existsSync(filePath)) {
					result.errors.push(`File reference not found: ${filePath}`);
					result.valid = false;
				}
			}

			// Find env vars
			const envMatches = [...raw.matchAll(/\{env:([^}]+)\}/g)];
			for (const match of envMatches) {
				const varName = match[1];
				if (!varName) continue;
				result.summary.envVars.push(varName);

				if (!process.env[varName]) {
					result.warnings.push(`Environment variable not set: ${varName}`);
				}
			}

			// Try parsing
			const config = loadConfigFile(path);
			if (config) {
				result.summary.providers += config.providers.length;
				for (const provider of config.providers) {
					const modelCount = provider.models?.length ?? 0;
					result.summary.models += modelCount;
					if (modelCount === 0 && !provider.baseUrl && !provider.headers) {
						result.warnings.push(
							`Provider "${provider.id}" has no models and no override settings (baseUrl/headers); entry has no effect.`,
						);
					}
				}
			}
		} catch (error) {
			result.errors.push(
				`Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
			result.valid = false;
		}
	}

	if (result.summary.configFiles.length === 0) {
		result.warnings.push("No config files found");
	}

	return result;
}

/**
 * Get config info for inspection (for CLI show command)
 */
export interface ConfigInspection {
	sources: Array<{
		path: string;
		exists: boolean;
		loaded: boolean;
	}>;
	providers: Array<{
		id: string;
		name: string;
		baseUrl: string;
		enabled: boolean;
		apiKeySource?: string;
		isLocal: boolean;
		options?: Record<string, unknown>;
		modelCount: number;
		models: Array<{
			id: string;
			name: string;
			reasoning?: boolean;
			input?: string[];
		}>;
	}>;
	fileReferences: Array<{
		path: string;
		exists: boolean;
		size?: number;
	}>;
	envVars: Array<{
		name: string;
		set: boolean;
		maskedValue?: string;
	}>;
}

export function inspectConfig(): ConfigInspection {
	const paths = getConfigPaths();
	const config = loadConfig(true, ensureFactoryData);

	const inspection: ConfigInspection = {
		sources: [],
		providers: [],
		fileReferences: [],
		envVars: [],
	};

	// Track sources
	for (const path of paths) {
		const exists = existsSync(path);
		inspection.sources.push({
			path,
			exists,
			loaded: exists,
		});
	}

	// Track providers
	for (const provider of config.providers) {
		const models = provider.models ?? [];
		let apiKeySource: string | undefined;

		if (provider.apiKeyEnv) {
			apiKeySource = `env:${provider.apiKeyEnv}`;
		} else if (provider.apiKey) {
			apiKeySource = "direct (hardcoded)";
		}

		const providerBase = provider.baseUrl || "(auto-generated)";
		const local =
			isLocalBaseUrl(provider.baseUrl) ||
			models.some((model) => isLocalBaseUrl(model.baseUrl));
		inspection.providers.push({
			id: provider.id,
			name: provider.name,
			baseUrl: providerBase,
			enabled: provider.enabled !== false,
			apiKeySource,
			isLocal: local,
			options: provider.options,
			modelCount: models.length,
			models: models.map((m) => ({
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				input: m.input,
			})),
		});
	}

	// Track file references (scan all config files)
	for (const path of paths) {
		if (!existsSync(path)) continue;

		const raw = readFileSync(path, "utf-8");
		const fileMatches = [...raw.matchAll(/\{file:([^}]+)\}/g)];

		for (const match of fileMatches) {
			const matchedPath = match[1];
			if (!matchedPath) continue;
			let filePath = expandTildePath(matchedPath);
			if (!isAbsolute(filePath)) {
				filePath = join(dirname(path), filePath);
			}

			const exists = existsSync(filePath);
			let size: number | undefined;

			if (exists) {
				try {
					size = statSync(filePath).size;
				} catch {
					// File may have been deleted between existsSync and statSync
				}
			}

			inspection.fileReferences.push({
				path: filePath,
				exists,
				size,
			});
		}
	}

	// Track env vars
	const envVarsSet = new Set<string>();
	for (const path of paths) {
		if (!existsSync(path)) continue;

		const raw = readFileSync(path, "utf-8");
		const envMatches = [...raw.matchAll(/\{env:([^}]+)\}/g)];

		for (const match of envMatches) {
			const envVar = match[1];
			if (envVar) {
				envVarsSet.add(envVar);
			}
		}
	}

	for (const provider of config.providers) {
		if (provider.apiKeyEnv) {
			envVarsSet.add(provider.apiKeyEnv);
		}
	}

	for (const varName of envVarsSet) {
		const value = process.env[varName];
		const set = value !== undefined;

		let maskedValue: string | undefined;
		if (set && value) {
			// Mask the value (show first 4 chars)
			maskedValue =
				value.length > 8 ? `${value.slice(0, 4)}${"•".repeat(8)}` : "••••••••";
		}

		inspection.envVars.push({
			name: varName,
			set,
			maskedValue,
		});
	}

	return inspection;
}

/**
 * Get the list of config paths being checked
 */
export function getConfigHierarchy(): string[] {
	return getConfigPaths();
}
