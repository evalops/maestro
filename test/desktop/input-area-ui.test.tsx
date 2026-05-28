// @vitest-environment happy-dom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputArea } from "../../packages/desktop/src/renderer/components/Chat/InputArea";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("desktop input area prompt suggestion", () => {
	let container: HTMLDivElement | null = null;
	let root: Root | null = null;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as typeof fetch;
	});

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root?.unmount();
			});
		}
		container?.remove();
		root = null;
		container = null;
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("fills the textarea when a suggestion is accepted", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(
				createElement(InputArea, {
					onSend: () => {},
					promptSuggestion: "Add a regression test for the desktop flow",
				}),
			);
			await flushAsyncWork();
		});

		const useButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Use",
		) as HTMLButtonElement | undefined;
		expect(useButton).toBeTruthy();

		await act(async () => {
			useButton?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
			await flushAsyncWork();
		});

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.value).toBe("Add a regression test for the desktop flow");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
