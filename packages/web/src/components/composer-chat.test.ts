/**
 * Tests for ComposerChat component
 */

import { fixture, html } from "@open-wc/testing";
import { assert, beforeEach, describe, it, vi } from "vitest";
import "./composer-chat.js";
import type { ComposerChat } from "./composer-chat.js";

describe("ComposerChat", () => {
	let element: ComposerChat;

	beforeEach(async () => {
		element = await fixture(html`<composer-chat></composer-chat>`);
	});

	it("renders with default properties", () => {
		assert.ok(element);
		assert.equal(element.apiEndpoint, "http://localhost:8080");
		assert.equal(element.model, "claude-sonnet-4-5");
	});

	it("displays header with title", async () => {
		await element.updateComplete;
		const header = element.shadowRoot?.querySelector(".header");
		assert.ok(header);
		const title = header?.querySelector("h1");
		assert.equal(title?.textContent, "Composer");
	});

	it("accepts custom api endpoint", async () => {
		element = await fixture(
			html`<composer-chat api-endpoint="http://custom.com"></composer-chat>`,
		);
		assert.equal(element.apiEndpoint, "http://custom.com");
	});

	it("accepts custom model", async () => {
		element = await fixture(
			html`<composer-chat model="gpt-4"></composer-chat>`,
		);
		assert.equal(element.model, "gpt-4");
	});

	it("renders messages container", async () => {
		await element.updateComplete;
		const messages = element.shadowRoot?.querySelector(".messages");
		assert.ok(messages);
	});

	it("renders input container", async () => {
		await element.updateComplete;
		const inputContainer =
			element.shadowRoot?.querySelector(".input-container");
		assert.ok(inputContainer);
		const input = inputContainer?.querySelector("composer-input");
		assert.ok(input);
	});

	it("displays error messages", async () => {
		// Simulate error by triggering private state
		(element as unknown as { error: string }).error = "Test error message";
		await element.updateComplete;

		const errorEl = element.shadowRoot?.querySelector(".error");
		assert.ok(errorEl);
		assert.include(errorEl?.textContent || "", "Test error message");
	});

	it("shows loading state", async () => {
		(element as unknown as { loading: boolean }).loading = true;
		await element.updateComplete;

		const loading = element.shadowRoot?.querySelector(".loading");
		assert.ok(loading);
		assert.include(loading?.textContent || "", "Thinking");
	});

	it("displays model info", async () => {
		(element as unknown as { currentModel: string }).currentModel =
			"anthropic/claude-sonnet-4-5";
		await element.updateComplete;

		const modelInfo = element.shadowRoot?.querySelector(".model-info");
		assert.ok(modelInfo);
		assert.include(modelInfo?.textContent || "", "anthropic/claude-sonnet-4-5");
	});

	it("streams thinking deltas into assistant messages", async () => {
		const stream = async function* () {
			yield {
				type: "message_update",
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
			};
			yield {
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "Reasoning summary",
				},
			};
			yield {
				type: "message_update",
				assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
			};
			yield {
				type: "message_end",
				message: { role: "assistant" },
			};
		};

		const apiClient = {
			chatWithEvents: vi.fn().mockReturnValue(stream()),
			getSessions: vi.fn().mockResolvedValue([]),
		};

		(element as unknown as { apiClient: unknown }).apiClient = apiClient;
		(element as unknown as { clientOnline: boolean }).clientOnline = true;

		const event = new CustomEvent("submit", { detail: { text: "Hello" } });
		await (
			element as unknown as { handleSubmit: (e: CustomEvent) => Promise<void> }
		).handleSubmit(event);

		const messages = (
			element as unknown as { messages: Array<{ thinking?: string }> }
		).messages;
		const assistant = messages[messages.length - 1];
		assert.ok(assistant);
		assert.include(assistant?.thinking || "", "Reasoning summary");
	});
});
