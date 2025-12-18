import type { ApprovalMode } from "../agent/action-approval.js";
import type { ThinkingLevel } from "../agent/types.js";
import { createEnterpriseRoutes } from "../api/enterprise-routes.js";
import { isDatabaseConfigured } from "../db/client.js";
import type { WebServerContext } from "./app-context.js";
import { handleAdminCleanup, handleAdminWarmCaches } from "./handlers/admin.js";
import { handleApproval } from "./handlers/approval.js";
import { handleApprovals } from "./handlers/approvals.js";
import { handleAttachmentExtract } from "./handlers/attachments.js";
import { handleBackground } from "./handlers/background.js";
import { handleBranch } from "./handlers/branch.js";
import { handleChat } from "./handlers/chat.js";
import { handleClientToolResult } from "./handlers/client-tools.js";
import { handleCommandPrefs } from "./handlers/command-prefs.js";
import { handleCommands } from "./handlers/commands.js";
import { handleComposer } from "./handlers/composer.js";
import { handleConfig } from "./handlers/config.js";
import { handleContext } from "./handlers/context.js";
import { handleCost } from "./handlers/cost.js";
import { handleDiagnostics } from "./handlers/diagnostics.js";
import { handleFiles } from "./handlers/files.js";
import { handleFramework } from "./handlers/framework.js";
import {
	handleGuardianConfig,
	handleGuardianRun,
	handleGuardianStatus,
} from "./handlers/guardian.js";
import { handleReadyz } from "./handlers/health.js";
import { handleLsp } from "./handlers/lsp.js";
import { handleMcpStatus } from "./handlers/mcp.js";
import { handleMemory } from "./handlers/memory.js";
import { handleMode } from "./handlers/mode.js";
import { handleModel, handleModels } from "./handlers/models.js";
import { handleOllama } from "./handlers/ollama.js";
import { handlePlan } from "./handlers/plan.js";
import { handlePolicyValidate } from "./handlers/policy.js";
import { handlePreview } from "./handlers/preview.js";
import { handleQueue } from "./handlers/queue.js";
import { handleQuota } from "./handlers/quota.js";
import { handleReview } from "./handlers/review.js";
import { handleRun } from "./handlers/run.js";
import {
	handleSessionArtifactFile,
	handleSessionArtifactViewer,
	handleSessionArtifactsEvents,
	handleSessionArtifactsIndex,
	handleSessionArtifactsZip,
} from "./handlers/session-artifacts.js";
import {
	handleSessionAttachment,
	handleSessionAttachmentExtract,
} from "./handlers/session-attachments.js";
import {
	handleSessionExport,
	handleSessionShare,
	handleSessions,
	handleSharedSession,
	handleSharedSessionAttachment,
} from "./handlers/sessions.js";
import { handleStats } from "./handlers/stats.js";
import { handleStatus } from "./handlers/status.js";
import { handleTelemetry } from "./handlers/telemetry.js";
import { handleTools } from "./handlers/tools.js";
import { handleTraining } from "./handlers/training.js";
import { handleUI } from "./handlers/ui.js";
import { handleChanges } from "./handlers/undo.js";
import { handleUndo } from "./handlers/undo.js";
import { handleUsage } from "./handlers/usage.js";
import { handleWorkflow } from "./handlers/workflow.js";
import { handleZen } from "./handlers/zen.js";
import { getPrometheusMetrics } from "./logger.js";
import { requestTracker } from "./request-tracker.js";
import type { Route } from "./router.js";
import { sendJson } from "./server-utils.js";

