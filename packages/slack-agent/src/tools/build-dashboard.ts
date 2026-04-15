/**
 * Build Dashboard Tool - Generate and deploy spec-driven dashboards.
 *
 * The agent provides structured JSON (title + components with data)
 * and this tool generates a polished HTML dashboard, writes it to the
 * sandbox, and optionally auto-deploys it (returning a shareable URL).
 */

import { generateDashboardHtml } from "../dashboard/renderer.js";
import type { DashboardSpec } from "../dashboard/types.js";
import { DashboardSpecSchema } from "../dashboard/types.js";
import type { Executor } from "../sandbox.js";
import { shellEscape } from "../utils/shell-escape.js";
import type { AgentTool, DeployDetails } from "./index.js";

export function createBuildDashboardTool(
	executor: Executor,
	onDeploy?: (label: string, details: DeployDetails) => void,
): AgentTool {
	return {
		name: "build_dashboard",
		label: "build_dashboard",
		description: `Generate a polished, self-contained dashboard from a JSON spec and optionally deploy it.

You provide structured data (title + components), and the tool renders a complete HTML dashboard with charts, metrics, tables, and feeds — then deploys it and returns a shareable URL.

COMPONENT TYPES AND DATA SHAPES:

1. stat-group — Row of KPI metric cards
   { "type": "stat-group", "items": [
     { "label": "Revenue", "value": "$48.2k", "change": "+12.5%", "trend": "up" }
   ]}

2. bar-chart — Bar chart (supports stacked)
   { "type": "bar-chart", "labels": ["Jan","Feb","Mar"],
     "datasets": [{ "label": "Sales", "data": [10, 20, 30] }], "stacked": false }

3. line-chart — Line chart
   { "type": "line-chart", "labels": ["Jan","Feb","Mar"],
     "datasets": [{ "label": "MRR", "data": [42000, 45000, 48200] }] }

4. area-chart — Area chart (line with fill)
   { "type": "area-chart", "labels": ["Jan","Feb","Mar"],
     "datasets": [{ "label": "Users", "data": [100, 150, 220] }] }

5. pie-chart — Pie chart
   { "type": "pie-chart", "labels": ["Pro","Team","Enterprise"],
     "data": [45, 30, 25] }

6. doughnut-chart — Doughnut chart
   { "type": "doughnut-chart", "labels": ["Active","Churned","Trial"],
     "data": [70, 15, 15] }

7. table — Data table with columns and rows
   { "type": "table",
     "columns": [{ "key": "name", "label": "Name" }, { "key": "value", "label": "Value", "align": "right" }],
     "rows": [{ "name": "Acme Corp", "value": "$24,000" }] }

8. activity-feed — Event timeline
   { "type": "activity-feed", "items": [
     { "text": "New deal closed: Acme Corp", "time": "2 min ago", "color": "#22c55e" }
   ]}

TIPS:
- Default auto-deploys and returns a URL. Set auto_deploy=false to just write files.
- Supports dark (default) and light themes.
- Combine multiple components for rich dashboards.`,
		parameters: DashboardSpecSchema,
		execute: async (_toolCallId, args) => {
			const label = String(args.label ?? "Dashboard");
			const title = String(args.title ?? "Dashboard");
			const subtitle = args.subtitle ? String(args.subtitle) : undefined;
			const theme =
				args.theme === "light" ? ("light" as const) : ("dark" as const);
			const autoDeploy = args.auto_deploy !== false;
			const port = Number(args.port ?? 8080);
			const expiresIn = Number(args.expiresIn ?? 3600);
			const components = (args.components as DashboardSpec["components"]) ?? [];

			if (
				autoDeploy &&
				(!/^\d+$/.test(String(port)) || port < 1 || port > 65535)
			) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: port must be a number between 1 and 65535.",
						},
					],
				};
			}

			const spec: DashboardSpec = {
				title,
				subtitle,
				theme,
				generatedAt: new Date().toISOString(),
				components,
			};

			const html = generateDashboardHtml(spec);
			const specJson = JSON.stringify(spec, null, 2);

			// Write files to sandbox
			const timestamp = Date.now();
			const dashDir = `/workspace/dashboards/dash-${timestamp}`;
			const safeDashDir = shellEscape(dashDir);

			const mkdirResult = await executor.exec(`mkdir -p ${safeDashDir}`);
			if (mkdirResult.code !== 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: Failed to create dashboard directory: ${mkdirResult.stderr}`,
						},
					],
				};
			}

			// Write index.html
			await executor.exec(
				`printf '%s' ${shellEscape(html)} > ${safeDashDir}/index.html`,
			);

			// Write dashboard.json for debugging
			await executor.exec(
				`printf '%s' ${shellEscape(specJson)} > ${safeDashDir}/dashboard.json`,
			);

			if (!autoDeploy) {
				return {
					content: [
						{
							type: "text" as const,
							text: [
								`Dashboard files written to ${dashDir}/`,
								"Files: index.html, dashboard.json",
								`Use the deploy tool to serve: deploy directory="${dashDir}"`,
							].join("\n"),
						},
					],
					details: { directory: dashDir },
				};
			}

			// ── Auto-deploy (inlined deploy pattern) ─────────────

			const safePort = String(port);

			// Kill any existing process on the port
			await executor.exec(
				`lsof -ti :${safePort} 2>/dev/null | xargs kill -9 2>/dev/null; echo done`,
			);

			// Start server
			const serverScript = `cd ${safeDashDir} && nohup python3 -m http.server ${safePort} > /tmp/deploy-server.log 2>&1 & echo $!`;
			const startResult = await executor.exec(serverScript);
			const pid = startResult.stdout.trim();

			if (startResult.code !== 0 || !pid) {
				const fallback = `cd ${safeDashDir} && nohup npx -y serve -l ${safePort} -s > /tmp/deploy-server.log 2>&1 & echo $!`;
				const fallbackResult = await executor.exec(fallback);
				if (fallbackResult.code !== 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Dashboard written to ${dashDir}/ but failed to start server: ${fallbackResult.stderr || startResult.stderr}`,
							},
						],
					};
				}
			}

			await executor.exec("sleep 1");

			// Get preview URL if available
			if (executor.getPreviewUrl) {
				try {
					const preview = await executor.getPreviewUrl(port, expiresIn);
					if (preview) {
						const details: DeployDetails = {
							url: preview.url,
							port,
							directory: dashDir,
							expiresIn,
							spec,
						};
						try {
							onDeploy?.(label, details);
						} catch {
							// non-fatal
						}
						return {
							content: [
								{
									type: "text" as const,
									text: [
										"Dashboard deployed successfully!",
										`URL: ${preview.url}`,
										`Expires in: ${Math.round(expiresIn / 60)} minutes`,
										`Directory: ${dashDir}`,
									].join("\n"),
								},
							],
							details,
						};
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text" as const,
								text: `Dashboard written and server started on port ${port} but failed to get preview URL: ${msg}`,
							},
						],
					};
				}
			}

			const fallbackDetails: DeployDetails = {
				url: `http://localhost:${port}`,
				port,
				directory: dashDir,
				spec,
			};
			try {
				onDeploy?.(label, fallbackDetails);
			} catch {
				// non-fatal
			}
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Dashboard deployed on port ${port}`,
							`Directory: ${dashDir}`,
							"Note: No public URL available (not using Daytona sandbox).",
							`Local access: http://localhost:${port}`,
						].join("\n"),
					},
				],
				details: fallbackDetails,
			};
		},
	};
}
