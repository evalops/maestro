import { describe, expect, it } from "vitest";
import { getWebviewHtml } from "./webview-template.js";

describe("webview template", () => {
	it("renders Maestro branding", () => {
		const html = getWebviewHtml({
			nonce: "nonce",
			vendorUri: { toString: () => "vendor.js" } as never,
			styleUri: { toString: () => "style.css" } as never,
			cspSource: "vscode-resource:",
			cspConnect: "http://localhost:8080",
		});

		expect(html).toContain("<title>Maestro Chat</title>");
		expect(html).toContain("<h2>Maestro Agent</h2>");
		expect(html).not.toContain("Composer Chat");
		expect(html).not.toContain("Composer Agent");
	});
});
