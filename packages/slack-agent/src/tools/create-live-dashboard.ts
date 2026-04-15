/**
 * Create Live Dashboard Tool
 *
 * Persists a workspace-scoped "live" dashboard definition (prompt + metadata)
 * in dashboards.json. The React control plane renders the dashboard by calling
 * the UI API server, which generates a spec from real connector data and caches
 * results on a refresh interval (default 5 minutes).
 */

import { Type } from "@sinclair/typebox";
import type { DashboardRegistry } from "../ui/dashboard-registry.js";
import type { AgentTool } from "./index.js";

export interface CreateLiveDashboardToolOptions {
	teamId: string;
	dashboardRegistry: DashboardRegistry;
	createdBy?: string;
	/**
	 * Public base URL for the control plane (e.g. https://agent.example.com).
	 * If unset, the tool returns a path-only link.
	 */
	uiBaseUrl?: string;
	/** Default refresh interval (ms). If omitted, backend defaults apply. */
	defaultRefreshIntervalMs?: number;
}

function normalizeBaseUrl(raw: string | undefined): string | null {
	const base = (raw ?? "").trim();
	if (!base) return null;
	return base.endsWith("/") ? base.slice(0, -1) : base;
}

export function createLiveDashboardTool(
	opts: CreateLiveDashboardToolOptions,
): AgentTool {
	return {
		name: "create_live_dashboard",
		label: "create_live_dashboard",
		description:
			"Create a persistent, workspace-scoped live BI dashboard in the Slack Agent control plane. " +
			"Use this when a user asks for dashboards. The dashboard is read-only (queries only) and auto-refreshes (default: 5 minutes). " +
			"Return value includes a link to the dashboard page.",
		parameters: Type.Object({
			label: Type.Optional(
				Type.String({
					description:
						"Short label shown in the dashboards list (default: uses title or 'Dashboard')",
				}),
			),
			prompt: Type.String({
				description:
					"Natural-language instructions describing what the dashboard should show, including metrics, time range, and segmentation. Be specific.",
			}),
			title: Type.Optional(
				Type.String({ description: "Dashboard title (optional)" }),
			),
			subtitle: Type.Optional(
				Type.String({ description: "Dashboard subtitle (optional)" }),
			),
			theme: Type.Optional(
				Type.Union([Type.Literal("dark"), Type.Literal("light")], {
					description: "Theme (default: dark)",
					default: "dark",
				}),
			),
			refreshIntervalMs: Type.Optional(
				Type.Number({
					description:
						"Refresh interval in milliseconds (default: 5 minutes). The server caches renders within this window.",
				}),
			),
		}),
		execute: async (_toolCallId, args) => {
			const prompt = String(args.prompt ?? "").trim();
			if (!prompt) {
				return {
					content: [
						{ type: "text" as const, text: "Error: prompt is required." },
					],
				};
			}

			const title = args.title ? String(args.title).trim() : "";
			const label = String(args.label ?? "").trim() || title || "Dashboard";
			const subtitle = args.subtitle ? String(args.subtitle).trim() : undefined;
			const theme =
				args.theme === "light" ? ("light" as const) : ("dark" as const);

			const refreshIntervalMsRaw =
				args.refreshIntervalMs != null
					? Number(args.refreshIntervalMs)
					: undefined;
			const refreshIntervalMs =
				Number.isFinite(refreshIntervalMsRaw) && (refreshIntervalMsRaw ?? 0) > 0
					? refreshIntervalMsRaw
					: opts.defaultRefreshIntervalMs;

			const entry = opts.dashboardRegistry.createDefinition({
				label,
				prompt,
				title: title || label,
				subtitle,
				theme,
				refreshIntervalMs,
				createdBy: opts.createdBy,
			});

			const refreshDisplayMs = refreshIntervalMs ?? 5 * 60 * 1000;
			const refreshMinutes = Math.max(1, Math.round(refreshDisplayMs / 60000));

			const path = `/${encodeURIComponent(opts.teamId)}/dashboards/${encodeURIComponent(entry.id)}`;
			const base = normalizeBaseUrl(opts.uiBaseUrl);
			const url = base ? `${base}${path}` : null;

			const lines = [
				`Created live dashboard *${label}* for workspace \`${opts.teamId}\`.`,
				url ? `Open: <${url}|${label}>` : `Path: ${path}`,
				"Visibility: private (power users can share from the control plane).",
				`Auto-refresh: ${refreshMinutes} minute${refreshMinutes === 1 ? "" : "s"} (read-only queries).`,
				url
					? ""
					: "Tip: set SLACK_AGENT_UI_PUBLIC_URL to get a clickable link.",
			].filter(Boolean);

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					teamId: opts.teamId,
					dashboardId: entry.id,
					path,
					url: url ?? path,
				},
			};
		},
	};
}
