import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardRegistry } from "../../packages/slack-agent/src/ui/dashboard-registry.js";

describe("DashboardRegistry", () => {
	let testDir: string;
	let registry: DashboardRegistry;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`dash-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		registry = new DashboardRegistry(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("starts empty", () => {
		expect(registry.list()).toHaveLength(0);
	});

	it("registers a dashboard", () => {
		const d = registry.register({
			label: "Sales Dashboard",
			url: "https://example.com/preview",
			directory: "/app/dashboards/sales",
			port: 8080,
		});
		expect(d.id).toMatch(/^dash-/);
		expect(d.createdAt).toBeTruthy();
		expect(registry.list()).toHaveLength(1);
	});

	it("lists dashboards in reverse chronological order", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			registry.register({
				label: "First",
				url: "https://first.example.com",
				directory: "/app/1",
				port: 8080,
			});
			vi.advanceTimersByTime(1);
			registry.register({
				label: "Second",
				url: "https://second.example.com",
				directory: "/app/2",
				port: 8081,
			});
			const list = registry.list();
			expect(list).toHaveLength(2);
			expect(list[0]!.label).toBe("Second");
		} finally {
			vi.useRealTimers();
		}
	});

	it("gets a dashboard by id", () => {
		const d = registry.register({
			label: "Test",
			url: "https://test.example.com",
			directory: "/app/test",
			port: 8080,
		});
		expect(registry.get(d.id)).toEqual(d);
		expect(registry.get("nonexistent")).toBeUndefined();
	});

	it("removes a dashboard", () => {
		const d = registry.register({
			label: "ToRemove",
			url: "https://remove.example.com",
			directory: "/app/rm",
			port: 8080,
		});
		expect(registry.remove(d.id)).toBe(true);
		expect(registry.list()).toHaveLength(0);
		expect(registry.remove("nonexistent")).toBe(false);
	});

	it("persists across instances", () => {
		registry.register({
			label: "Persisted",
			url: "https://persist.example.com",
			directory: "/app/persist",
			port: 8080,
		});

		const registry2 = new DashboardRegistry(testDir);
		expect(registry2.list()).toHaveLength(1);
		expect(registry2.list()[0]!.label).toBe("Persisted");
	});

	it("stores expiresAt", () => {
		const d = registry.register({
			label: "Expiring",
			url: "https://expire.example.com",
			directory: "/app/exp",
			port: 8080,
			expiresAt: "2025-12-31T00:00:00Z",
		});
		expect(d.expiresAt).toBe("2025-12-31T00:00:00Z");
	});
});
