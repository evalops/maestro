import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type WorkspaceConfigInput,
	type WorkspaceConfigPatchInput,
	WorkspaceConfigUnavailableError,
	WorkspaceConfigValidationError,
	getWorkspaceConfigService,
	normalizeWorkspaceConfigListQuery,
} from "../../services/workspace-config/index.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleWorkspaceConfig(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	params: Record<string, string> = {},
): Promise<void> {
	try {
		const url = new URL(
			req.url || "/api/workspace-configs",
			`http://${req.headers.host || "localhost"}`,
		);
		const service = getWorkspaceConfigService();
		const workspaceId = params.workspaceId
			? decodeURIComponent(params.workspaceId)
			: undefined;

		if (req.method === "GET" && workspaceId) {
			const config = await service.getConfig(workspaceId);
			if (!config) {
				sendJson(res, 404, { error: "Workspace config not found." }, cors, req);
				return;
			}
			sendJson(res, 200, { config }, cors, req);
			return;
		}

		if (req.method === "GET") {
			const result = await service.listConfigs(
				normalizeWorkspaceConfigListQuery({
					limit: url.searchParams.get("limit"),
					offset: url.searchParams.get("offset"),
				}),
			);
			sendJson(res, 200, result, cors, req);
			return;
		}

		if (req.method === "POST") {
			const body = await readJsonBody<WorkspaceConfigInput>(req);
			const config = await service.upsertConfig(body);
			sendJson(res, 201, { config }, cors, req);
			return;
		}

		if (req.method === "PUT" && workspaceId) {
			const body = await readJsonBody<WorkspaceConfigPatchInput>(req);
			const config = await service.patchConfig(workspaceId, body);
			sendJson(res, 200, { config }, cors, req);
			return;
		}

		if (req.method === "DELETE" && workspaceId) {
			const deleted = await service.deleteConfig(workspaceId);
			if (!deleted) {
				sendJson(res, 404, { error: "Workspace config not found." }, cors, req);
				return;
			}
			sendJson(res, 200, { deleted: true, workspaceId }, cors, req);
			return;
		}

		sendJson(res, 405, { error: "Method not allowed" }, cors, req);
	} catch (error) {
		if (error instanceof WorkspaceConfigValidationError) {
			sendJson(res, 400, { error: error.message }, cors, req);
			return;
		}
		if (error instanceof WorkspaceConfigUnavailableError) {
			sendJson(res, 503, { error: error.message }, cors, req);
			return;
		}
		respondWithApiError(res, error, 500, cors, req);
	}
}
