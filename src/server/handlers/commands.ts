import type { IncomingMessage, ServerResponse } from "node:http";
import { loadCommandCatalog } from "../../commands/catalog.js";
import type { WebServerContext } from "../app-context.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

export async function handleCommands(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	const { corsHeaders } = context;

	try {
		if (req.method === "GET") {
			// Assume server cwd is the workspace root for now
			// In the future, we might want to support multiple workspaces or pass it in params
			const workspaceDir = process.cwd();
			const commands = loadCommandCatalog(workspaceDir);

			// Filter sensitive paths from source
			const safeCommands = commands.map((cmd) => ({
				...cmd,
				source: undefined, // Hide absolute path
			}));

			sendJson(res, 200, { commands: safeCommands }, corsHeaders, req);
		} else {
			res.writeHead(405, corsHeaders);
			res.end();
		}
	} catch (error) {
		respondWithApiError(res, error, 500, corsHeaders, req);
	}
}
