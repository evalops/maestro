/**
 * Status Tool - Container and system health information
 *
 * Provides the agent with visibility into its execution environment:
 * - Container state and resource usage (CPU, memory, disk)
 * - Workspace disk usage
 * - System uptime and health indicators
 */

import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { shellEscape } from "../utils/shell-escape.js";
import type { AgentTool } from "./index.js";

export interface ContainerHealth {
	container: {
		name: string;
		id: string;
		image: string;
		status: string;
		uptime: string;
	} | null;
	resources: {
		cpuPercent: string;
		memoryUsed: string;
		memoryLimit: string;
		memoryPercent: string;
		pids: number;
	} | null;
	workspace: {
		path: string;
		usedBytes: number;
		usedHuman: string;
		fileCount: number;
	};
	environment: "docker" | "host";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function parseDockerStats(
	statsJson: string,
): ContainerHealth["resources"] | null {
	try {
		const stats = JSON.parse(statsJson);
		return {
			cpuPercent: stats.CPUPerc || "0%",
			memoryUsed: stats.MemUsage?.split(" / ")[0] || "0",
			memoryLimit: stats.MemUsage?.split(" / ")[1] || "0",
			memoryPercent: stats.MemPerc || "0%",
			pids: Number.parseInt(stats.PIDs, 10) || 0,
		};
	} catch {
		return null;
	}
}

function parseDockerInspect(
	inspectJson: string,
): Partial<ContainerHealth["container"]> | null {
	try {
		const info = JSON.parse(inspectJson);
		const startedAt = info.State?.StartedAt;
		let uptime = "unknown";
		if (startedAt) {
			const startTime = new Date(startedAt).getTime();
			const now = Date.now();
			const diffMs = now - startTime;
			const hours = Math.floor(diffMs / (1000 * 60 * 60));
			const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
			if (hours > 24) {
				const days = Math.floor(hours / 24);
				uptime = `${days}d ${hours % 24}h`;
			} else if (hours > 0) {
				uptime = `${hours}h ${minutes}m`;
			} else {
				uptime = `${minutes}m`;
			}
		}
		return {
			name: info.Name?.replace(/^\//, "") || "unknown",
			id: info.Id?.substring(0, 12) || "unknown",
			image: info.Config?.Image || "unknown",
			status: info.State?.Status || "unknown",
			uptime,
		};
	} catch {
		return null;
	}
}

export function createStatusTool(
	executor: Executor,
	containerName?: string,
): AgentTool {
	const isDocker = containerName !== undefined;

	return {
		name: "status",
		label: "status",
		description:
			"Check system status including container health, resource usage (CPU, memory), and workspace disk usage. Use this to monitor your execution environment.",
		parameters: Type.Object({
			label: Type.String({
				description: "Brief label shown to user (e.g., 'checking status')",
			}),
		}),
		execute: async (_toolCallId, _args, signal) => {
			const health: ContainerHealth = {
				container: null,
				resources: null,
				workspace: {
					path: executor.getWorkspacePath("/workspace"),
					usedBytes: 0,
					usedHuman: "0B",
					fileCount: 0,
				},
				environment: isDocker ? "docker" : "host",
			};

			// Get workspace disk usage
			try {
				const duResult = await executor.exec(
					"du -sb /workspace 2>/dev/null || du -sb . 2>/dev/null || echo '0 .'",
					{ signal },
				);
				if (duResult.code === 0) {
					const match = duResult.stdout.match(/^(\d+)/);
					if (match) {
						health.workspace.usedBytes = Number.parseInt(match[1]!, 10);
						health.workspace.usedHuman = formatBytes(
							health.workspace.usedBytes,
						);
					}
				}

				// Count files
				const findResult = await executor.exec(
					"find /workspace -type f 2>/dev/null | wc -l || find . -type f 2>/dev/null | wc -l || echo '0'",
					{ signal },
				);
				if (findResult.code === 0) {
					health.workspace.fileCount =
						Number.parseInt(findResult.stdout.trim(), 10) || 0;
				}
			} catch {
				// Ignore errors, use defaults
			}

			// For Docker environments, get container stats
			if (isDocker && containerName) {
				try {
					// Get container inspect info (runs on host, not in container)
					const hostExec = await import("node:child_process");
					const inspectResult = await new Promise<string>((resolve, reject) => {
						hostExec.exec(
							`docker inspect ${shellEscape(containerName)}`,
							{ timeout: 5000 },
							(err, stdout) => {
								if (err) reject(err);
								else resolve(stdout);
							},
						);
					});

					const inspectArray = JSON.parse(inspectResult);
					if (inspectArray.length > 0) {
						const containerInfo = parseDockerInspect(
							JSON.stringify(inspectArray[0]),
						);
						if (containerInfo) {
							health.container = {
								name: containerInfo.name || containerName,
								id: containerInfo.id || "unknown",
								image: containerInfo.image || "unknown",
								status: containerInfo.status || "unknown",
								uptime: containerInfo.uptime || "unknown",
							};
						}
					}

					// Get container stats
					const statsResult = await new Promise<string>((resolve, reject) => {
						hostExec.exec(
							`docker stats --no-stream --format "{{json .}}" ${shellEscape(containerName)}`,
							{ timeout: 5000 },
							(err, stdout) => {
								if (err) reject(err);
								else resolve(stdout);
							},
						);
					});

					health.resources = parseDockerStats(statsResult.trim());
				} catch {
					// Container stats unavailable
				}
			}

			// Format output
			const lines: string[] = [];
			lines.push(`Environment: ${health.environment}`);

			if (health.container) {
				lines.push("");
				lines.push("Container:");
				lines.push(`  Name: ${health.container.name}`);
				lines.push(`  ID: ${health.container.id}`);
				lines.push(`  Image: ${health.container.image}`);
				lines.push(`  Status: ${health.container.status}`);
				lines.push(`  Uptime: ${health.container.uptime}`);
			}

			if (health.resources) {
				lines.push("");
				lines.push("Resources:");
				lines.push(`  CPU: ${health.resources.cpuPercent}`);
				lines.push(
					`  Memory: ${health.resources.memoryUsed} / ${health.resources.memoryLimit} (${health.resources.memoryPercent})`,
				);
				lines.push(`  Processes: ${health.resources.pids}`);
			}

			lines.push("");
			lines.push("Workspace:");
			lines.push(`  Path: ${health.workspace.path}`);
			lines.push(`  Disk Usage: ${health.workspace.usedHuman}`);
			lines.push(`  Files: ${health.workspace.fileCount}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: health,
			};
		},
	};
}
