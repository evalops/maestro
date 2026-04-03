/**
 * Tests for webhook ingestion server.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type WebhookEvent,
	createWebhookServer,
	registerWebhookHandler,
} from "../../packages/slack-agent/src/webhooks.js";

describe("webhook server", () => {
	const servers: Array<{ stop(): Promise<void> }> = [];
	const teamId = "T123";

	afterEach(async () => {
		for (const s of servers) {
			try {
				await s.stop();
			} catch {
				// ignore
			}
		}
		servers.length = 0;
	});

	function urlFor(server: { port: number }, path: string): string {
		return `http://localhost:${server.port}${path}`;
	}

	it("responds to health check", async () => {
		const server = createWebhookServer({ port: 0 }, async () => {});
		servers.push(server);
		await server.start();

		const r = await fetch(urlFor(server, "/webhooks/health"));
		expect(r.status).toBe(200);
		const body = (await r.json()) as { status: string };
		expect(body.status).toBe("ok");
	});

	it("returns 404 for unknown paths", async () => {
		const server = createWebhookServer({ port: 0 }, async () => {});
		servers.push(server);
		await server.start();

		const r = await fetch(urlFor(server, "/unknown"));
		expect(r.status).toBe(404);
	});

	it("receives generic webhook and calls callback", async () => {
		const events: WebhookEvent[] = [];

		const server = createWebhookServer({ port: 0 }, async (event) => {
			events.push(event);
		});
		servers.push(server);
		await server.start();

		const r = await fetch(urlFor(server, `/webhooks/${teamId}/generic`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ event: "test_event", data: { foo: "bar" } }),
		});

		expect(r.status).toBe(200);
		expect(events.length).toBe(1);
		expect(events[0]!.teamId).toBe(teamId);
		expect(events[0]!.source).toBe("generic");
		expect(events[0]!.summary).toContain("test_event");
	});

	it("parses GitHub push events", async () => {
		const events: WebhookEvent[] = [];

		const server = createWebhookServer({ port: 0 }, async (event) => {
			events.push(event);
		});
		servers.push(server);
		await server.start();

		const r = await fetch(urlFor(server, `/webhooks/${teamId}/github`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				ref: "refs/heads/main",
				commits: [{ id: "abc123" }, { id: "def456" }],
				repository: { full_name: "org/repo" },
			}),
		});

		expect(r.status).toBe(200);
		expect(events[0]!.teamId).toBe(teamId);
		expect(events[0]!.summary).toContain("2 commit(s)");
		expect(events[0]!.summary).toContain("org/repo");
	});

	it("parses GitHub PR events", async () => {
		const events: WebhookEvent[] = [];

		const server = createWebhookServer({ port: 0 }, async (event) => {
			events.push(event);
		});
		servers.push(server);
		await server.start();

		await fetch(urlFor(server, `/webhooks/${teamId}/github`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action: "opened",
				pull_request: { title: "Fix bug", number: 42 },
				repository: { full_name: "org/repo" },
			}),
		});

		expect(events[0]!.teamId).toBe(teamId);
		expect(events[0]!.summary).toContain("PR opened");
		expect(events[0]!.summary).toContain("Fix bug");
	});

	it("parses Stripe events", async () => {
		const events: WebhookEvent[] = [];

		const server = createWebhookServer({ port: 0 }, async (event) => {
			events.push(event);
		});
		servers.push(server);
		await server.start();

		await fetch(urlFor(server, `/webhooks/${teamId}/stripe`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "payment_intent.succeeded",
				data: { object: { amount: 5000 } },
			}),
		});

		expect(events[0]!.teamId).toBe(teamId);
		expect(events[0]!.summary).toContain("payment_intent.succeeded");
		expect(events[0]!.summary).toContain("$50.00");
	});

	it("parses Linear events", async () => {
		const events: WebhookEvent[] = [];

		const server = createWebhookServer({ port: 0 }, async (event) => {
			events.push(event);
		});
		servers.push(server);
		await server.start();

		await fetch(urlFor(server, `/webhooks/${teamId}/linear`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action: "create",
				type: "Issue",
				data: { identifier: "ENG-123", title: "Fix login" },
			}),
		});

		expect(events[0]!.teamId).toBe(teamId);
		expect(events[0]!.summary).toContain("ENG-123");
		expect(events[0]!.summary).toContain("Fix login");
	});

	it("verifies GitHub webhook signature", async () => {
		const secret = "test-secret";
		const events: WebhookEvent[] = [];

		const server = createWebhookServer(
			{ port: 0, secrets: { github: secret } },
			async (event) => {
				events.push(event);
			},
		);
		servers.push(server);
		await server.start();

		const body = JSON.stringify({
			action: "opened",
			repository: { full_name: "org/repo" },
		});
		const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

		// Valid signature
		const r1 = await fetch(urlFor(server, `/webhooks/${teamId}/github`), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Hub-Signature-256": signature,
			},
			body,
		});
		expect(r1.status).toBe(200);
		expect(events.length).toBe(1);

		// Invalid signature
		const r2 = await fetch(urlFor(server, `/webhooks/${teamId}/github`), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Hub-Signature-256": "sha256=invalid",
			},
			body,
		});
		expect(r2.status).toBe(401);
		expect(events.length).toBe(1); // no new event
	});

	it("rejects invalid JSON", async () => {
		const server = createWebhookServer({ port: 0 }, async () => {});
		servers.push(server);
		await server.start();

		const r = await fetch(urlFor(server, `/webhooks/${teamId}/generic`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		expect(r.status).toBe(400);
	});

	it("uses defaultChannel when event has no channel", async () => {
		const events: WebhookEvent[] = [];

		const server = createWebhookServer(
			{ port: 0, defaultChannel: "C12345" },
			async (event) => {
				events.push(event);
			},
		);
		servers.push(server);
		await server.start();

		await fetch(urlFor(server, `/webhooks/${teamId}/generic`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ event: "test" }),
		});

		expect(events[0]!.teamId).toBe(teamId);
		expect(events[0]!.channel).toBe("C12345");
	});

	it("registerWebhookHandler adds custom source", async () => {
		registerWebhookHandler("custom_source", (body) => ({
			summary: `Custom: ${body.message ?? "no message"}`,
		}));

		const events: WebhookEvent[] = [];

		const server = createWebhookServer({ port: 0 }, async (event) => {
			events.push(event);
		});
		servers.push(server);
		await server.start();

		await fetch(urlFor(server, `/webhooks/${teamId}/custom_source`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});

		expect(events[0]!.teamId).toBe(teamId);
		expect(events[0]!.summary).toBe("Custom: hello");
	});
});
