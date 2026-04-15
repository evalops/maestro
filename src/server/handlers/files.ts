import type { IncomingMessage, ServerResponse } from "node:http";
import { getWorkspaceFiles } from "../../utils/workspace-files.js";
import type { WebServerContext } from "../app-context.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

export async function handleFiles(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	const { corsHeaders } = context;

	try {
		if (req.method === "GET") {
			// Limit to 100 files for autocomplete performance, search query can refine later if needed
			// But for now, we just return the full list and let client filter?
			// getWorkspaceFiles returns up to 2000 files by default which is fine for client-side filtering
			const files = getWorkspaceFiles();
			sendJson(res, 200, { files }, corsHeaders, req);
		} else {
			res.writeHead(405, corsHeaders);
			res.end();
		}
	} catch (error) {
		respondWithApiError(res, error, 500, corsHeaders, req);
	}
}
