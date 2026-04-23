import type { IncomingMessage } from "node:http";
import type { Middleware } from "../../server/middleware.js";
import { setWorkspaceConfigContext } from "../../server/request-context.js";
import { sendJson } from "../../server/server-utils.js";
import { createLogger } from "../../utils/logger.js";
import { WorkspaceConfigValidationError } from "./normalize.js";
import {
	WorkspaceConfigUnavailableError,
	getWorkspaceConfigService,
} from "./service.js";
import type { WorkspaceConfig } from "./types.js";

const logger = createLogger("workspace-config:middleware");

function firstHeader(
	req: IncomingMessage,
	names: string[],
): string | undefined {
	for (const name of names) {
		const raw = req.headers[name.toLowerCase()];
		const value = Array.isArray(raw) ? raw[0] : raw;
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function safeUrl(req: IncomingMessage): URL {
	return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function workspaceIdFromWorkspaceConfigRoute(
	pathname: string,
): string | undefined {
	const match = pathname.match(/^\/api\/workspace-configs\/([^/]+)$/);
	if (!match?.[1]) return undefined;
	const decoded = decodeURIComponent(match[1]).trim();
	return decoded ? decoded : undefined;
}

function firstSearchParam(url: URL, names: string[]): string | undefined {
	for (const name of names) {
		const value = url.searchParams.get(name)?.trim();
		if (value) return value;
	}
	return undefined;
}

export function resolveWorkspaceConfigId(req: IncomingMessage): string {
	const url = safeUrl(req);
	return (
		firstHeader(req, [
			"x-maestro-workspace-id",
			"x-composer-workspace-id",
			"x-maestro-workspace",
			"x-composer-workspace",
		]) ??
		firstSearchParam(url, ["workspace_id", "workspaceId"]) ??
		workspaceIdFromWorkspaceConfigRoute(url.pathname) ??
		process.cwd()
	);
}

export function createWorkspaceConfigMiddleware(
	corsHeaders: Record<string, string>,
): Middleware {
	return async (req, res, next) => {
		const url = safeUrl(req);
		if (!url.pathname.startsWith("/api")) {
			await next();
			return;
		}

		const workspaceId = resolveWorkspaceConfigId(req);
		const service = getWorkspaceConfigService();
		if (!service.isConfigured()) {
			setWorkspaceConfigContext({
				workspaceId,
				config: null,
				source: "unconfigured",
			});
			await next();
			return;
		}

		let config: WorkspaceConfig | null;
		try {
			config = await service.getConfig(workspaceId);
		} catch (error) {
			if (error instanceof WorkspaceConfigUnavailableError) {
				setWorkspaceConfigContext({
					workspaceId,
					config: null,
					source: "unconfigured",
				});
				await next();
				return;
			}
			if (error instanceof WorkspaceConfigValidationError) {
				sendJson(res, 400, { error: error.message }, corsHeaders, req);
				return;
			}
			logger.warn("Failed to load workspace config", {
				error: error instanceof Error ? error.message : String(error),
				workspaceId,
			});
			sendJson(
				res,
				503,
				{ error: "Workspace config could not be loaded." },
				corsHeaders,
				req,
			);
			return;
		}

		setWorkspaceConfigContext({
			workspaceId,
			config,
			source: config ? "database" : "missing",
		});
		await next();
	};
}
