import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookTriggerManager } from "../src/connectors/webhook-triggers.js";
import type { WebhookEvent } from "../src/webhooks.js";

describe("WebhookTriggerManager", () => {
	let dir: string;
	let manager: WebhookTriggerManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-webhook-triggers-"));
		manager = new WebhookTriggerManager(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("passes trigger identity to each matching run callback", async () => {
		const first = manager.addTrigger({
			source: "github",
			channel: "CENG",
			prompt: "review {{summary}}",
			enabled: true,
		});
		const second = manager.addTrigger({
			source: "github",
			channel: "CENG",
			prompt: "summarize {{summary}}",
			enabled: true,
		});
		const callbackTriggerIds: string[] = [];
		manager.setRunCallback(async (_channel, _prompt, _event, trigger) => {
			callbackTriggerIds.push(trigger.id);
		});

		const fired = await manager.processEvent(webhookEvent());

		expect(fired).toBe(2);
		expect(callbackTriggerIds).toEqual([first.id, second.id]);
	});
});

function webhookEvent(): WebhookEvent {
	return {
		id: "github:T123:delivery-123",
		teamId: "T123",
		source: "github",
		summary: "GitHub PR opened",
		data: { action: "opened" },
		timestamp: "2026-05-06T17:00:00.000Z",
	};
}
