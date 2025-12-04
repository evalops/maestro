import type { IncomingMessage, ServerResponse } from "node:http";
import {
	getDefaultFramework,
	getFrameworkInfo,
	listFrameworks,
	resolveFrameworkPreference,
	setDefaultFramework,
	setWorkspaceFramework,
} from "../../config/framework.js";
import { readJsonBody, sendJson } from "../server-utils.js";

export async function handleFramework(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/framework",
			`http://${req.headers.host}`,
		);
		const action = url.searchParams.get("action") || "status";
		const scope = url.searchParams.get("scope") || "user"; // user or workspace

		if (action === "status") {
			const pref = resolveFrameworkPreference();
			sendJson(
				res,
				200,
				{
					framework: pref.id ?? "none",
					source: pref.source,
					locked: pref.locked,
					scope: scope === "workspace" ? "workspace" : "user",
				},
				corsHeaders,
			);
			return;
		}

		if (action === "list") {
			const frameworks = listFrameworks();
			sendJson(
				res,
				200,
				{
					frameworks: frameworks.map((f) => ({
						id: f.id,
						summary: f.summary,
					})),
				},
				corsHeaders,
			);
			return;
		}

		sendJson(res, 400, { error: "Invalid action" }, corsHeaders);
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{
				framework?: string | null;
				scope?: "user" | "workspace";
			}>(req);

			const framework = data.framework;
			const scope = data.scope || "user";
			const setter =
				scope === "workspace" ? setWorkspaceFramework : setDefaultFramework;

			if (framework === null || framework === "none" || framework === "off") {
				setter(null);
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Default framework cleared for ${scope} scope`,
						framework: null,
					},
					corsHeaders,
				);
				return;
			}

			if (!framework) {
				sendJson(res, 400, { error: "framework is required" }, corsHeaders);
				return;
			}

			const info = getFrameworkInfo(framework);
			if (!info) {
				const frameworks = listFrameworks();
				const available = frameworks.map((f) => f.id).join(", ");
				sendJson(
					res,
					400,
					{
						error: `Unknown framework "${framework}". Available options: ${available}`,
					},
					corsHeaders,
				);
				return;
			}

			setter(framework);
			sendJson(
				res,
				200,
				{
					success: true,
					framework: info.id,
					summary: info.summary,
					scope,
					message: `${info.summary} (scope: ${scope})`,
				},
				corsHeaders,
			);
		} catch (error) {
			if (error instanceof Error && "statusCode" in error) {
				sendJson(
					res,
					(error as { statusCode: number }).statusCode,
					{ error: error.message },
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					500,
					{
						error: "Failed to update framework preference",
						details: error instanceof Error ? error.message : String(error),
					},
					corsHeaders,
				);
			}
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
