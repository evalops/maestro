// @vitest-environment happy-dom
import { isComposerMessage } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import type {
	AssistantMessage,
	ToolCall,
	UserMessage,
} from "../../src/agent/types.js";
import { convertAppMessagesToComposer } from "../../src/server/session-serialization.js";
import "../../packages/web/src/components/composer-message.js";

describe("AI -> server -> web render integration", () => {
	it("renders a serialized assistant message with thinking and tools", async () => {
		const user: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Read README" }],
			timestamp: Date.now(),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "read",
			arguments: { path: "README.md" },
		};

		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Locate README" },
				{ type: "text", text: "On it." },
				toolCall,
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const [userMsg, assistantMsg] = convertAppMessagesToComposer([
			user,
			assistant,
		]);

		expect(isComposerMessage(userMsg)).toBe(true);
		expect(isComposerMessage(assistantMsg)).toBe(true);

		const el = document.createElement("composer-message") as HTMLElement & {
			role: string;
			content: string | unknown[];
			thinking?: string;
			tools?: unknown[];
		};

		el.role = assistantMsg.role;
		el.content = assistantMsg.content;
		el.thinking = assistantMsg.thinking ?? "";
		el.tools = assistantMsg.tools ?? [];

		document.body.appendChild(el);

		// Wait for Lit to render.
		await (el as { updateComplete?: Promise<void> }).updateComplete;

		const root = el.shadowRoot;
		expect(root?.textContent).toContain("On it.");
		expect(root?.querySelector("composer-thinking")).toBeTruthy();
		expect(root?.querySelectorAll("composer-tool-execution").length).toBe(1);
	});
});
