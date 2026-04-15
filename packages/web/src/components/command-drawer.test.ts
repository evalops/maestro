import { afterEach, describe, expect, it, vi } from "vitest";
import "./command-drawer.js";
import type { CommandDrawer } from "./command-drawer.js";

function createDrawer(commands: Array<Record<string, unknown>>): CommandDrawer {
	const element = document.createElement("command-drawer") as CommandDrawer;
	element.commands = commands as CommandDrawer["commands"];
	document.body.append(element);
	return element;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("CommandDrawer", () => {
	it("focuses the search input when opened", async () => {
		const element = createDrawer([
			{
				name: "help",
				description: "List commands",
				usage: "/help",
			},
		]);

		await element.updateComplete;
		element.open = true;
		await element.updateComplete;
		await element.updateComplete;

		const input = element.shadowRoot?.querySelector(
			"input",
		) as HTMLInputElement | null;
		expect(input).toBeTruthy();
		expect(element.shadowRoot?.activeElement).toBe(input);
	});

	it("marks CLI-only commands and ignores selection", async () => {
		const element = createDrawer([
			{
				name: "history",
				description: "Show prompt history",
				usage: "/history",
				supported: false,
			},
			{
				name: "help",
				description: "List commands",
				usage: "/help",
			},
		]);
		element.open = true;
		await element.updateComplete;
		const onSelect = vi.fn();
		element.addEventListener("select-command", onSelect);

		const rows = Array.from(element.shadowRoot?.querySelectorAll(".row") ?? []);
		const historyRow = rows.find((row) =>
			row.textContent?.includes("/history"),
		);
		expect(historyRow?.className).toContain("unsupported");
		expect(historyRow?.textContent).toContain("CLI only");

		historyRow?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, composed: true }),
		);

		expect(onSelect).not.toHaveBeenCalled();
	});
});