export function createRoutes(context: WebServerContext): Route[] {
	const { corsHeaders } = context;

	return [
		{
			method: "GET",
			path: "/healthz",
			handler: (_req, res) => {
				// Simple liveness check
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("ok");
			},
		},
		{
			method: "GET",
			path: "/readyz",
			handler: (req, res) => handleReadyz(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/debug/z",
			handler: (_req, res) => {
				// Statusz: Deep introspection for debugging (Borg style)
				// Intentionally requires internal access or auth in real prod, open here for local
				const activeRequests = requestTracker.getSnapshot().map((req) => ({
					...req,
					durationMs: performance.now() - req.startTime,
				}));

				const longRunning = requestTracker.getLongRunning(5000).map((req) => ({
					...req,
					durationMs: performance.now() - req.startTime,
				}));

				sendJson(
					res,
					200,
					{
						activeRequests,
						longRunning,
						totalActive: activeRequests.length,
						totalLongRunning: longRunning.length,
					},
					corsHeaders,
					_req, // Pass request for potential compression access
				);
			},
		},
		{
			method: "GET",
			path: "/api/files",
			handler: (req, res) => handleFiles(req, res, context),
		},
		{
			method: "GET",
			path: "/api/commands",
			handler: (req, res) => handleCommands(req, res, context),
		},
		{
			method: "GET",
			path: "/api/command-prefs",
			handler: (req, res) => handleCommandPrefs(req, res, context),
		},
		{
			method: "POST",
			path: "/api/command-prefs",
			handler: (req, res) => handleCommandPrefs(req, res, context),
		},
		{
			method: "GET",
			path: "/api/models",
			handler: (req, res) => handleModels(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/status",
			handler: (req, res) =>
				handleStatus(req, res, corsHeaders, {
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
			path: "/api/guardian/status",
			handler: (req, res) => handleGuardianStatus(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/guardian/run",
			handler: (req, res) => handleGuardianRun(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/guardian/config",
			handler: (req, res) => handleGuardianConfig(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/plan",
			handler: (req, res) => handlePlan(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/plan",
			handler: (req, res) => handlePlan(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/mcp",
			handler: (req, res) => handleMcpStatus(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/usage",
			handler: (req, res) => handleUsage(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/background",
			handler: (req, res) => handleBackground(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/background",
			handler: (req, res) => handleBackground(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/undo",
			handler: (req, res) => handleUndo(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/undo",
			handler: (req, res) => handleUndo(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/changes",
			handler: (req, res) => handleChanges(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/approvals",
			handler: (req, res) => handleApprovals(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/approvals",
			handler: (req, res) => handleApprovals(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/framework",
			handler: (req, res) => handleFramework(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/framework",
			handler: (req, res) => handleFramework(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/tools",
			handler: (req, res) => handleTools(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/review",
			handler: (req, res) => handleReview(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/context",
			handler: (req, res) => handleContext(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/stats",
			handler: (req, res) => handleStats(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/telemetry",
			handler: (req, res) => handleTelemetry(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/telemetry",
			handler: (req, res) => handleTelemetry(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/training",
			handler: (req, res) => handleTraining(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/training",
			handler: (req, res) => handleTraining(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/diagnostics",
			handler: (req, res) => handleDiagnostics(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/lsp",
			handler: (req, res) => handleLsp(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/lsp",
			handler: (req, res) => handleLsp(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/workflow",
			handler: (req, res) => handleWorkflow(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/workflow",
			handler: (req, res) => handleWorkflow(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/run",
			handler: (req, res) => handleRun(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/run",
			handler: (req, res) => handleRun(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/ollama",
			handler: (req, res) => handleOllama(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/ollama",
			handler: (req, res) => handleOllama(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/preview",
			handler: (req, res) => handlePreview(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/composer",
			handler: (req, res) => handleComposer(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/composer",
			handler: (req, res) => handleComposer(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/cost",
			handler: (req, res) => handleCost(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/cost",
			handler: (req, res) => handleCost(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/quota",
			handler: (req, res) => handleQuota(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/quota",
			handler: (req, res) => handleQuota(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/memory",
			handler: (req, res) => handleMemory(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/memory",
			handler: (req, res) => handleMemory(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/mode",
			handler: (req, res) => handleMode(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/mode",
			handler: (req, res) => handleMode(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/zen",
			handler: (req, res) => handleZen(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/zen",
			handler: (req, res) => handleZen(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/ui",
			handler: (req, res) => handleUI(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/ui",
			handler: (req, res) => handleUI(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/queue",
			handler: (req, res) => handleQueue(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/queue",
			handler: (req, res) => handleQueue(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/branch",
			handler: (req, res) => handleBranch(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/branch",
			handler: (req, res) => handleBranch(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/model",
			handler: async (req, res) => handleModel(req, res, context),
		},
		{
			method: "POST",
			path: "/api/model",
			handler: async (req, res) => handleModel(req, res, context),
		},
		{
			method: "GET",
			path: "/api/metrics",
			handler: async (_req, res) => {
				// Expose Prometheus compatible metrics
				const metrics = await getPrometheusMetrics();
				res.writeHead(200, {
					"Content-Type": "text/plain; version=0.0.4",
					...corsHeaders,
				});
				res.end(metrics);
			},
		},
		{
			method: "POST",
			path: "/api/chat",
			handler: async (req, res) => handleChat(req, res, context),
		},
		{
			method: "POST",
			path: "/api/chat/approval",
			handler: (req, res) => handleApproval(req, res, context),
		},
		{
			method: "POST",
			path: "/api/chat/client-tool-result",
			handler: (req, res) => handleClientToolResult(req, res, context),
		},
		{
			method: "POST",
			path: "/api/attachments/extract",
			handler: (req, res) => handleAttachmentExtract(req, res, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/sessions/:id/artifacts",
			handler: (req, res, params) =>
				handleSessionArtifactsIndex(
					req,
					res,
					params as { id: string },
					corsHeaders,
				),
		},
		{
			method: "GET",
			path: "/api/sessions/:id/artifacts.zip",
			handler: (req, res, params) =>
				handleSessionArtifactsZip(
					req,
					res,
					params as { id: string },
					corsHeaders,
				),
		},
		{
			method: "GET",
			path: "/api/sessions/:id/artifacts/events",
			handler: (req, res, params) =>
				handleSessionArtifactsEvents(
					req,
					res,
					params as { id: string },
					corsHeaders,
				),
		},
		{
			method: "GET",
			path: "/api/sessions/:id/artifacts/:filename",
			handler: (req, res, params) =>
				handleSessionArtifactFile(
					req,
					res,
					params as { id: string; filename: string },
					corsHeaders,
				),
		},
		{
			method: "GET",
			path: "/api/sessions/:id/artifacts/:filename/view",
			handler: (req, res, params) =>
				handleSessionArtifactViewer(
					req,
					res,
					params as { id: string; filename: string },
					corsHeaders,
				),
		},
		{
			method: "GET",
			path: "/api/sessions/:id/attachments/:attachmentId",
			handler: (req, res, params) =>
				handleSessionAttachment(
					req,
					res,
					params as { id: string; attachmentId: string },
					corsHeaders,
				),
		},
		{
			method: "POST",
			path: "/api/sessions/:id/attachments/:attachmentId/extract",
			handler: (req, res, params) =>
				handleSessionAttachmentExtract(
					req,
					res,
					params as { id: string; attachmentId: string },
					corsHeaders,
				),
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
			method: "PATCH",
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
		{
			method: "POST",
			path: "/api/sessions/:id/share",
			handler: (req, res, params) =>
				handleSessionShare(req, res, params as { id: string }, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/sessions/:id/export",
			handler: (req, res, params) =>
				handleSessionExport(req, res, params as { id: string }, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/sessions/shared/:token",
			handler: (req, res, params) =>
				handleSharedSession(req, res, params as { token: string }, corsHeaders),
		},
		{
			method: "GET",
			path: "/api/sessions/shared/:token/attachments/:attachmentId",
			handler: (req, res, params) =>
				handleSharedSessionAttachment(
					req,
					res,
					params as { token: string; attachmentId: string },
					corsHeaders,
				),
		},
		{
			method: "POST",
			path: "/api/policy/validate",
			handler: (req, res) => handlePolicyValidate(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/admin/cleanup",
			handler: (req, res) => handleAdminCleanup(req, res, corsHeaders),
		},
		{
			method: "POST",
			path: "/api/admin/warm-caches",
			handler: (req, res) => handleAdminWarmCaches(req, res, corsHeaders),
		},
		// Add enterprise routes when database is configured
		...(isDatabaseConfigured() ? createEnterpriseRoutes(corsHeaders) : []),
	];
}
