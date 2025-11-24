import type { Route } from "./router.js";
import { handleChat } from "./handlers/chat.js";
import { handleConfig } from "./handlers/config.js";
import { handleModel, handleModels } from "./handlers/models.js";
import { handleSessions } from "./handlers/sessions.js";
import { handleStatus } from "./handlers/status.js";
import { handleUsage } from "./handlers/usage.js";
import type { WebServerContext } from "./app-context.js";

export function createRoutes(context: WebServerContext): Route[] {
	const { corsHeaders } = context;

	return [
		{
			method: "GET",
			path: "/api/models",
			handler: (_req, res) => handleModels(res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/status",
			handler: (_req, res) =>
				handleStatus(res, corsHeaders, {
					staticCacheMaxAge: context.staticMaxAge,
				}),
		},
		{
			method: "GET",
			path: "/api/config",
			handler: (req, res) => handleConfig(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/config",
			handler: (req, res) => handleConfig(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/usage",
			handler: (req, res) => handleUsage(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/model",
			handler: async (req, res) =>
				handleModel(
					req,
					res,
					corsHeaders,
					{ ...context.getCurrentSelection() },
					context.ensureCredential,
					context.setModelSelection,
				),
		},
		{
			method: "POST",
			path: "/api/model",
			handler: async (req, res) =>
				handleModel(
					req,
					res,
					corsHeaders,
					{ ...context.getCurrentSelection() },
					context.ensureCredential,
					context.setModelSelection,
				),
		},
		{
			method: "POST",
			path: "/api/chat",
			handler: async (req, res) => {
				return handleChat(req, res, corsHeaders, {
					createAgent: context.createAgent,
					getRegisteredModel: context.getRegisteredModel,
					defaultApprovalMode: context.defaultApprovalMode,
					defaultProvider: context.defaultProvider,
					defaultModelId: context.defaultModelId,
					acquireSse: context.acquireSse,
					releaseSse: context.releaseSse,
				});
			},
		},
		{
			method: "GET",
			path: "/api/sessions",
			handler: (req, res) => handleSessions(req, res, {}, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/sessions",
			handler: (req, res) => handleSessions(req, res, {}, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/sessions/:id",
			handler: (req, res, params) =>
				handleSessions(req, res, params, corsHeaders),
		},
		{
			method: "DELETE",
			path: "/api/sessions/:id",
			handler: (req, res, params) =>
				handleSessions(req, res, params, corsHeaders),
		},
	];
}

