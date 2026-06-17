import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentEvent,
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
} from "../../src/agent/types.js";

const providerStreamMock = vi.hoisted(() => ({
	createProviderStream: vi.fn(),
}));

const metadataCacheMock = vi.hoisted(() => ({
	hiddenToolNames: new Set<string>(),
}));

vi.mock("../../src/agent/transport/create-provider-stream.js", () => ({
	createProviderStream: providerStreamMock.createProviderStream,
}));

vi.mock("../../src/agent/transport/reusable-tool-results.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/agent/transport/reusable-tool-results.js")
	>("../../src/agent/transport/reusable-tool-results.js");

	return {
		...actual,
		createToolMetadataCache(
			tools: AgentTool[],
			reusableToolResultCwd = process.cwd(),
		) {
			const cache = actual.createToolMetadataCache(
				tools,
				reusableToolResultCwd,
			);
			const definitions = new Map(
				[...cache.definitions].filter(
					([toolName]) => !metadataCacheMock.hiddenToolNames.has(toolName),
				),
			);
			return {
				...cache,
				definitions,
				get(toolName: string) {
					this.lookupCount += 1;
					return definitions.get(toolName);
				},
			};
		},
	};
});

const { ProviderTransport } = await import("../../src/agent/transport.js");

const model: Model<"openai-codex-app-server"> = {
	id: "gpt-5.5",
	name: "GPT-5.5 (Codex)",
	api: "openai-codex-app-server",
	provider: "openai-codex",
	baseUrl: "codex-app-server://local",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

function assistantMessage(
	content: AssistantMessage["content"] = [],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-codex-app-server",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of iterable) {
		events.push(event);
	}
	return events;
}

afterEach(() => {
	metadataCacheMock.hiddenToolNames.clear();
	providerStreamMock.createProviderStream.mockReset();
});

describe("ProviderTransport parallelism gate telemetry", () => {
	it("includes pending mutators hidden from the tool metadata cache", async () => {
		metadataCacheMock.hiddenToolNames.add("hidden_path_write");

		const hiddenPathWriteTool: AgentTool = {
			name: "hidden_path_write",
			description: "Path-scoped mutation whose cache entry is hidden.",
			parameters: Type.Object({ path: Type.String() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (_toolCallId, args) => {
				await sleep(40);
				return {
					content: [{ type: "text", text: `hidden:${String(args.path)}` }],
				};
			},
		};

		const visiblePathWriteTool: AgentTool = {
			name: "visible_path_write",
			description: "Path-scoped mutation probe.",
			parameters: Type.Object({ path: Type.String() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				pathScopedMutationHint: true,
			},
			execute: async (_toolCallId, args) => ({
				content: [{ type: "text", text: `path:${String(args.path)}` }],
			}),
		};

		let streamCount = 0;
		providerStreamMock.createProviderStream.mockImplementation(
			async function* () {
				streamCount += 1;
				if (streamCount === 1) {
					const assistant = assistantMessage([], "toolUse");
					yield {
						type: "start",
						partial: assistant,
					} satisfies AssistantMessageEvent;
					for (const toolCall of [
						{
							id: "hidden-1",
							name: "hidden_path_write",
							arguments: { path: "src/shared.ts" },
						},
						{
							id: "path-2",
							name: "visible_path_write",
							arguments: { path: "src/shared.ts" },
						},
					]) {
						yield {
							type: "toolcall_end",
							toolCall: {
								type: "toolCall",
								...toolCall,
							},
							partial: assistant,
						} satisfies AssistantMessageEvent;
					}
					yield {
						type: "done",
						reason: "toolUse",
						message: assistant,
					} satisfies AssistantMessageEvent;
					return;
				}

				const assistant = assistantMessage(
					[{ type: "text", text: "telemetry captured" }],
					"stop",
				);
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "done",
					reason: "stop",
					message: assistant,
				} satisfies AssistantMessageEvent;
			},
		);

		const userMessage: Message = {
			role: "user",
			content: "Capture gate telemetry for hidden mutators.",
			timestamp: Date.now(),
		};

		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [hiddenPathWriteTool, visiblePathWriteTool],
				model,
			}),
		);

		const gatedEvent = events.find(
			(event): event is Extract<AgentEvent, { type: "parallelism_gated" }> =>
				event.type === "parallelism_gated",
		);

		expect(gatedEvent).toMatchObject({
			type: "parallelism_gated",
			toolCallId: "path-2",
			toolName: "visible_path_write",
			reason: "mutation_scope_overlap",
			pendingMutations: 1,
			pendingToolCallIds: ["hidden-1"],
			pendingToolNames: ["hidden_path_write"],
			pathArgumentKeys: ["path"],
			pathScope: [resolve(process.cwd(), "src/shared.ts").toLowerCase()],
		});
	});
});
