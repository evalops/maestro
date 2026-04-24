// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/composer-user-input.js";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("composer-user-input", () => {
	it("renders queue status and structured choices", async () => {
		const el = document.createElement("composer-user-input") as HTMLElement & {
			request: {
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
				kind: "user_input";
				pendingRequest?: Record<string, unknown>;
			};
			queueLength: number;
			updateComplete?: Promise<void>;
		};

		el.request = {
			toolCallId: "call-user-input-1",
			toolName: "ask_user",
			kind: "user_input",
			args: {
				questions: [
					{
						header: "Stack",
						question: "Which schema library should we use?",
						options: [
							{
								label: "Zod",
								description: "Use Zod schemas",
								preview: {
									kind: "diff",
									title: "Zod patch",
									body: 'diff --git a/package.json b/package.json\n+"zod": "latest"',
								},
							},
							{
								label: "Valibot",
								description: "Use Valibot schemas",
							},
						],
					},
				],
			},
			pendingRequest: {
				source: "platform",
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
			},
		};
		el.queueLength = 2;

		document.body.appendChild(el);
		await el.updateComplete;

		const text = (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("Input 1 of 2");
		expect(text).toContain("1 more input request waiting");
		expect(text).toContain(
			"1 more input request waiting behind this one. \u2022 Platform wait",
		);
		expect(text).toContain("Platform wait");
		expect(text).toContain("Expires");
		expect(text).toContain("Which schema library should we use?");
		expect(text).toContain("Zod patch");
		expect(text).toContain("diff --git a/package.json b/package.json");
		expect(text).toContain("Other");
	});

	it("emits a submit-response event for selected options", async () => {
		const el = document.createElement("composer-user-input") as HTMLElement & {
			request: {
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
				kind: "user_input";
			};
			updateComplete?: Promise<void>;
		};

		el.request = {
			toolCallId: "call-user-input-1",
			toolName: "ask_user",
			kind: "user_input",
			args: {
				questions: [
					{
						header: "Stack",
						question: "Which schema library should we use?",
						options: [
							{
								label: "Zod",
								description: "Use Zod schemas",
							},
							{
								label: "Valibot",
								description: "Use Valibot schemas",
							},
						],
					},
				],
			},
		};

		const submit = vi.fn();
		el.addEventListener("submit-response", submit as EventListener);
		document.body.appendChild(el);
		await el.updateComplete;

		const firstOption = el.shadowRoot?.querySelector(
			'input[data-question-index="0"][data-option-index="0"]',
		) as HTMLInputElement | null;
		expect(firstOption).not.toBeNull();
		firstOption?.click();

		const submitButton = el.shadowRoot?.querySelector(
			".btn-submit",
		) as HTMLButtonElement | null;
		submitButton?.click();

		expect(submit).toHaveBeenCalledTimes(1);
		expect(submit.mock.calls[0]?.[0]).toMatchObject({
			detail: {
				toolCallId: "call-user-input-1",
				responseText: "Zod",
			},
		});
	});

	it('preserves typed "Other" text when switching back to a standard option', async () => {
		const el = document.createElement("composer-user-input") as HTMLElement & {
			request: {
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
				kind: "user_input";
			};
			updateComplete?: Promise<void>;
		};

		el.request = {
			toolCallId: "call-user-input-2",
			toolName: "ask_user",
			kind: "user_input",
			args: {
				questions: [
					{
						header: "Stack",
						question: "Which schema library should we use?",
						options: [
							{
								label: "Zod",
								description: "Use Zod schemas",
							},
							{
								label: "Valibot",
								description: "Use Valibot schemas",
							},
						],
					},
				],
			},
		};

		document.body.appendChild(el);
		await el.updateComplete;

		const otherOption = el.shadowRoot?.querySelector(
			'input[data-question-index="0"][data-option-index="other"]',
		) as HTMLInputElement | null;
		expect(otherOption).not.toBeNull();
		otherOption?.click();
		await el.updateComplete;

		const otherInput = el.shadowRoot?.querySelector(
			'input.other-input[data-question-index="0"]',
		) as HTMLInputElement | null;
		expect(otherInput).not.toBeNull();
		otherInput!.value = "Custom schema";
		otherInput?.dispatchEvent(new Event("input", { bubbles: true }));
		await el.updateComplete;

		const firstOption = el.shadowRoot?.querySelector(
			'input[data-question-index="0"][data-option-index="0"]',
		) as HTMLInputElement | null;
		firstOption?.click();
		await el.updateComplete;

		otherOption?.click();
		await el.updateComplete;

		const restoredOtherInput = el.shadowRoot?.querySelector(
			'input.other-input[data-question-index="0"]',
		) as HTMLInputElement | null;
		expect(restoredOtherInput?.value).toBe("Custom schema");
	});

	it("ignores malformed option preview payloads", async () => {
		const el = document.createElement("composer-user-input") as HTMLElement & {
			request: {
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
				kind: "user_input";
			};
			updateComplete?: Promise<void>;
		};

		el.request = {
			toolCallId: "call-user-input-3",
			toolName: "ask_user",
			kind: "user_input",
			args: {
				questions: [
					{
						header: "Stack",
						question: "Which schema library should we use?",
						options: [
							{
								label: "Zod",
								description: "Use Zod schemas",
								preview: {
									kind: "html",
									title: "Unsupported",
									body: "<div>raw html</div>",
								},
							},
							{
								label: "Valibot",
								description: "Use Valibot schemas",
							},
						],
					},
				],
			},
		};

		document.body.appendChild(el);
		await el.updateComplete;

		const text = (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("Zod");
		expect(text).not.toContain("raw html");
		expect(el.shadowRoot?.querySelector(".option-preview")).toBeNull();
	});
});
