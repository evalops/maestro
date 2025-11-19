/**
 * Tests for ComposerMessage component
 */

import { assert, describe, it, beforeEach } from "vitest";
import { fixture, html } from "@open-wc/testing";
import "./composer-message.js";
import type { ComposerMessage } from "./composer-message.js";

describe("ComposerMessage", () => {
	let element: ComposerMessage;

	beforeEach(async () => {
		element = await fixture(html`<composer-message></composer-message>`);
	});

	it("renders with default properties", () => {
		assert.ok(element);
		assert.equal(element.role, "user");
		assert.equal(element.content, "");
	});

	it("displays user message correctly", async () => {
		element = await fixture(
			html`<composer-message role="user" content="Hello!"></composer-message>`,
		);
		await element.updateComplete;

		const message = element.shadowRoot?.querySelector(".message");
		assert.ok(message?.classList.contains("user"));

		const avatar = element.shadowRoot?.querySelector(".avatar");
		assert.equal(avatar?.textContent, "U");

		const bubble = element.shadowRoot?.querySelector(".bubble");
		assert.include(bubble?.textContent || "", "Hello!");
	});

	it("displays assistant message correctly", async () => {
		element = await fixture(
			html`<composer-message role="assistant" content="Hi there!"></composer-message>`,
		);
		await element.updateComplete;

		const message = element.shadowRoot?.querySelector(".message");
		assert.ok(message?.classList.contains("assistant"));

		const avatar = element.shadowRoot?.querySelector(".avatar");
		assert.equal(avatar?.textContent, "A");

		const bubble = element.shadowRoot?.querySelector(".bubble");
		assert.include(bubble?.textContent || "", "Hi there!");
	});

	it("renders markdown for assistant messages", async () => {
		element = await fixture(
			html`<composer-message role="assistant" content="**Bold text**"></composer-message>`,
		);
		await element.updateComplete;

		const bubble = element.shadowRoot?.querySelector(".bubble");
		const strong = bubble?.querySelector("strong");
		assert.ok(strong);
		assert.equal(strong?.textContent, "Bold text");
	});

	it("does not render markdown for user messages", async () => {
		element = await fixture(
			html`<composer-message role="user" content="**Not bold**"></composer-message>`,
		);
		await element.updateComplete;

		const bubble = element.shadowRoot?.querySelector(".bubble");
		assert.include(bubble?.textContent || "", "**Not bold**");
		assert.notOk(bubble?.querySelector("strong"));
	});

	it("displays timestamp when provided", async () => {
		const timestamp = new Date().toISOString();
		element = await fixture(
			html`<composer-message content="Test" timestamp="${timestamp}"></composer-message>`,
		);
		await element.updateComplete;

		const timestampEl = element.shadowRoot?.querySelector(".timestamp");
		assert.ok(timestampEl);
		assert.ok(timestampEl?.textContent?.length);
	});

	it("sanitizes HTML to prevent XSS", async () => {
		element = await fixture(
			html`<composer-message 
				role="assistant" 
				content="<script>alert('xss')</script>Safe text"
			></composer-message>`,
		);
		await element.updateComplete;

		const bubble = element.shadowRoot?.querySelector(".bubble");
		assert.notOk(bubble?.querySelector("script"));
		assert.include(bubble?.textContent || "", "Safe text");
	});

	it("renders code blocks with syntax highlighting", async () => {
		element = await fixture(
			html`<composer-message 
				role="assistant" 
				content="\`\`\`javascript\nconst x = 1;\n\`\`\`"
			></composer-message>`,
		);
		await element.updateComplete;

		const bubble = element.shadowRoot?.querySelector(".bubble");
		const pre = bubble?.querySelector("pre");
		const code = pre?.querySelector("code");
		assert.ok(pre);
		assert.ok(code);
		assert.include(code?.textContent || "", "const x = 1;");
	});
});
