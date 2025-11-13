import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";

type SubscriptionHandler = (event: any) => void | Promise<void>;

vi.mock("../src/agent/agent.js", async () => {
	class Agent {
		public state: any;
		private subscribers: SubscriptionHandler[] = [];

		constructor(config: any) {
			this.state = {
				...config.initialState,
				messages: [],
			};
		}

		subscribe(handler: SubscriptionHandler) {
			this.subscribers.push(handler);
		}

		async prompt(message: string) {
			this.state.messages.push({
				role: "user",
				content: [{ type: "text", text: message }],
			});

			const assistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `Echo: ${message}` }],
				stopReason: "completed",
			};
			this.state.messages.push(assistantMessage);

			for (const handler of this.subscribers) {
				await handler({ type: "message_end", message: assistantMessage });
			}
		}

		abort() {
			// no-op for tests
		}

		replaceMessages(messages: any[]) {
			this.state.messages = [...messages];
		}

		setModel(model: any) {
			this.state.model = model;
		}

		setThinkingLevel(level: string) {
			this.state.thinkingLevel = level;
		}
	}

	return { Agent };
});

vi.mock("../src/agent/transport.js", () => ({
	ProviderTransport: class ProviderTransport {
		constructor(public readonly options: any) {}
	},
}));

vi.mock("../src/models/builtin.js", () => ({
	getModel: (provider: string, id: string) => ({ provider, id }),
	getProviders: () => ["anthropic"],
	getModels: () => [{ id: "claude-sonnet-4-5", provider: "anthropic" }],
}));

describe("CLI integration", () => {
	const originalEnv = process.env.ANTHROPIC_API_KEY;
	const originalLog = console.log;
	let output: string[];

	beforeEach(() => {
		process.env.ANTHROPIC_API_KEY = "test-key";
		output = [];
		console.log = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
	});

	afterEach(() => {
		console.log = originalLog;
		if (originalEnv === undefined) {
			process.env.ANTHROPIC_API_KEY = undefined;
		} else {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		}
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("emits JSON events in json mode", async () => {
		await main(["--mode", "json", "hello"]);
		expect(output.some((line) => line.includes('"type":"message_end"'))).toBe(
			true,
		);
	});
});
