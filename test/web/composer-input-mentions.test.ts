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

	it("retries file mentions after a failed file lookup", async () => {
		const el = document.createElement("composer-input") as HTMLElement & {
			apiClient: {
				getFiles: ReturnType<typeof vi.fn>;
			};
			updateComplete?: Promise<void>;
		};

		el.apiClient = {
			getFiles: vi
				.fn()
				.mockRejectedValueOnce(new Error("request failed"))
				.mockResolvedValueOnce(["README.md", "src/index.ts"]),
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

		expect(el.apiClient.getFiles).toHaveBeenCalledTimes(1);

		textarea.value = "@read";
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));

		await expect
			.poll(() =>
				Array.from(
					el.shadowRoot?.querySelectorAll(".suggestion-item") ?? [],
				).map((node) => node.textContent?.trim()),
			)
			.toEqual(["README.md"]);

		expect(el.apiClient.getFiles).toHaveBeenCalledTimes(2);
	});

	it("loads MCP tools into the picker and inserts the canonical tool mention", async () => {
		const el = document.createElement("composer-input") as HTMLElement & {
			apiClient: {
				getFiles: ReturnType<typeof vi.fn>;
				getMcpStatus: ReturnType<typeof vi.fn>;
			};
			updateComplete?: Promise<void>;
		};

		el.apiClient = {
			getFiles: vi.fn().mockResolvedValue([]),
			getMcpStatus: vi.fn().mockResolvedValue({
				servers: [
					{
						name: "github",
						connected: true,
						scope: "project",
						transport: "http",
						tools: [{ name: "search", description: "Search repository code" }],
						resources: [],
						prompts: [],
					},
				],
			}),
		};

		document.body.appendChild(el);
		await el.updateComplete;

		const button = el.shadowRoot?.querySelector(
			".mcp-button",
		) as HTMLButtonElement;
		button.click();

		await expect
			.poll(
				() =>
					el.shadowRoot
						?.querySelector(".suggestion-label")
						?.textContent?.trim() ?? "",
			)
			.toBe("github/search");

		expect(
			el.shadowRoot?.querySelector(".suggestion-badge")?.textContent?.trim(),
		).toBe("project");

		const suggestion = el.shadowRoot?.querySelector(
			".suggestion-item",
		) as HTMLDivElement;
		suggestion.click();

		await expect
			.poll(
				() =>
					(
						el.shadowRoot?.querySelector(
							"textarea",
						) as HTMLTextAreaElement | null
					)?.value ?? "",
			)
			.toBe("@mcp__github__search ");
	});

	it("shows an MCP picker error when tool status cannot be loaded", async () => {
		const el = document.createElement("composer-input") as HTMLElement & {
			apiClient: {
				getFiles: ReturnType<typeof vi.fn>;
				getMcpStatus: ReturnType<typeof vi.fn>;
			};
			updateComplete?: Promise<void>;
		};

		el.apiClient = {
			getFiles: vi.fn().mockResolvedValue([]),
			getMcpStatus: vi.fn().mockRejectedValue(new Error("mcp unavailable")),
		};

		document.body.appendChild(el);
		await el.updateComplete;

		const button = el.shadowRoot?.querySelector(
			".mcp-button",
		) as HTMLButtonElement;
		button.click();

		await expect
			.poll(
				() =>
					el.shadowRoot
						?.querySelector(".suggestion-empty")
						?.textContent?.trim() ?? "",
			)
			.toContain("mcp unavailable");
	});
});
