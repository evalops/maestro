// @vitest-environment happy-dom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { InputArea } from "../../packages/desktop/src/renderer/components/Chat/InputArea";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("desktop input area prompt suggestion", () => {
	let container: HTMLDivElement | null = null;
	let root: Root | null = null;

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root?.unmount();
			});
		}
		container?.remove();
		root = null;
		container = null;
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
	});
});
