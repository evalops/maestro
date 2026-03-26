import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardSpec } from "../../packages/slack-agent/src/dashboard/types.js";
import { DashboardRegistry } from "../../packages/slack-agent/src/ui/dashboard-registry.js";

const sampleSpec: DashboardSpec = {
	title: "Test Dashboard",
	subtitle: "Unit test",
	theme: "dark",
	generatedAt: "2025-01-01T00:00:00Z",
	components: [
		{
			type: "stat-group",
			items: [
				{ label: "Revenue", value: "$100k", change: "+10%", trend: "up" },
			],
		},
		{
			type: "bar-chart",
			labels: ["Jan", "Feb"],
			datasets: [{ label: "Sales", data: [10, 20] }],
		},
	],
};

describe("DashboardRegistry — spec support", () => {
	let testDir: string;
	let registry: DashboardRegistry;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`dash-spec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		registry = new DashboardRegistry(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("registers a dashboard with spec", () => {
		const d = registry.register({
			label: "With Spec",
			url: "https://example.com",
			directory: "/app/test",
			port: 8080,
			spec: sampleSpec,
		});
		expect(d.spec).toEqual(sampleSpec);
		expect(d.spec?.title).toBe("Test Dashboard");
		expect(d.spec?.components).toHaveLength(2);
	});

	it("get returns spec when present", () => {
		const d = registry.register({
			label: "Get Test",
			url: "https://example.com",
			directory: "/app/get",
			port: 8080,
			spec: sampleSpec,
		});
		const fetched = registry.get(d.id);
		expect(fetched?.spec).toEqual(sampleSpec);
	});

	it("update modifies spec", () => {
		const d = registry.register({
			label: "Update Test",
			url: "https://example.com",
			directory: "/app/update",
			port: 8080,
			spec: sampleSpec,
		});
		const newSpec: DashboardSpec = {
			...sampleSpec,
			title: "Updated Title",
		};
		const updated = registry.update(d.id, { spec: newSpec });
		expect(updated?.spec?.title).toBe("Updated Title");
		expect(updated?.updatedAt).toBeTruthy();
	});

	it("update sets updatedAt timestamp", () => {
		const d = registry.register({
			label: "Timestamp Test",
			url: "https://example.com",
			directory: "/app/ts",
			port: 8080,
		});
		expect(d.updatedAt).toBeUndefined();
		const updated = registry.update(d.id, { label: "Renamed" });
		expect(updated?.updatedAt).toBeTruthy();
		expect(updated?.label).toBe("Renamed");
	});

	it("update returns undefined for nonexistent id", () => {
		expect(registry.update("nonexistent", { label: "x" })).toBeUndefined();
	});

	it("backward compat: entries without spec work normally", () => {
		const d = registry.register({
			label: "No Spec",
			url: "https://legacy.example.com",
			directory: "/app/legacy",
			port: 8080,
		});
		expect(d.spec).toBeUndefined();
		expect(registry.get(d.id)?.spec).toBeUndefined();
		expect(registry.list()).toHaveLength(1);
	});

	it("persists spec across instances", () => {
		registry.register({
			label: "Persist Spec",
			url: "https://persist.example.com",
			directory: "/app/persist",
			port: 8080,
			spec: sampleSpec,
		});

		const registry2 = new DashboardRegistry(testDir);
		const list = registry2.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.spec).toEqual(sampleSpec);
	});

	it("update persists across instances", () => {
		const d = registry.register({
			label: "Persist Update",
			url: "https://example.com",
			directory: "/app/pu",
			port: 8080,
			spec: sampleSpec,
		});
		registry.update(d.id, {
			spec: { ...sampleSpec, title: "Persisted Update" },
		});

		const registry2 = new DashboardRegistry(testDir);
		const fetched = registry2.get(d.id);
		expect(fetched?.spec?.title).toBe("Persisted Update");
		expect(fetched?.updatedAt).toBeTruthy();
	});
});
