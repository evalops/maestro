/**
 * Deploy Tool - Deploys mini-apps and dashboards from the Slack agent sandbox.
 *
 * When using a Daytona sandbox, this tool:
 * 1. Writes the generated files to the sandbox
 * 2. Starts a static file server on a random port
 * 3. Gets a public signed preview URL via Daytona
 * 4. Returns the URL for sharing in Slack
 *
 * For Docker/host sandboxes, it writes files and starts a server but
 * cannot provide a public URL (returns localhost).
 */

import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import type { AgentTool, DeployDetails } from "./index.js";

/** Shell-escape a value for safe interpolation into shell commands. */
function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createDeployTool(
	executor: Executor,
	onDeploy?: (label: string, details: DeployDetails) => void,
): AgentTool {
	return {
		name: "deploy",
		label: "deploy",
		description:
			"Deploy a mini-app or dashboard from the sandbox and return a public URL. " +
			"Write your HTML/JS/CSS files to a directory, then call this tool to serve them. " +
			"Best for data visualizations, reports, dashboards, and interactive tools.",
		parameters: Type.Object({
			label: Type.String({
				description:
					"Brief description shown to user (e.g., 'Deploy sales dashboard')",
			}),
			directory: Type.String({
				description:
					"Path in the sandbox containing the app files (must include index.html)",
			}),
			port: Type.Optional(
				Type.Number({
					description: "Port to serve on (default: 8080)",
					default: 8080,
				}),
			),
			expiresIn: Type.Optional(
				Type.Number({
					description: "Preview URL expiry in seconds (default: 3600 = 1 hour)",
					default: 3600,
				}),
			),
		}),
		execute: async (_toolCallId, args) => {
			const directory = String(args.directory);
			const port = Number(args.port ?? 8080);
			const expiresIn = Number(args.expiresIn ?? 3600);

			if (!/^\d+$/.test(String(port)) || port < 1 || port > 65535) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: port must be a number between 1 and 65535.",
						},
					],
				};
			}

			const safeDir = shellEscape(directory);
			const safePort = String(port);

			const checkResult = await executor.exec(
				`test -f ${safeDir}/index.html && echo "ok" || echo "missing"`,
			);
			if (checkResult.stdout.trim() !== "ok") {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${directory}/index.html not found. Write your app files first, then deploy.`,
						},
					],
				};
			}

			const killResult = await executor.exec(
				`lsof -ti :${safePort} 2>/dev/null | xargs kill -9 2>/dev/null; echo done`,
			);
			void killResult;

			const serverScript = `cd ${safeDir} && nohup python3 -m http.server ${safePort} > /tmp/deploy-server.log 2>&1 & echo $!`;

			const startResult = await executor.exec(serverScript);
			const pid = startResult.stdout.trim();

			if (startResult.code !== 0 || !pid) {
				const fallback = `cd ${safeDir} && nohup npx -y serve -l ${safePort} -s > /tmp/deploy-server.log 2>&1 & echo $!`;

				const fallbackResult = await executor.exec(fallback);
				if (fallbackResult.code !== 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Failed to start server. stderr: ${fallbackResult.stderr || startResult.stderr}`,
							},
						],
					};
				}
			}

			await executor.exec("sleep 1");

			if (executor.getPreviewUrl) {
				try {
					const preview = await executor.getPreviewUrl(port, expiresIn);
					if (preview) {
						const details: DeployDetails = {
							url: preview.url,
							port,
							directory,
							expiresIn,
						};
						try {
							onDeploy?.(String(args.label), details);
						} catch {
							// non-fatal
						}
						return {
							content: [
								{
									type: "text" as const,
									text: [
										"Deployed successfully!",
										`URL: ${preview.url}`,
										`Expires in: ${Math.round(expiresIn / 60)} minutes`,
										`Serving: ${directory}`,
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
								text: `Server started on port ${port} but failed to get preview URL: ${msg}`,
							},
						],
					};
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Server started on port ${port} in ${directory}`,
							"Note: No public URL available (not using Daytona sandbox).",
							`Local access: http://localhost:${port}`,
						].join("\n"),
					},
				],
				details: { port, directory },
			};
		},
	};
}
