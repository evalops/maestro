/**
 * Tests for ComposerInput component
 */

import { fixture, html, oneEvent } from "@open-wc/testing";
import { assert, beforeEach, describe, it } from "vitest";
import "./composer-input.js";
import type { ComposerInput } from "./composer-input.js";

describe("ComposerInput", () => {
	let element: ComposerInput;

	beforeEach(async () => {
		element = await fixture(html`<composer-input></composer-input>`);
	});

	it("renders with default properties", () => {
		assert.ok(element);
		assert.equal(element.disabled, false);
	});

	it("renders textarea and button", async () => {
		await element.updateComplete;
		const textarea = element.shadowRoot?.querySelector("textarea");
		const button = element.shadowRoot?.querySelector("button");
		assert.ok(textarea);
		assert.ok(button);
	});

	it("displays hint text", async () => {
		await element.updateComplete;
		const hint = element.shadowRoot?.querySelector(".hint");
		assert.ok(hint);
		assert.include(hint?.textContent || "", "Enter");
	});

	it("can be disabled", async () => {
		element = await fixture(html`<composer-input disabled></composer-input>`);
		await element.updateComplete;

		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;
		const button = element.shadowRoot?.querySelector(
			"button",
		) as HTMLButtonElement;
		assert.ok(textarea?.disabled);
		assert.ok(button?.disabled);
	});

	it("updates internal value on input", async () => {
		await element.updateComplete;
		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;

		textarea.value = "Hello";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await element.updateComplete;

		assert.equal((element as unknown as { value: string }).value, "Hello");
	});

	it("dispatches submit event on button click", async () => {
		await element.updateComplete;
		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;
		const button = element.shadowRoot?.querySelector(
			"button",
		) as HTMLButtonElement;

		// Set value
		textarea.value = "Test message";
		textarea.dispatchEvent(new Event("input"));
		await element.updateComplete;

		// Click button and wait for event
		setTimeout(() => button.click());
		const event = (await oneEvent(element, "submit")) as CustomEvent;

		assert.equal(event.detail.text, "Test message");
	});

	it("dispatches submit event on Enter key", async () => {
		await element.updateComplete;
		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;

		textarea.value = "Enter message";
		textarea.dispatchEvent(new Event("input"));
		await element.updateComplete;

		// Simulate Enter key
		const enterEvent = new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		});

		setTimeout(() => textarea.dispatchEvent(enterEvent));
		const event = (await oneEvent(element, "submit")) as CustomEvent;

		assert.equal(event.detail.text, "Enter message");
	});

	it("does not submit on Shift+Enter", async () => {
		await element.updateComplete;
		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;

		textarea.value = "Multiline\n";
		textarea.dispatchEvent(new Event("input"));

		const shiftEnterEvent = new KeyboardEvent("keydown", {
			key: "Enter",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		let submitted = false;
		element.addEventListener("submit", () => {
			submitted = true;
		});

		textarea.dispatchEvent(shiftEnterEvent);
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(submitted, false);
	});

	it("clears input after submit", async () => {
		await element.updateComplete;
		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;
		const button = element.shadowRoot?.querySelector(
			"button",
		) as HTMLButtonElement;

		textarea.value = "Clear this";
		textarea.dispatchEvent(new Event("input"));
		await element.updateComplete;

		button.click();
		await element.updateComplete;

		assert.equal((element as unknown as { value: string }).value, "");
		assert.equal(textarea.value, "");
	});

	it("does not submit empty messages", async () => {
		await element.updateComplete;
		const button = element.shadowRoot?.querySelector(
			"button",
		) as HTMLButtonElement;

		let submitted = false;
		element.addEventListener("submit", () => {
			submitted = true;
		});

		button.click();
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(submitted, false);
	});

	it("trims whitespace from messages", async () => {
		await element.updateComplete;
		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;
		const button = element.shadowRoot?.querySelector(
			"button",
		) as HTMLButtonElement;

		textarea.value = "  spaces  ";
		textarea.dispatchEvent(new Event("input"));
		await element.updateComplete;

		setTimeout(() => button.click());
		const event = (await oneEvent(element, "submit")) as CustomEvent;

		assert.equal(event.detail.text, "spaces");
	});

	it("renders a prompt suggestion and inserts it when used", async () => {
		element.promptSuggestion = "Add a regression test for this flow";
		await element.updateComplete;

		const suggestion = element.shadowRoot?.querySelector(
			".prompt-suggestion-text",
		);
		const useButton = Array.from(
			element.shadowRoot?.querySelectorAll(
				".prompt-suggestion-actions button",
			) ?? [],
		).find((button) => button.textContent?.includes("Use")) as
			| HTMLButtonElement
			| undefined;

		assert.ok(suggestion);
		assert.include(
			suggestion?.textContent || "",
			"Add a regression test for this flow",
		);
		assert.ok(useButton);

		useButton?.click();
		await element.updateComplete;

		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;
		assert.equal(textarea.value, "Add a regression test for this flow");
	});

	it("hides the prompt suggestion once the user starts typing", async () => {
		element.promptSuggestion = "Add a regression test for this flow";
		await element.updateComplete;

		const textarea = element.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;
		textarea.value = "Working on it";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await element.updateComplete;

		assert.notOk(element.shadowRoot?.querySelector(".prompt-suggestion"));
	});
});
