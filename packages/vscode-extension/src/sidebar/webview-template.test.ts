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

	it("renders tool summary labels for live and historical tool cards", () => {
		const html = getWebviewHtml({
			nonce: "nonce",
			vendorUri: { toString: () => "vendor.js" } as never,
			styleUri: { toString: () => "style.css" } as never,
			cspSource: "vscode-resource:",
			cspConnect: "http://localhost:8080",
		});

		expect(html).toContain("tool.summaryLabel || tool.name");
		expect(html).toContain("summaryLabel || name");
	});

	it("renders runtime status UI hooks", () => {
		const html = getWebviewHtml({
			nonce: "nonce",
			vendorUri: { toString: () => "vendor.js" } as never,
			styleUri: { toString: () => "style.css" } as never,
			cspSource: "vscode-resource:",
			cspConnect: "http://localhost:8080",
		});

		expect(html).toContain('id="runtime-status"');
		expect(html).toContain("case 'runtime_status'");
		expect(html).toContain("case 'runtime_status_clear'");
	});
});
