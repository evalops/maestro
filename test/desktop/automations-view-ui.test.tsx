// @vitest-environment happy-dom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../packages/desktop/src/renderer/hooks/useAutomations", () => ({
	useAutomations: vi.fn(),
}));

vi.mock("../../packages/desktop/src/renderer/lib/api-client", () => ({
	apiClient: {
		getBackgroundStatus: vi.fn(),
		getMagicDocsAutomationTemplate: vi.fn(),
		previewAutomation: vi.fn(),
	},
}));

import { AutomationsView } from "../../packages/desktop/src/renderer/components/Automations/AutomationsView";
import { useAutomations } from "../../packages/desktop/src/renderer/hooks/useAutomations";
import { apiClient } from "../../packages/desktop/src/renderer/lib/api-client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index += 1) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("AutomationsView UI", () => {
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

	it("applies the Magic Docs template with discovered context files", async () => {
		vi.mocked(useAutomations).mockReturnValue({
			automations: [],
			loading: false,
			refreshAutomations: vi.fn().mockResolvedValue(undefined),
			createAutomation: vi.fn().mockResolvedValue(null),
			updateAutomation: vi.fn().mockResolvedValue(null),
			deleteAutomation: vi.fn().mockResolvedValue(undefined),
			runAutomation: vi.fn().mockResolvedValue(null),
		});
		vi.mocked(apiClient.getBackgroundStatus).mockResolvedValue({
			settings: {
				notificationsEnabled: false,
			},
			snapshot: null,
		});
		vi.mocked(apiClient.getMagicDocsAutomationTemplate).mockResolvedValue({
			magicDocs: [
				{
					path: "docs/architecture.md",
					title: "Architecture",
				},
				{
					path: "docs/release.md",
					title: "Release Notes",
					instructions: "Keep this ready for release managers.",
				},
			],
			template: {
				name: "Magic Docs Sync",
				prompt: "Update the selected Magic Docs.",
				contextPaths: ["docs/architecture.md", "docs/release.md"],
			},
		});
		vi.mocked(apiClient.previewAutomation).mockResolvedValue({
			nextRun: "2026-04-08T17:00:00.000Z",
			timezone: "UTC",
			timezoneValid: true,
		});

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root.render(
				createElement(AutomationsView, {
					sessions: [],
					currentSessionId: null,
					models: [],
					currentModel: null,
					onOpenSession: vi.fn(),
				}),
			);
			await flushAsyncWork(4);
		});

		const applyButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Magic Docs Sync"),
		);
		expect(applyButton).toBeDefined();

		await act(async () => {
			applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flushAsyncWork(4);
		});

		expect(apiClient.getMagicDocsAutomationTemplate).toHaveBeenCalled();
		const nameInput = container.querySelector(
			"#automation-name",
		) as HTMLInputElement | null;
		const promptInput = container.querySelector(
			"#automation-prompt",
		) as HTMLTextAreaElement | null;
		expect(nameInput?.value).toBe("Magic Docs Sync");
		expect(promptInput?.value).toContain("Update the selected Magic Docs");
		expect(container.textContent ?? "").toContain("2 files · 0 folders");
	});
});
