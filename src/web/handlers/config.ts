import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	getComposerCustomConfig,
	getCustomConfigPath,
	reloadModelConfig,
} from "../../models/registry.js";
import {
	ApiError,
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleConfig(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	if (req.method === "GET") {
		try {
			const config = getComposerCustomConfig();
			const configPath = getCustomConfigPath();
			sendJson(res, 200, { config, configPath }, cors);
		} catch (error) {
			respondWithApiError(res, error, 500, cors);
		}
	} else if (req.method === "POST") {
		try {
			const { config } = await readJsonBody<{ config: unknown }>(req);
			if (
				config === null ||
				typeof config !== "object" ||
				Array.isArray(config)
			) {
				throw new ApiError(400, "Config must be a JSON object");
			}
			if (containsPollutionKeys(config)) {
				throw new ApiError(400, "Config contains forbidden keys");
			}
			const configPath = getCustomConfigPath();
			writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
			await reloadModelConfig();
			sendJson(res, 200, { success: true }, cors);
		} catch (error) {
			respondWithApiError(res, error, 500, cors);
		}
	}
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function containsPollutionKeys(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value))
		return value.some((entry) => containsPollutionKeys(entry));

	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_KEYS.has(key)) return true;
		if (containsPollutionKeys(val)) return true;
	}
	return false;
}
