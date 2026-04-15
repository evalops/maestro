/**
 * Tests for ComposerMessage component
 */

import { fixture, html } from "@open-wc/testing";
import { assert, beforeEach, describe, it } from "vitest";
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
		assert.equal(avatar?.textContent, "C");

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

	it("renders a sandboxed preview for ```html fenced blocks", async () => {
		element = await fixture(
			html`<composer-message
				role="assistant"
				content="\`\`\`html\n<!doctype html><html><body><h1>Hi</h1></body></html>\n\`\`\`"
			></composer-message>`,
		);
		await element.updateComplete;

		const toggle = element.shadowRoot?.querySelector(
			".artifact-toggle",
		) as HTMLButtonElement | null;
		assert.ok(toggle);
		assert.include(toggle?.textContent || "", "Preview");

		toggle?.click();
		await element.updateComplete;

		const sandbox = element.shadowRoot?.querySelector(
			"composer-sandboxed-iframe",
		) as HTMLElement | null;
		assert.ok(sandbox);

		const iframe = sandbox?.shadowRoot?.querySelector("iframe");
		assert.ok(iframe);
		assert.include(iframe?.getAttribute("sandbox") || "", "allow-scripts");
	});

	it("renders attachments on user messages and emits open-attachment", async () => {
		const attachment = {
			id: "att1",
			type: "image" as const,
			fileName: "x.png",
			mimeType: "image/png",
			size: 1,
			content: "AA==",
		};

		element = await fixture(
			html`<composer-message
				role="user"
				content="here"
				.attachments=${[attachment]}
			></composer-message>`,
		);
		await element.updateComplete;

		const tile = element.shadowRoot?.querySelector(
			".attachment",
		) as HTMLElement | null;
		assert.ok(tile);

		const got = new Promise<unknown>((resolve) => {
			element.addEventListener("open-attachment", (e) => resolve(e), {
				once: true,
			});
		});

		tile?.click();
		const event = await got;
		assert.ok(event);
	});
});
