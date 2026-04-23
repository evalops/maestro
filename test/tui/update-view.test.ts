import { Container, type TUI } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import { UpdateView } from "../../src/cli-tui/update-view.js";
import { stripAnsiSequences } from "../../src/cli-tui/utils/text-formatting.js";
import { getGlobalInstallCommand } from "../../src/package-metadata.js";

describe("UpdateView", () => {
	it("renders Maestro update instructions when an update is available", async () => {
		const container = new Container();
		const view = new UpdateView({
			currentVersion: "0.10.0",
			chatContainer: container,
			ui: { requestRender: vi.fn() } as unknown as TUI,
			showError: vi.fn(),
			runUpdateCheck: async () => ({
				currentVersion: "0.10.0",
				latestVersion: "0.11.0",
				isUpdateAvailable: true,
				sourceUrl: "https://example.com/version.json",
			}),
		});

		await view.handleUpdateCommand();

		const output = stripAnsiSequences(container.render(120).join("\n"));
		expect(output).toContain(getGlobalInstallCommand("npm"));
		expect(output).not.toContain("@evalops/composer");
	});
});
