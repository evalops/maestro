import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveDashboardTool } from "../src/tools/create-live-dashboard.js";
import { DashboardRegistry } from "../src/ui/dashboard-registry.js";

describe("createLiveDashboardTool", () => {
	let dir: string;

	beforeEach(async () => {
		dir = join(tmpdir(), `slack-agent-live-dash-${Date.now()}`);
		await mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates a live dashboard definition and returns a control plane link", async () => {
		const registry = new DashboardRegistry(dir);
		const tool = createLiveDashboardTool({
			teamId: "T_TEST",
			dashboardRegistry: registry,
			createdBy: "U_TEST",
			uiBaseUrl: "https://example.com",
		});

		const result = await tool.execute("call-1", {
			label: "Revenue Dashboard",
			prompt:
				"Show revenue WoW growth, top customers, and MRR trend for the last 8 weeks.",
			theme: "dark",
		});

		expect(result.content[0]?.text).toContain("Created live dashboard");
		expect(result.content[0]?.text).toContain(
			"<https://example.com/T_TEST/dashboards/",
		);
		expect(result.details).toMatchObject({ teamId: "T_TEST" });

		const dashboards = registry.list();
		expect(dashboards).toHaveLength(1);
		expect(dashboards[0]?.definition?.prompt).toContain("revenue");
		expect(dashboards[0]?.definition?.createdBy).toBe("U_TEST");
	});
});
