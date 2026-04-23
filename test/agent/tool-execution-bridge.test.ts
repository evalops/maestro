import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionApprovalDecision } from "../../src/agent/action-approval.js";
import { DefaultPlatformToolExecutionBridge } from "../../src/agent/transport/tool-execution-bridge.js";
import type {
	AgentRunConfig,
	AgentTool,
	ToolCall,
	ToolResultMessage,
} from "../../src/agent/types.js";
import {
	MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG,
	MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
	resetFeatureFlagCacheForTests,
} from "../../src/config/feature-flags.js";

type CapturedRequest = {
	body?: Record<string, unknown>;
	headers: Record<string, string>;
	method?: string;
	pathname: string;
	url: string;
};

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	return Object.fromEntries(new Headers(headers).entries());
}

function parseRequestBody(
	body: BodyInit | null | undefined,
): Record<string, unknown> | undefined {
	return typeof body === "string"
		? (JSON.parse(body) as Record<string, unknown>)
		: undefined;
}

function writeFlags(keys: string[]): string {
	const path = join(
		tmpdir(),
		`maestro-tool-bridge-flags-${Date.now()}-${Math.random()}.json`,
	);
	writeFileSync(
		path,
		JSON.stringify({
			flags: keys.map((key) => ({ key, enabled: true })),
		}),
	);
	return path;
}

function baseConfig(): AgentRunConfig {
	return {
		systemPrompt: "",
		tools: [],
		model: {} as AgentRunConfig["model"],
		session: {
			id: "sess_1",
			startedAt: new Date("2026-04-23T15:00:00Z"),
		},
		user: {
			id: "user_1",
			orgId: "org_evalops",
		},
	};
}

const okResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "tc_1",
	toolName: "bash",
	content: [{ type: "text", text: "git status clean" }],
	isError: false,
	timestamp: Date.now(),
};

