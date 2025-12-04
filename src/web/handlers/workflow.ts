import type { IncomingMessage, ServerResponse } from "node:http";
import { toolRegistry } from "../../tools/index.js";
import {
	executeWorkflow,
	getWorkflow,
	hasWorkflowsDirectory,
	listWorkflowNames,
	validateWorkflow,
} from "../../workflows/index.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

export async function handleWorkflow(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/workflow",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "list";
		const name = url.searchParams.get("name");

		try {
			if (action === "list") {
				if (!hasWorkflowsDirectory(process.cwd())) {
					sendJson(
						res,
						200,
						{
							workflows: [],
							message: "No workflows directory found",
						},
						corsHeaders,
					);
					return;
				}
				const names = listWorkflowNames(process.cwd());
				sendJson(res, 200, { workflows: names }, corsHeaders);
			} else if (action === "show" && name) {
				const workflow = getWorkflow(process.cwd(), name);
				if (!workflow) {
					sendJson(
						res,
						404,
						{ error: `Workflow not found: ${name}` },
						corsHeaders,
					);
					return;
				}
				sendJson(res, 200, { workflow }, corsHeaders);
			} else if (action === "validate" && name) {
				const workflow = getWorkflow(process.cwd(), name);
				if (!workflow) {
					sendJson(
						res,
						404,
						{ error: `Workflow not found: ${name}` },
						corsHeaders,
					);
					return;
				}
				const validation = validateWorkflow(
					workflow,
					new Set(Object.keys(toolRegistry)),
				);
				sendJson(res, 200, { validation }, corsHeaders);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use list, show, or validate." },
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

			if (action === "run" && name) {
				const workflow = getWorkflow(process.cwd(), name);
				if (!workflow) {
					sendJson(
						res,
						404,
						{ error: `Workflow not found: ${name}` },
						corsHeaders,
					);
					return;
				}

				// Validate first
				const validation = validateWorkflow(
					workflow,
					new Set(Object.keys(toolRegistry)),
				);
				if (!validation.valid) {
					sendJson(
						res,
						400,
						{
							error: "Workflow validation failed",
							errors: validation.errors,
						},
						corsHeaders,
					);
					return;
				}

				// Convert toolRegistry Record to Map for executeWorkflow
				const toolsMap = new Map(Object.entries(toolRegistry));

				// Execute workflow (simplified - in production would stream progress)
				const result = await executeWorkflow(workflow, toolsMap, {});
				sendJson(res, 200, { result }, corsHeaders);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use run with name parameter." },
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
