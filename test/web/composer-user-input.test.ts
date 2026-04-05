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
		el.queueLength = 2;

		document.body.appendChild(el);
		await el.updateComplete;

		const text = (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toContain("Input 1 of 2");
		expect(text).toContain("1 more input request waiting");
		expect(text).toContain("Which schema library should we use?");
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
});
