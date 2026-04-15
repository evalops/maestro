import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClientManager } from "../../src/mcp/manager.js";
import {
	getProjectMcpServerApprovalStatus,
	setProjectMcpServerApprovalDecision,
} from "../../src/mcp/project-approvals.js";

describe("project MCP approvals", () => {
	let testDir: string;
	let approvalsFile: string;
	const managers: McpClientManager[] = [];

	beforeEach(() => {
		testDir = join(tmpdir(), `mcp-project-approvals-${Date.now()}`);
		approvalsFile = join(testDir, "project-approvals.json");
		mkdirSync(testDir, { recursive: true });
		process.env.MAESTRO_MCP_PROJECT_APPROVALS_FILE = approvalsFile;
		vi.useFakeTimers();
	});

	afterEach(async () => {
		for (const manager of managers) {
			await manager.disconnectAll();
		}
		managers.length = 0;
		Reflect.deleteProperty(process.env, "MAESTRO_MCP_PROJECT_APPROVALS_FILE");
		rmSync(testDir, { recursive: true, force: true });
		vi.useRealTimers();
	});

	function createManager(): McpClientManager {
		const manager = new McpClientManager();
		managers.push(manager);
		return manager;
	}

	it("treats unseen project servers as pending until approved", () => {
		expect(
			getProjectMcpServerApprovalStatus({
				projectRoot: testDir,
				server: {
					name: "linear",
					scope: "project",
					transport: "http",
					url: "https://mcp.linear.app/mcp",
				},
			}),
		).toBe("pending");
	});

	it("resets approval when the project auth preset changes", () => {
		const server = {
			name: "linear",
			scope: "project" as const,
			transport: "http" as const,
			url: "https://mcp.linear.app/mcp",
			authPreset: "linear-auth",
		};
		const authPresets = [
			{
				name: "linear-auth",
				scope: "project" as const,
				headers: {
					Authorization: "Bearer one",
				},
			},
		];

		setProjectMcpServerApprovalDecision({
			projectRoot: testDir,
			server,
			authPresets,
			decision: "approved",
		});

		expect(
			getProjectMcpServerApprovalStatus({
				projectRoot: testDir,
				server,
				authPresets,
			}),
		).toBe("approved");

		expect(
			getProjectMcpServerApprovalStatus({
				projectRoot: testDir,
				server,
				authPresets: [
					{
						name: "linear-auth",
						scope: "project",
						headers: {
							Authorization: "Bearer two",
						},
					},
				],
			}),
		).toBe("pending");
	});

	it("keeps project servers disconnected until approved", async () => {
		const manager = createManager();

		await manager.configure({
			projectRoot: testDir,
			authPresets: [],
			servers: [
				{
					name: "repo-server",
					scope: "project",
					transport: "stdio",
					command: "nonexistent-cmd",
				},
			],
		});

		await vi.advanceTimersByTimeAsync(100);

		expect(manager.getStatus().servers[0]).toMatchObject({
			name: "repo-server",
			connected: false,
			projectApproval: "pending",
			error: undefined,
		});
	});

	it("attempts project connections after approval is recorded", async () => {
		const manager = createManager();
		const server = {
			name: "repo-server",
			scope: "project" as const,
			transport: "stdio" as const,
			command: "nonexistent-cmd",
		};

		setProjectMcpServerApprovalDecision({
			projectRoot: testDir,
			server,
			decision: "approved",
		});

		await manager.configure({
			projectRoot: testDir,
			authPresets: [],
			servers: [server],
		});

		await vi.advanceTimersByTimeAsync(100);

		expect(manager.getStatus().servers[0]).toMatchObject({
			name: "repo-server",
			connected: false,
			projectApproval: "approved",
		});
		expect(manager.getStatus().servers[0]?.error).toBeTruthy();
	});
});
