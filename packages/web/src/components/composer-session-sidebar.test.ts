import { afterEach, describe, expect, it } from "vitest";
import "./composer-session-sidebar.js";
import type { ComposerSessionSidebar } from "./composer-session-sidebar.js";

function createSidebar(): ComposerSessionSidebar {
	const element = document.createElement(
		"composer-session-sidebar",
	) as ComposerSessionSidebar;
	document.body.append(element);
	return element;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("ComposerSessionSidebar", () => {
	it("sorts favorites first and filters by tags", async () => {
		const element = createSidebar();
		element.sessions = [
			{
				id: "session-2",
				title: "Later session",
				createdAt: "2026-03-13T00:00:00.000Z",
				updatedAt: "2026-03-13T12:00:00.000Z",
				messageCount: 4,
				favorite: false,
				tags: ["infra"],
			},
			{
				id: "session-1",
				title: "Pinned session",
				createdAt: "2026-03-12T00:00:00.000Z",
				updatedAt: "2026-03-12T12:00:00.000Z",
				messageCount: 2,
				favorite: true,
				tags: ["prod", "bugfix"],
			},
		];

		await element.updateComplete;

		const titles = Array.from(
			element.shadowRoot?.querySelectorAll(".session-title") ?? [],
		).map((node) => node.textContent?.trim());
		expect(titles[0]).toBe("Pinned session");

		const input = element.shadowRoot?.querySelector(
			".session-search",
		) as HTMLInputElement | null;
		expect(input).not.toBeNull();
		if (!input) return;

		input.value = "prod";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await element.updateComplete;

		const filteredTitles = Array.from(
			element.shadowRoot?.querySelectorAll(".session-title") ?? [],
		).map((node) => node.textContent?.trim());
		expect(filteredTitles).toEqual(["Pinned session"]);
	});

	it("dispatches session updates for favorite toggles", async () => {
		const element = createSidebar();
		element.sessions = [
			{
				id: "session-1",
				title: "Pinned session",
				createdAt: "2026-03-12T00:00:00.000Z",
				updatedAt: "2026-03-12T12:00:00.000Z",
				messageCount: 2,
				favorite: false,
			},
		];

		await element.updateComplete;

		const events: Array<Record<string, unknown> | undefined> = [];
		element.addEventListener("update-session", (event) => {
			events.push((event as CustomEvent).detail as Record<string, unknown>);
		});

		const button = element.shadowRoot?.querySelector(
			'button[title="Favorite"]',
		) as HTMLButtonElement | null;
		expect(button).not.toBeNull();
		button?.click();

		expect(events).toEqual([
			{
				sessionId: "session-1",
				updates: { favorite: true },
			},
		]);
	});

	it("dispatches title updates from the inline editor", async () => {
		const element = createSidebar();
		element.sessions = [
			{
				id: "session-1",
				title: "Old title",
				createdAt: "2026-03-12T00:00:00.000Z",
				updatedAt: "2026-03-12T12:00:00.000Z",
				messageCount: 2,
			},
		];

		await element.updateComplete;

		const events: Array<Record<string, unknown> | undefined> = [];
		element.addEventListener("update-session", (event) => {
			events.push((event as CustomEvent).detail as Record<string, unknown>);
		});

		const renameButton = element.shadowRoot?.querySelector(
			'button[title="Rename session"]',
		) as HTMLButtonElement | null;
		expect(renameButton).not.toBeNull();
		renameButton?.click();
		await element.updateComplete;

		const input = element.shadowRoot?.querySelector(
			".session-editor-input",
		) as HTMLInputElement | null;
		expect(input).not.toBeNull();
		if (!input) return;
		input.value = "Renamed session";
		input.dispatchEvent(new Event("input", { bubbles: true }));

		const form = element.shadowRoot?.querySelector(
			".session-editor",
		) as HTMLFormElement | null;
		form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);

		expect(events).toEqual([
			{
				sessionId: "session-1",
				updates: { title: "Renamed session" },
			},
		]);
	});

	it("dispatches tag updates from the inline editor", async () => {
		const element = createSidebar();
		element.sessions = [
			{
				id: "session-1",
				title: "Tagged session",
				createdAt: "2026-03-12T00:00:00.000Z",
				updatedAt: "2026-03-12T12:00:00.000Z",
				messageCount: 2,
				tags: ["bugfix"],
			},
		];

		await element.updateComplete;

		const events: Array<Record<string, unknown> | undefined> = [];
		element.addEventListener("update-session", (event) => {
			events.push((event as CustomEvent).detail as Record<string, unknown>);
		});

		const tagsButton = element.shadowRoot?.querySelector(
			'button[title="Edit tags"]',
		) as HTMLButtonElement | null;
		expect(tagsButton).not.toBeNull();
		tagsButton?.click();
		await element.updateComplete;

		const input = element.shadowRoot?.querySelector(
			".session-editor-input",
		) as HTMLInputElement | null;
		expect(input).not.toBeNull();
		if (!input) return;
		input.value = "bugfix, release, bugfix";
		input.dispatchEvent(new Event("input", { bubbles: true }));

		const form = element.shadowRoot?.querySelector(
			".session-editor",
		) as HTMLFormElement | null;
		form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);

		expect(events).toEqual([
			{
				sessionId: "session-1",
				updates: { tags: ["bugfix", "release"] },
			},
		]);
	});
});
