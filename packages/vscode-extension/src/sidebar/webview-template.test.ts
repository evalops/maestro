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

		expect(html).toContain(
			"tool.summaryLabel || tool.displayName || tool.name",
		);
		expect(html).toContain("summaryLabel || displayName || name");
	});

	it("renders tool and approval fields through text-node helpers", () => {
		const html = getWebviewHtml({
			nonce: "nonce",
			vendorUri: { toString: () => "vendor.js" } as never,
			styleUri: { toString: () => "style.css" } as never,
			cspSource: "vscode-resource:",
			cspConnect: "http://localhost:8080",
		});

		expect(html).toContain("appendToolSection(body, 'Arguments', args)");
		expect(html).toContain("appendToolSection(body, 'Result', tool.result)");
		expect(html).toContain("approve.addEventListener('click'");
		expect(html).toContain("deny.addEventListener('click'");
		expect(html).not.toContain("${JSON.stringify(args, null, 2)}</div>");
		expect(html).not.toContain("${msg.reason || 'Requires confirmation'}");
		expect(html).not.toContain('onclick="submitApproval');
	});

	it("scopes the sidebar CSP connect-src to the configured API origin", () => {
		const html = getWebviewHtml({
			nonce: "nonce",
			vendorUri: { toString: () => "vendor.js" } as never,
			styleUri: { toString: () => "style.css" } as never,
			cspSource: "vscode-resource:",
			cspConnect: "http://localhost:8080",
		});

		expect(html).toContain("connect-src http://localhost:8080;");
		expect(html).not.toContain("https: http: wss: ws:");
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
