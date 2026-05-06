import { describe, expect, it } from "vitest";
import { type WebhookEvent, createWebhookServer } from "../src/webhooks.js";

describe("createWebhookServer", () => {
	it("assigns stable delivery-based event ids to webhook callbacks", async () => {
		const events: WebhookEvent[] = [];
		const server = createWebhookServer(
			{ port: 0, host: "127.0.0.1", defaultChannel: "CENG" },
			async (event) => {
				events.push(event);
			},
		);

		await server.start();
		try {
			const response = await fetch(
				`http://127.0.0.1:${server.port}/webhooks/T123/github`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-github-delivery": "delivery-123",
					},
					body: JSON.stringify({
						action: "opened",
						repository: { full_name: "evalops/maestro" },
						pull_request: {
							number: 294,
							title: "Add platform runtime evidence",
						},
					}),
				},
			);

			expect(response.status).toBe(200);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				id: "github:T123:delivery-123",
				teamId: "T123",
				source: "github",
				channel: "CENG",
			});
		} finally {
			await server.stop();
		}
	});
});
