// @vitest-environment happy-dom
import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySection } from "../../packages/desktop/src/renderer/components/Settings/MemorySection";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function createProps(
	overrides: Partial<ComponentProps<typeof MemorySection>> = {},
): ComponentProps<typeof MemorySection> {
	const now = Date.now();
	return {
		onListMemoryTopics: vi.fn().mockResolvedValue({
			topics: [
				{
					name: "api-design",
					entryCount: 1,
					lastUpdated: now,
				},
			],
		}),
		onListMemoryTopic: vi.fn().mockResolvedValue({
			topic: "api-design",
			memories: [
				{
					id: "mem_topic",
					topic: "api-design",
					content: "Topic-specific memory",
					createdAt: now,
					updatedAt: now,
					tags: ["rest"],
				},
			],
		}),
		onSearchMemory: vi.fn().mockResolvedValue({
			query: "REST",
			results: [
				{
					entry: {
						id: "mem_search",
						topic: "api-design",
						content: "Search result memory",
						createdAt: now,
						updatedAt: now,
						tags: ["rest"],
					},
					score: 4.2,
					matchedOn: "content",
				},
			],
		}),
		onGetRecentMemories: vi.fn().mockResolvedValue({
			memories: [
				{
					id: "mem_recent",
					topic: "general",
					content: "Recent memory",
					createdAt: now,
					updatedAt: now,
					tags: ["note"],
				},
			],
		}),
		onGetMemoryStats: vi.fn().mockResolvedValue({
			stats: {
				totalEntries: 2,
				topics: 2,
				oldestEntry: now - 1_000,
				newestEntry: now,
			},
		}),
		onSaveMemory: vi.fn().mockResolvedValue({
			success: true,
			message: 'Memory saved to topic "api-design"',
			entry: {
				id: "mem_saved",
				topic: "api-design",
				content: "Use REST conventions #rest",
				createdAt: now,
				updatedAt: now,
				tags: ["rest"],
			},
		}),
		onDeleteMemory: vi.fn().mockResolvedValue({
			success: true,
			message: "Memory mem_saved deleted",
		}),
		onClearMemory: vi.fn().mockResolvedValue({
			success: true,
			message: "Cleared 2 memories",
			count: 2,
		}),
		...overrides,
	};
}

describe("MemorySection UI", () => {
	let container: HTMLDivElement | undefined;
	let root: Root | undefined;

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root?.unmount();
				await flushAsyncWork(1);
			});
		}
		container?.remove();
		container = undefined;
		root = undefined;
		vi.restoreAllMocks();
	});

	async function renderSection(
		overrides: Partial<ComponentProps<typeof MemorySection>> = {},
	) {
		const props = createProps(overrides);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(createElement(MemorySection, props));
			await flushAsyncWork(4);
		});

		return { props, container };
	}

	it("loads recent memories and switches to topic-specific entries", async () => {
		const { props, container } = await renderSection();

		expect(props.onListMemoryTopics).toHaveBeenCalledOnce();
		expect(props.onGetMemoryStats).toHaveBeenCalledOnce();
		expect(props.onGetRecentMemories).toHaveBeenCalledWith(12);
		expect(container.textContent ?? "").toContain("Recent memory");
		expect(container.textContent ?? "").toContain("Entries: 2");

		const topicButton = container.querySelector(
			'button[aria-label="Show memories for topic api-design"]',
		) as HTMLButtonElement | null;
		expect(topicButton).not.toBeNull();

		await act(async () => {
			topicButton?.click();
			await flushAsyncWork(3);
		});

		expect(props.onListMemoryTopic).toHaveBeenCalledWith("api-design");
		expect(container.textContent ?? "").toContain("Topic-specific memory");
	});

	it("saves tagged memories and deletes entries from the current view", async () => {
		const { props, container } = await renderSection();
		const topicInput = container.querySelector(
			'input[aria-label="Memory topic"]',
		) as HTMLInputElement | null;
		const contentInput = container.querySelector(
			'textarea[aria-label="Memory content"]',
		) as HTMLTextAreaElement | null;
		const saveButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Save memory",
		) as HTMLButtonElement | undefined;

		expect(topicInput).not.toBeNull();
		expect(contentInput).not.toBeNull();
		expect(saveButton).toBeDefined();

		await act(async () => {
			if (!topicInput || !contentInput) {
				throw new Error("Expected memory inputs");
			}
			topicInput.value = "api-design";
			topicInput.dispatchEvent(new Event("input", { bubbles: true }));
			topicInput.dispatchEvent(new Event("change", { bubbles: true }));
			contentInput.value = "Use REST conventions #rest #rest";
			contentInput.dispatchEvent(new Event("input", { bubbles: true }));
			contentInput.dispatchEvent(new Event("change", { bubbles: true }));
			await flushAsyncWork(1);
		});

		await act(async () => {
			saveButton?.click();
			await flushAsyncWork(4);
		});

		expect(props.onSaveMemory).toHaveBeenCalledWith(
			"api-design",
			"Use REST conventions #rest #rest",
			["rest"],
		);
		expect(container.textContent ?? "").toContain(
			'Memory saved to topic "api-design"',
		);

		const deleteButton = container.querySelector(
			'button[aria-label="Delete memory mem_topic"]',
		) as HTMLButtonElement | null;
		expect(deleteButton).not.toBeNull();

		await act(async () => {
			deleteButton?.click();
			await flushAsyncWork(4);
		});

		expect(props.onDeleteMemory).toHaveBeenCalledWith("mem_topic");
	});

	it("preserves topic casing when save metadata omits the saved entry topic", async () => {
		const props = createProps({
			onSaveMemory: vi.fn().mockResolvedValue({
				success: true,
				message: "",
			}),
			onListMemoryTopic: vi.fn().mockResolvedValue({
				topic: "API-Design",
				memories: [],
			}),
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(createElement(MemorySection, props));
			await flushAsyncWork(4);
		});

		const topicInput = container.querySelector(
			'input[aria-label="Memory topic"]',
		) as HTMLInputElement | null;
		const contentInput = container.querySelector(
			'textarea[aria-label="Memory content"]',
		) as HTMLTextAreaElement | null;
		const saveButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Save memory",
		) as HTMLButtonElement | undefined;

		expect(topicInput).not.toBeNull();
		expect(contentInput).not.toBeNull();
		expect(saveButton).toBeDefined();

		await act(async () => {
			if (!topicInput || !contentInput) {
				throw new Error("Expected memory inputs");
			}
			topicInput.value = "API-Design";
			topicInput.dispatchEvent(new Event("input", { bubbles: true }));
			topicInput.dispatchEvent(new Event("change", { bubbles: true }));
			contentInput.value = "Preserve topic casing #rest";
			contentInput.dispatchEvent(new Event("input", { bubbles: true }));
			contentInput.dispatchEvent(new Event("change", { bubbles: true }));
			await flushAsyncWork(1);
		});

		await act(async () => {
			saveButton?.click();
			await flushAsyncWork(4);
		});

		expect(props.onSaveMemory).toHaveBeenCalledWith(
			"API-Design",
			"Preserve topic casing #rest",
			["rest"],
		);
		expect(props.onListMemoryTopic).toHaveBeenLastCalledWith("API-Design");
		expect(container.textContent ?? "").toContain(
			'Memory saved to topic "API-Design"',
		);
	});
});
