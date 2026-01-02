import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubApiClient, WebhookDelivery } from "../github/client.js";
import type { AgentConfig } from "../types.js";
import { WebhookRedeliveryManager } from "./redelivery.js";

type MockClient = {
	listWebhookDeliveries: ReturnType<typeof vi.fn>;
	redeliverWebhookDelivery: ReturnType<typeof vi.fn>;
};

const baseConfig = (dir: string): AgentConfig => ({
	owner: "owner",
	repo: "repo",
	baseBranch: "main",
	pollIntervalMs: 1000,
	issueLabels: [],
	maxConcurrentTasks: 1,
	requireTests: false,
	requireLint: false,
	requireTypeCheck: false,
	selfReview: false,
	maxAttemptsPerTask: 1,
	maxTokensPerTask: 1000,
	dailyBudget: 1,
	workingDir: dir,
	memoryDir: dir,
});

const runManager = async (manager: WebhookRedeliveryManager): Promise<void> => {
	const runner = manager as unknown as { run: () => Promise<void> };
	await runner.run();
};

describe("WebhookRedeliveryManager", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "github-redelivery-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("redelivers failed deliveries and respects per-run cap", async () => {
		const deliveries: WebhookDelivery[] = Array.from({ length: 6 }, (_, i) => ({
			id: 100 + i,
			guid: `guid-${i}`,
			deliveredAt: new Date().toISOString(),
			status: "failed",
			statusCode: 500,
			redelivery: false,
			event: "issues",
			action: "opened",
		}));

		const client: MockClient = {
			listWebhookDeliveries: vi.fn().mockResolvedValue({
				deliveries,
				nextCursor: null,
			}),
			redeliverWebhookDelivery: vi.fn().mockResolvedValue(undefined),
		};

		const manager = new WebhookRedeliveryManager({
			config: baseConfig(tempDir),
			client: client as unknown as GitHubApiClient,
			hookId: 42,
		});

		await runManager(manager);

		expect(client.redeliverWebhookDelivery).toHaveBeenCalledTimes(5);
	});

	it("skips redelivery when a successful attempt exists", async () => {
		const deliveries: WebhookDelivery[] = [
			{
				id: 1,
				guid: "guid-success",
				deliveredAt: new Date().toISOString(),
				status: "ok",
				statusCode: 200,
				redelivery: false,
				event: "issues",
				action: "opened",
			},
			{
				id: 2,
				guid: "guid-success",
				deliveredAt: new Date().toISOString(),
				status: "failed",
				statusCode: 500,
				redelivery: false,
				event: "issues",
				action: "opened",
			},
		];

		const client: MockClient = {
			listWebhookDeliveries: vi.fn().mockResolvedValue({
				deliveries,
				nextCursor: null,
			}),
			redeliverWebhookDelivery: vi.fn().mockResolvedValue(undefined),
		};

		const manager = new WebhookRedeliveryManager({
			config: baseConfig(tempDir),
			client: client as unknown as GitHubApiClient,
			hookId: 42,
		});

		await runManager(manager);

		expect(client.redeliverWebhookDelivery).not.toHaveBeenCalled();
	});

	it("persists discovered hook ID", async () => {
		const client: MockClient = {
			listWebhookDeliveries: vi.fn().mockResolvedValue({
				deliveries: [],
				nextCursor: null,
			}),
			redeliverWebhookDelivery: vi.fn().mockResolvedValue(undefined),
		};

		const manager = new WebhookRedeliveryManager({
			config: baseConfig(tempDir),
			client: client as unknown as GitHubApiClient,
			getHookId: () => 99,
		});

		await runManager(manager);

		const restored = new WebhookRedeliveryManager({
			config: baseConfig(tempDir),
			client: client as unknown as GitHubApiClient,
		});

		const resolver = restored as unknown as {
			resolveHookId: () => number | undefined;
		};
		expect(resolver.resolveHookId()).toBe(99);
	});
});
