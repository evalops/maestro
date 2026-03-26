import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ApiServerInstance,
	createApiServer,
} from "../../packages/slack-agent/src/ui/api-server.js";

describe("ApiServer (workspace-scoped)", () => {
	let testDir: string;
	let server: ApiServerInstance;
	const port = 13456 + Math.floor(Math.random() * 1000);
	let base: string;
	const teamId = "T_TEST";

	beforeAll(async () => {
		testDir = join(
			tmpdir(),
			`api-srv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });

		// Seed a fake installed workspace so /api/workspaces/:teamId works.
		writeFileSync(
			join(testDir, "workspaces.json"),
			JSON.stringify(
				[
					{
						id: "test",
						teamId,
						teamName: "Test Workspace",
						botToken: "xoxb-test",
						botUserId: "U_TEST_BOT",
						installedBy: "U_TEST_ADMIN",
						installedAt: new Date().toISOString(),
						status: "active",
					},
				],
				null,
				2,
			),
		);

		base = `http://localhost:${port}`;
		server = createApiServer({
			port,
			workingDir: testDir,
		});
		await server.start();
	});

	afterAll(async () => {
		await server.stop();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("GET /api/health returns ok", async () => {
		const res = await fetch(`${base}/api/health`);
		const data = await res.json();
		expect(data).toEqual({ ok: true });
	});

	it("GET /api/workspaces/:teamId/dashboards returns empty list", async () => {
		const res = await fetch(`${base}/api/workspaces/${teamId}/dashboards`);
		const data = await res.json();
		expect(data).toEqual([]);
	});

	it("POST /api/workspaces/:teamId/dashboards creates a live definition", async () => {
		const res = await fetch(`${base}/api/workspaces/${teamId}/dashboards`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				label: "Revenue Overview",
				prompt: "Show revenue growth week over week",
				theme: "dark",
			}),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()) as { id: string; definition?: unknown };
		expect(data.id).toMatch(/^dash-/);
		expect(data.definition).toBeTruthy();
	});

	it("GET /api/workspaces/:teamId/dashboards returns created dashboard", async () => {
		const res = await fetch(`${base}/api/workspaces/${teamId}/dashboards`);
		const data = (await res.json()) as Array<{ label: string }>;
		expect(data.length).toBeGreaterThanOrEqual(1);
		expect(data[0]!.label).toBeTruthy();
	});

	it("GET /api/workspaces/:teamId/connectors/types returns known types", async () => {
		const res = await fetch(
			`${base}/api/workspaces/${teamId}/connectors/types`,
		);
		const data = (await res.json()) as string[];
		expect(data).toContain("rest_api");
		expect(data).toContain("hubspot");
	});

	it("POST /api/workspaces/:teamId/connectors adds a connector", async () => {
		const res = await fetch(`${base}/api/workspaces/${teamId}/connectors`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "hubspot", name: "test-hs" }),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	it("GET /api/workspaces/:teamId/connectors lists connectors", async () => {
		const res = await fetch(`${base}/api/workspaces/${teamId}/connectors`);
		const data = (await res.json()) as Array<{ name: string }>;
		expect(data.some((c) => c.name === "test-hs")).toBe(true);
	});

	it("PUT /api/workspaces/:teamId/connectors/:name/credentials sets creds", async () => {
		const res = await fetch(
			`${base}/api/workspaces/${teamId}/connectors/test-hs/credentials`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ secret: "key123" }),
			},
		);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	it("DELETE /api/workspaces/:teamId/connectors/:name removes connector", async () => {
		const res = await fetch(
			`${base}/api/workspaces/${teamId}/connectors/test-hs`,
			{
				method: "DELETE",
			},
		);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	it("POST /api/workspaces/:teamId/triggers adds a trigger", async () => {
		const res = await fetch(`${base}/api/workspaces/${teamId}/triggers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "github",
				channel: "C123",
				prompt: "Review: {{summary}}",
				enabled: true,
			}),
		});
		expect(res.status).toBe(201);
		const data = (await res.json()) as { id: string };
		expect(data.id).toBeTruthy();
	});

	it("GET /api/workspaces/:teamId/triggers lists triggers", async () => {
		const res = await fetch(`${base}/api/workspaces/${teamId}/triggers`);
		const data = (await res.json()) as Array<{ source: string }>;
		expect(data.length).toBeGreaterThanOrEqual(1);
	});

	it("returns 404 for unknown paths", async () => {
		const res = await fetch(`${base}/api/nonexistent`);
		expect(res.status).toBe(404);
	});
});
