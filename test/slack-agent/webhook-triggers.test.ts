/**
 * Tests for WebhookTriggerManager.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookTriggerManager } from "../../packages/slack-agent/src/connectors/webhook-triggers.js";
import type { WebhookEvent } from "../../packages/slack-agent/src/webhooks.js";

describe("WebhookTriggerManager", () => {
	let testDir: string;
	let mgr: WebhookTriggerManager;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`trigger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		mgr = new WebhookTriggerManager(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("starts with no triggers", () => {
		expect(mgr.listTriggers()).toHaveLength(0);
	});

	it("adds a trigger", () => {
		const trigger = mgr.addTrigger({
			source: "github",
			channel: "C123",
			prompt: "Review: {{summary}}",
			enabled: true,
		});
		expect(trigger.id).toBeTruthy();
		expect(mgr.listTriggers()).toHaveLength(1);
	});

	it("removes a trigger", () => {
		const trigger = mgr.addTrigger({
			source: "github",
			channel: "C123",
			prompt: "test",
			enabled: true,
		});
		expect(mgr.removeTrigger(trigger.id)).toBe(true);
		expect(mgr.listTriggers()).toHaveLength(0);
	});

	it("returns false for removing nonexistent trigger", () => {
		expect(mgr.removeTrigger("nonexistent")).toBe(false);
	});

	it("fires trigger on matching event", async () => {
		const runs: Array<{ channel: string; prompt: string }> = [];
		mgr.setRunCallback(async (channel, prompt) => {
			runs.push({ channel, prompt });
		});

		mgr.addTrigger({
			source: "github",
			channel: "C123",
			prompt: "Review: {{summary}}",
			enabled: true,
		});

		const event: WebhookEvent = {
			source: "github",
			summary: "PR opened: Fix login #42",
			data: { action: "opened" },
			timestamp: new Date().toISOString(),
		};

		const fired = await mgr.processEvent(event);
		expect(fired).toBe(1);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.prompt).toBe("Review: PR opened: Fix login #42");
		expect(runs[0]!.channel).toBe("C123");
	});

	it("does not fire disabled triggers", async () => {
		const runs: Array<{ channel: string; prompt: string }> = [];
		mgr.setRunCallback(async (channel, prompt) => {
			runs.push({ channel, prompt });
		});

		mgr.addTrigger({
			source: "github",
			channel: "C123",
			prompt: "test",
			enabled: false,
		});

		const event: WebhookEvent = {
			source: "github",
			summary: "test",
			data: {},
			timestamp: new Date().toISOString(),
		};

		const fired = await mgr.processEvent(event);
		expect(fired).toBe(0);
		expect(runs).toHaveLength(0);
	});

	it("does not fire trigger for non-matching source", async () => {
		const runs: Array<{ channel: string; prompt: string }> = [];
		mgr.setRunCallback(async (channel, prompt) => {
			runs.push({ channel, prompt });
		});

		mgr.addTrigger({
			source: "stripe",
			channel: "C123",
			prompt: "test",
			enabled: true,
		});

		const event: WebhookEvent = {
			source: "github",
			summary: "test",
			data: {},
			timestamp: new Date().toISOString(),
		};

		const fired = await mgr.processEvent(event);
		expect(fired).toBe(0);
	});

	it("supports wildcard source", async () => {
		const runs: Array<{ channel: string; prompt: string }> = [];
		mgr.setRunCallback(async (channel, prompt) => {
			runs.push({ channel, prompt });
		});

		mgr.addTrigger({
			source: "*",
			channel: "C123",
			prompt: "Event from {{source}}: {{summary}}",
			enabled: true,
		});

		const event: WebhookEvent = {
			source: "anything",
			summary: "test event",
			data: {},
			timestamp: new Date().toISOString(),
		};

		const fired = await mgr.processEvent(event);
		expect(fired).toBe(1);
		expect(runs[0]!.prompt).toContain("anything");
	});

	it("applies filter on event data", async () => {
		const runs: Array<{ channel: string; prompt: string }> = [];
		mgr.setRunCallback(async (channel, prompt) => {
			runs.push({ channel, prompt });
		});

		mgr.addTrigger({
			source: "github",
			filter: { action: "opened" },
			channel: "C123",
			prompt: "PR opened: {{summary}}",
			enabled: true,
		});

		// Non-matching
		await mgr.processEvent({
			source: "github",
			summary: "closed",
			data: { action: "closed" },
			timestamp: new Date().toISOString(),
		});
		expect(runs).toHaveLength(0);

		// Matching
		await mgr.processEvent({
			source: "github",
			summary: "opened",
			data: { action: "opened" },
			timestamp: new Date().toISOString(),
		});
		expect(runs).toHaveLength(1);
	});

	describe("handleTriggersCommand", () => {
		it("lists empty triggers", () => {
			const result = mgr.handleTriggersCommand("", "U1");
			expect(result).toContain("No webhook triggers");
		});

		it("adds a trigger via command", () => {
			const result = mgr.handleTriggersCommand(
				"add github C123 Review this PR: {{summary}}",
				"U1",
			);
			expect(result).toContain("created");
			expect(mgr.listTriggers()).toHaveLength(1);
		});

		it("removes a trigger via command", () => {
			const trigger = mgr.addTrigger({
				source: "github",
				channel: "C1",
				prompt: "t",
				enabled: true,
			});
			const result = mgr.handleTriggersCommand(`remove ${trigger.id}`, "U1");
			expect(result).toContain("removed");
		});

		it("lists triggers", () => {
			mgr.addTrigger({
				source: "github",
				channel: "C1",
				prompt: "test prompt",
				enabled: true,
			});
			const result = mgr.handleTriggersCommand("list", "U1");
			expect(result).toContain("github");
			expect(result).toContain("test prompt");
		});
	});
});
