// @vitest-environment happy-dom
import { fixture, html } from "@open-wc/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/composer-chat.js";
import type { ComposerChat } from "../../packages/web/src/components/composer-chat.js";
import type { WorkspaceStatus } from "../../packages/web/src/services/api-client.js";

function makeWorkspaceStatus(
	overrides: Partial<WorkspaceStatus> = {},
): WorkspaceStatus {
	return {
		cwd: "/tmp/maestro",
		git: null,
		context: {
			agentMd: false,
			claudeMd: false,
		},
		server: {
			uptime: 60,
			version: "v20.0.0",
		},
		database: {
			configured: false,
			connected: false,
		},
		backgroundTasks: null,
		hooks: {
			asyncInFlight: 0,
			concurrency: {
				max: 4,
				active: 0,
				queued: 0,
			},
		},
		lastUpdated: Date.parse("2026-05-22T12:00:00.000Z"),
		lastLatencyMs: 120,
		...overrides,
	};
}

describe("composer-chat health popover", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const path = String(input);
				const body = path.includes("/api/status")
					? makeWorkspaceStatus()
					: path.includes("/api/models")
						? { models: [] }
						: path.includes("/api/sessions")
							? { sessions: [] }
							: path.includes("/api/usage")
								? { summary: null }
								: path.includes("/api/commands")
									? { commands: [] }
									: path.includes("/api/command-prefs")
										? { favorites: [], recents: [] }
										: {};
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("renders run health SLO lanes from the status snapshot", async () => {
		const element = await fixture<ComposerChat>(
			html`<composer-chat></composer-chat>`,
		);
		const internals = element as unknown as {
			clientOnline: boolean;
			status: WorkspaceStatus;
			showHealth: boolean;
		};

		internals.clientOnline = true;
		internals.status = makeWorkspaceStatus({
			runHealth: {
				status: "degraded",
				generatedAt: "2026-05-22T12:00:00.000Z",
				diagnostics: ["Hook queue: 0/4 active, 2 queued, 1 async"],
				slos: [
					{
						id: "api_latency",
						label: "API latency",
						status: "healthy",
						target: "p50 snapshot <= 1000ms",
						observed: "120ms",
					},
					{
						id: "hook_queue",
						label: "Hook queue",
						status: "degraded",
						target: "0 queued hooks",
						observed: "0/4 active, 2 queued, 1 async",
						detail: "Hook execution is backing up behind the concurrency gate.",
					},
				],
			},
		});
		internals.showHealth = true;
		element.requestUpdate();
		await element.updateComplete;

		const popover = element.shadowRoot?.querySelector(".health-popover");
		expect(popover?.textContent).toContain("RUN HEALTH");
		expect(popover?.textContent).toContain("degraded");
		expect(popover?.textContent).toContain("Hook queue");
		expect(popover?.textContent).toContain("0/4 active, 2 queued, 1 async");
	});

	it("prioritizes offline connectivity over stale run health", async () => {
		const element = await fixture<ComposerChat>(
			html`<composer-chat></composer-chat>`,
		);
		const internals = element as unknown as {
			clientOnline: boolean;
			status: WorkspaceStatus;
			showHealth: boolean;
		};

		internals.clientOnline = false;
		internals.status = makeWorkspaceStatus({
			runHealth: {
				status: "healthy",
				generatedAt: "2026-05-22T12:00:00.000Z",
				diagnostics: [],
				slos: [],
			},
		});
		internals.showHealth = true;
		element.requestUpdate();
		await element.updateComplete;

		const overall = element.shadowRoot?.querySelector(
			".health-popover-row strong",
		);
		expect(overall?.textContent).toBe("offline");
		expect(overall?.classList.contains("error")).toBe(true);
	});
});
