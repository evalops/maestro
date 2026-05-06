import { describe, expect, it, vi } from "vitest";
import {
	type PlatformRuntimeConfig,
	buildSlackAgentRuntimeTrigger,
	recordSlackAgentRuntimeTrigger,
	resolvePlatformRuntimeConfig,
} from "../src/platform-runtime.js";
import type { SlackContext } from "../src/slack/bot.js";

function context(overrides: Partial<SlackContext> = {}): SlackContext {
	return {
		teamId: "T123",
		channelName: "eng-ops",
		channels: [],
		users: [],
		threadKey: "1710000000.000100",
		useThread: true,
		runId: "run_test",
		source: "channel",
		message: {
			text: "investigate the failing deploy",
			rawText: "<@BOT> investigate the failing deploy",
			user: "U123",
			userName: "Ada",
			teamId: "T123",
			channel: "C123",
			ts: "1710000000.000100",
			threadTs: undefined,
			attachments: [],
		},
		store: {} as SlackContext["store"],
		respond: async () => undefined,
		replaceMessage: async () => undefined,
		respondInThread: async () => undefined,
		setTyping: async () => undefined,
		uploadFile: async () => undefined,
		setWorking: async () => undefined,
		updateStatus: async () => undefined,
		...overrides,
	};
}

function config(fetchImpl: typeof fetch = fetch): PlatformRuntimeConfig {
	return {
		baseUrl: "https://platform.example",
		token: "token",
		organizationId: "org_evalops",
		workspaceId: "workspace_evalops",
		agentId: "engineering-ops",
		timeoutMs: 1_000,
		fetchImpl,
		now: () => new Date("2026-05-06T17:00:00Z"),
	};
}

describe("resolvePlatformRuntimeConfig", () => {
	it("normalizes AgentRuntime service URLs", () => {
		const resolved = resolvePlatformRuntimeConfig({
			SLACK_AGENT_PLATFORM_RUNTIME_URL:
				"https://platform.example/agentruntime.v1.AgentRuntimeService/HandleTrigger",
			SLACK_AGENT_PLATFORM_RUNTIME_TOKEN: "token",
		});

		expect(resolved?.baseUrl).toBe("https://platform.example");
		expect(resolved?.token).toBe("token");
		expect(resolved?.agentId).toBe("maestro-slack-agent");
	});

	it("resolves organization scoping for Connect requests", () => {
		const resolved = resolvePlatformRuntimeConfig({
			SLACK_AGENT_PLATFORM_RUNTIME_URL: "https://platform.example",
			MAESTRO_EVALOPS_ORG_ID: "org_evalops",
		});

		expect(resolved?.organizationId).toBe("org_evalops");
	});

	it("stays disabled without a Platform URL", () => {
		expect(resolvePlatformRuntimeConfig({})).toBeNull();
	});
});

describe("buildSlackAgentRuntimeTrigger", () => {
	it("builds a Slack work-envelope trigger with stable channel coordinates", () => {
		const trigger = buildSlackAgentRuntimeTrigger(context(), {
			workingDir: "/workspace",
			channelDir: "/workspace/C123",
			prompt: "investigate the failing deploy",
			model: "claude-opus-4-5",
			config: config(),
		});

		expect(trigger).toMatchObject({
			workspaceId: "workspace_evalops",
			agentId: "engineering-ops",
			surfaceType: "SURFACE_SLACK",
			channelId: "C123",
			sourceEventId: "1710000000.000100",
			sourceEventType: "slack.app_mention",
			triggerKind: "RUNTIME_TRIGGER_KIND_SLACK_APP_MENTION",
			channelContext: {
				channelKind: "RUNTIME_CHANNEL_KIND_SLACK",
				providerWorkspaceId: "T123",
				channelId: "C123",
				threadId: "1710000000.000100",
				messageId: "1710000000.000100",
				actorId: "U123",
			},
			workEnvelope: {
				id: "slack:T123:C123:1710000000.000100",
				kind: "RUNTIME_WORK_ENVELOPE_KIND_CONVERSATION_THREAD",
				rootId: "1710000000.000100",
			},
		});
		expect(trigger?.payload).toMatchObject({
			slack_agent: { runId: "run_test", source: "channel", useThread: true },
			message: { text: "investigate the failing deploy", user: "U123" },
			execution: { workingDir: "/workspace", channelDir: "/workspace/C123" },
		});
	});

	it("uses direct-conversation envelopes for DMs", () => {
		const trigger = buildSlackAgentRuntimeTrigger(
			context({ source: "dm", threadKey: "D123" }),
			{
				workingDir: "/workspace",
				channelDir: "/workspace/D123",
				prompt: "help",
				config: config(),
			},
		);

		expect(trigger?.triggerKind).toBe(
			"RUNTIME_TRIGGER_KIND_SLACK_DIRECT_MESSAGE",
		);
		expect((trigger?.workEnvelope as Record<string, unknown>).kind).toBe(
			"RUNTIME_WORK_ENVELOPE_KIND_DIRECT_CONVERSATION",
		);
	});

	it("uses stable upstream event ids for idempotency", () => {
		const trigger = buildSlackAgentRuntimeTrigger(
			context({
				source: "slash",
				sourceEventId: "trigger_123",
				message: {
					...context().message,
					ts: "synthetic-now",
				},
			}),
			{
				workingDir: "/workspace",
				channelDir: "/workspace/C123",
				prompt: "deploy",
				config: config(),
			},
		);

		expect(trigger?.sourceEventId).toBe("trigger_123");
		expect(trigger?.idempotencyKey).toBe(
			"maestro-slack:workspace_evalops:C123:slash:trigger_123",
		);
	});
});

describe("recordSlackAgentRuntimeTrigger", () => {
	it("posts the normalized trigger and returns the Platform run id", async () => {
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				expect(body.trigger).toMatchObject({
					workspaceId: "workspace_evalops",
					channelId: "C123",
				});
				return new Response(
					JSON.stringify({
						run: { id: "run_platform" },
						idempotentReplay: false,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		) as unknown as typeof fetch;

		const result = await recordSlackAgentRuntimeTrigger(context(), {
			workingDir: "/workspace",
			channelDir: "/workspace/C123",
			prompt: "investigate",
			config: config(fetchImpl),
		});

		expect(result).toEqual({
			runId: "run_platform",
			idempotentReplay: false,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://platform.example/agentruntime.v1.AgentRuntimeService/HandleTrigger",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer token",
					"Connect-Protocol-Version": "1",
					"X-Organization-ID": "org_evalops",
				}),
			}),
		);
	});
});
