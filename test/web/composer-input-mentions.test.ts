// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../packages/web/src/components/composer-input.js";

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("composer-input mention lookup", () => {
	it("shows a loading state while file mentions are loading", async () => {
		const deferred = createDeferred<string[]>();
		const el = document.createElement("composer-input") as HTMLElement & {
			apiClient: {
				getFiles: ReturnType<typeof vi.fn>;
			};
			updateComplete?: Promise<void>;
		};

		el.apiClient = {
			getFiles: vi.fn().mockReturnValue(deferred.promise),
		};

		document.body.appendChild(el);
		await el.updateComplete;

		const textarea = el.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;
		textarea.value = "@rea";
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));

		await expect
			.poll(
				() =>
					el.shadowRoot?.querySelector(".mention-status")?.textContent ?? "",
			)
			.toContain("Loading files");

		deferred.resolve(["README.md", "src/index.ts"]);

		await expect
			.poll(() =>
				Array.from(
					el.shadowRoot?.querySelectorAll(".suggestion-item") ?? [],
				).map((node) => node.textContent?.trim()),
			)
			.toEqual(["README.md"]);
	});

	it("shows an error state when file mentions fail to load", async () => {
		const el = document.createElement("composer-input") as HTMLElement & {
			apiClient: {
				getFiles: ReturnType<typeof vi.fn>;
			};
			updateComplete?: Promise<void>;
		};

		el.apiClient = {
			getFiles: vi.fn().mockRejectedValue(new Error("request failed")),
		};

		document.body.appendChild(el);
		await el.updateComplete;

		const textarea = el.shadowRoot?.querySelector(
			"textarea",
		) as HTMLTextAreaElement;
		textarea.value = "@rea";
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));

		await expect
			.poll(
				() =>
					el.shadowRoot?.querySelector(".mention-status.error")?.textContent ??
					"",
			)
			.toContain("Couldn't load files");
	});
});
