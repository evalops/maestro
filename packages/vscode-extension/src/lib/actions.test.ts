import { describe, expect, it } from "vitest";

import { buildComposerUrl, getActionLabel } from "./actions.js";

describe("actions", () => {
	it("builds default composer url", () => {
		const url = buildComposerUrl();
		expect(url).toBe("https://composer.evalops.ai/");
	});

	it("builds docs url", () => {
		const url = buildComposerUrl("docs");
		expect(url.endsWith("/docs")).toBe(true);
	});

	it("builds tui url", () => {
		const url = buildComposerUrl("tui");
		expect(url.endsWith("/docs/tui")).toBe(true);
	});

	it("returns friendly labels", () => {
		expect(getActionLabel("web")).toBe("Open Maestro");
		expect(getActionLabel("docs")).toBe("View Documentation");
		expect(getActionLabel("tui")).toBe("Launch Terminal UI");
	});
});