describe("tool execution bridge", () => {
	let requests: CapturedRequest[];

	beforeEach(() => {
		requests = [];
		vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "https://platform.test/");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "evalops-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_evalops");
		vi.stubEnv("MAESTRO_REMOTE_RUNNER_WORKSPACE_ID", "ws_evalops");
		vi.stubEnv("MAESTRO_AGENT_RUN_ID", "run_1");
		vi.stubEnv("MAESTRO_AGENT_ID", "maestro");
		vi.stubEnv("MAESTRO_SURFACE", "cli");
		vi.stubEnv("MAESTRO_SESSION_ID", "sess_1");
		vi.stubEnv("MAESTRO_REMOTE_RUNNER_SESSION_ID", "rrs_1");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		resetFeatureFlagCacheForTests();
	});

	it("records observe-only bash executions after local completion", async () => {
		process.env.EVALOPS_FEATURE_FLAGS_PATH = writeFlags([
			MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG,
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				requests.push({
					body: parseRequestBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				});
				return new Response(
					JSON.stringify({
						execution: {
							id: "texec_observe_1",
							state: "TOOL_EXECUTION_STATE_SUCCEEDED",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const bridge = new DefaultPlatformToolExecutionBridge();
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tc_1",
			name: "bash",
			arguments: { command: "git status" },
		};

		const prepared = await bridge.prepare({
			cfg: baseConfig(),
			toolCall,
			sanitizedArgs: { command: "git status" },
		});

		expect(prepared).toMatchObject({ status: "observe" });
		if (prepared.status !== "observe") {
			throw new Error("expected observe plan");
		}

		await expect(
			bridge.recordObservation(prepared.plan, okResult),
		).resolves.toEqual({
			metadata: {
				toolExecutionId: "texec_observe_1",
				approvalRequestId: undefined,
			},
		});

		expect(requests[0]).toMatchObject({
			url: "https://platform.test/toolexecution.v1.ToolExecutionService/ExecuteTool",
			body: expect.objectContaining({
				metadata: expect.objectContaining({
					maestro_bridge_mode: "observe",
					maestro_local_outcome: "succeeded",
					maestro_local_output_summary: "git status clean",
				}),
				tool: expect.objectContaining({
					name: "bash",
					namespace: "maestro",
				}),
			}),
		});
	});

	it("skips the bridge when no Platform destination is configured", async () => {
		process.env.EVALOPS_FEATURE_FLAGS_PATH = writeFlags([
			MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
		]);
		vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "");
		vi.stubGlobal("fetch", vi.fn());

		const bridge = new DefaultPlatformToolExecutionBridge();
		await expect(
			bridge.prepare({
				cfg: baseConfig(),
				toolCall: {
					type: "toolCall",
					id: "tc_skip_1",
					name: "bash",
					arguments: { command: "git push" },
				},
				sanitizedArgs: { command: "git push" },
			}),
		).resolves.toEqual({ status: "skip" });

		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps local observe-only execution when Platform recording fails", async () => {
		process.env.EVALOPS_FEATURE_FLAGS_PATH = writeFlags([
			MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG,
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("recording offline");
			}),
		);

		const bridge = new DefaultPlatformToolExecutionBridge();
		const prepared = await bridge.prepare({
			cfg: baseConfig(),
			toolCall: {
				type: "toolCall",
				id: "tc_observe_fail_1",
				name: "bash",
				arguments: { command: "git status" },
			},
			sanitizedArgs: { command: "git status" },
		});

		expect(prepared).toMatchObject({ status: "observe" });
		if (prepared.status !== "observe") {
			throw new Error("expected observe plan");
		}

		await expect(
			bridge.recordObservation(prepared.plan, okResult),
		).resolves.toEqual({
			metadata: {},
		});
	});

	it("governs MCP tool calls when the bridge flag is enabled", async () => {
		process.env.EVALOPS_FEATURE_FLAGS_PATH = writeFlags([
			MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				requests.push({
					body: parseRequestBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				});
				return new Response(
					JSON.stringify({
						execution: {
							id: "texec_mcp_1",
							state: "TOOL_EXECUTION_STATE_SUCCEEDED",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const bridge = new DefaultPlatformToolExecutionBridge();
		const mcpTool: AgentTool = {
			name: "mcp__github__pull_request_merge",
			description: "Merge a pull request",
			parameters: Type.Object({ owner: Type.String(), repo: Type.String() }),
			annotations: {
				destructiveHint: true,
			},
			execute: async () => ({
				content: [{ type: "text", text: "ok" }],
			}),
		};

		const prepared = await bridge.prepare({
			cfg: baseConfig(),
			toolCall: {
				type: "toolCall",
				id: "tc_mcp_1",
				name: mcpTool.name,
				arguments: { owner: "evalops", repo: "platform" },
			},
			toolDef: mcpTool,
			sanitizedArgs: { owner: "evalops", repo: "platform" },
		});

		expect(prepared).toMatchObject({
			status: "allow",
			plan: {
				metadata: {
					toolExecutionId: "texec_mcp_1",
				},
			},
		});
		expect(requests[0]?.body).toMatchObject({
			tool: expect.objectContaining({
				namespace: "mcp",
				name: "pull_request_merge",
				capability: "mcp.github.pull_request_merge",
			}),
			connector: expect.objectContaining({
				providerId: "github",
				resourceKind: "mcp_server",
			}),
		});
	});

	it("waits for approval and resumes governed executions", async () => {
		process.env.EVALOPS_FEATURE_FLAGS_PATH = writeFlags([
			MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				requests.push({
					body: parseRequestBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				});
				if (parsed.pathname.endsWith("/ExecuteTool")) {
					return new Response(
						JSON.stringify({
							execution: {
								id: "texec_wait_1",
								state: "TOOL_EXECUTION_STATE_WAITING_APPROVAL",
								approvalWait: {
									approvalRequestId: "approval_1",
									resumeToken: "resume_1",
									reason: "manager approval required",
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						execution: {
							id: "texec_wait_1",
							state: "TOOL_EXECUTION_STATE_SUCCEEDED",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		const bridge = new DefaultPlatformToolExecutionBridge();
		const prepared = await bridge.prepare({
			cfg: baseConfig(),
			toolCall: {
				type: "toolCall",
				id: "tc_push_1",
				name: "bash",
				arguments: { command: "git push" },
			},
			sanitizedArgs: { command: "git push" },
		});
		expect(prepared).toMatchObject({
			status: "wait_approval",
			request: {
				id: "approval_1",
				reason: "manager approval required",
				platform: {
					source: "tool_execution",
					toolExecutionId: "texec_wait_1",
					approvalRequestId: "approval_1",
				},
			},
		});
		if (prepared.status !== "wait_approval") {
			throw new Error("expected approval wait");
		}

		const decision: ActionApprovalDecision = {
			approved: true,
			reason: "approved in ui",
			resolvedBy: "user",
		};
		await expect(
			bridge.resolveApproval(
				{
					cfg: baseConfig(),
					toolCall: {
						type: "toolCall",
						id: "tc_push_1",
						name: "bash",
						arguments: { command: "git push" },
					},
					sanitizedArgs: { command: "git push" },
				},
				prepared.plan,
				decision,
			),
		).resolves.toMatchObject({
			status: "allow",
			plan: {
				metadata: {
					toolExecutionId: "texec_wait_1",
					approvalRequestId: "approval_1",
				},
			},
		});

		expect(requests[1]?.pathname).toBe(
			"/toolexecution.v1.ToolExecutionService/ResumeToolExecution",
		);
		expect(requests[1]?.body).toMatchObject({
			executionId: "texec_wait_1",
			approvalRequestId: "approval_1",
			resumeToken: "resume_1",
			approved: true,
		});
	});

	it("denies governed executions when Platform rejects them", async () => {
		process.env.EVALOPS_FEATURE_FLAGS_PATH = writeFlags([
			MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							execution: {
								id: "texec_denied_1",
								state: "TOOL_EXECUTION_STATE_DENIED",
								errorMessage: "policy denied tool execution",
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		const bridge = new DefaultPlatformToolExecutionBridge();
		await expect(
			bridge.prepare({
				cfg: baseConfig(),
				toolCall: {
					type: "toolCall",
					id: "tc_denied_1",
					name: "bash",
					arguments: { command: "git push --force" },
				},
				sanitizedArgs: { command: "git push --force" },
			}),
		).resolves.toMatchObject({
			status: "deny",
			reason: "policy denied tool execution",
		});
	});

	it("fails closed for governed executions when Platform is unavailable", async () => {
		process.env.EVALOPS_FEATURE_FLAGS_PATH = writeFlags([
			MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);

		const bridge = new DefaultPlatformToolExecutionBridge();
		await expect(
			bridge.prepare({
				cfg: baseConfig(),
				toolCall: {
					type: "toolCall",
					id: "tc_fail_1",
					name: "bash",
					arguments: { command: "git push" },
				},
				sanitizedArgs: { command: "git push" },
			}),
		).resolves.toMatchObject({
			status: "deny",
			reason: expect.stringContaining("Platform ToolExecution unavailable"),
		});
	});
});
