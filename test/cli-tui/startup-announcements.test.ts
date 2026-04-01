import { Container, type TUI } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import { renderStartupAnnouncements } from "../../src/cli-tui/startup-announcements.js";
import { stripAnsiSequences } from "../../src/cli-tui/utils/text-formatting.js";

function renderAnnouncements(): string {
	const container = new Container();
	const ui = { requestRender: vi.fn() } as unknown as TUI;

	renderStartupAnnouncements({
		container,
		ui,
		updateNotice: {
			currentVersion: "0.10.0",
			latestVersion: "0.11.0",
			isUpdateAvailable: true,
			sourceUrl: "https://example.com/changelog",
		},
		modelScope: [],
	});

	return stripAnsiSequences(container.render(120).join("\n"));
}

describe("renderStartupAnnouncements", () => {
	it("renders the Maestro package name in update instructions", () => {
		const output = renderAnnouncements();

		expect(output).toContain("npm install -g @evalops/maestro");
		expect(output).not.toContain("@evalops/composer");
	});
});
