import type { IncomingMessage, ServerResponse } from "node:http";
import { composerManager, loadComposers } from "../../composers/index.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleComposer(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/composer",
			`http://${req.headers.host || "localhost"}`,
		);
		const name = url.searchParams.get("name");

		try {
			const composers = loadComposers(process.cwd());
			const state = composerManager.getState();

			if (name) {
				const composer = composers.find((c) => c.name === name);
				if (!composer) {
					sendJson(
						res,
						404,
						{ error: `Composer not found: ${name}` },
						corsHeaders,
					);
					return;
				}
				sendJson(
					res,
					200,
					{
						composer,
						active: state.active?.name === name,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					200,
					{
						composers,
						active: state.active,
					},
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{ action: string; name?: string }>(req);
			const { action, name } = data;

			if (action === "activate" && name) {
				const success = composerManager.activate(name, process.cwd());
				if (success) {
					const newState = composerManager.getState();
					sendJson(
						res,
						200,
						{
							success: true,
							message: `Activated composer: ${name}`,
							active: newState.active,
						},
						corsHeaders,
					);
				} else {
					sendJson(
						res,
						400,
						{ error: `Failed to activate composer '${name}'` },
						corsHeaders,
					);
				}
			} else if (action === "deactivate") {
				const wasActive = composerManager.getState().active;
				composerManager.deactivate();
				sendJson(
					res,
					200,
					{
						success: true,
						message: wasActive
							? `Deactivated composer: ${wasActive.name}`
							: "No composer was active",
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use activate or deactivate." },
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
