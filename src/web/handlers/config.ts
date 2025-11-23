import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	getComposerCustomConfig,
	getCustomConfigPath,
	reloadModelConfig,
} from "../../models/registry.js";
import {
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
			const configPath = getCustomConfigPath();
			writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
			await reloadModelConfig();
			sendJson(res, 200, { success: true }, cors);
		} catch (error) {
			respondWithApiError(res, error, 500, cors);
		}
	}
}
