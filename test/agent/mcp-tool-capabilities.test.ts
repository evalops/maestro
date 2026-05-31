import { describe, expect, it } from "vitest";
import {
	classifyToolCapability,
	summarizeToolCapabilities,
} from "../../src/mcp/tool-capabilities.js";

describe("MCP tool capability contract", () => {
	it("classifies Fathom desktop tools by domain, risk, and mutation surface", () => {
		expect(
			classifyToolCapability({
				server: "fathom-cua",
				toolName: "get_app_state",
				annotations: { readOnlyHint: true },
			}),
		).toMatchObject({
			domain: "desktop",
			riskClass: "observe",
			mutatesDesktop: false,
			requiresReceipt: true,
			proofRequired: true,
		});

		expect(
			classifyToolCapability({
				server: "fathom-cua",
				toolName: "set_value",
				annotations: { readOnlyHint: false },
			}),
		).toMatchObject({
			domain: "desktop",
			riskClass: "medium",
			mutatesDesktop: true,
			rawSecretPossible: true,
			requiresReceipt: true,
		});

		expect(
			classifyToolCapability({
				server: "fathom-cua",
				toolName: "press_window_button",
			}),
		).toMatchObject({
			domain: "desktop",
			riskClass: "high",
			mutatesDesktop: true,
			requiresReceipt: true,
		});
	});

	it("keeps common desktop tool names scoped to the Fathom server", () => {
		expect(
			classifyToolCapability({
				server: "generic-mcp",
				toolName: "click",
			}),
		).toMatchObject({
			domain: "unknown",
			toolLane: "unknown",
			riskClass: "medium",
			mutatesDesktop: false,
			requiresReceipt: false,
		});
	});

	it("recognizes configured Fathom server aliases", () => {
		const previousName = process.env.MAESTRO_FATHOM_CUA_MCP_NAME;
		process.env.MAESTRO_FATHOM_CUA_MCP_NAME = "desktop-cua";
		try {
			expect(
				classifyToolCapability({
					server: "desktop-cua",
					toolName: "click",
				}),
			).toMatchObject({
				domain: "desktop",
				toolLane: "desktop_action",
				requiresReceipt: true,
				mutatesDesktop: true,
			});
		} finally {
			if (previousName === undefined) {
				delete process.env.MAESTRO_FATHOM_CUA_MCP_NAME;
			} else {
				process.env.MAESTRO_FATHOM_CUA_MCP_NAME = previousName;
			}
		}
	});

	it("keeps file editing in a distinct lane from desktop computer-use", () => {
		for (const toolName of ["read", "list", "find", "search", "diff"]) {
			expect(
				classifyToolCapability({ server: "builtin", toolName }),
				`${toolName} should be a file read/search tool`,
			).toMatchObject({
				domain: "file",
				riskClass: "observe",
				mutatesFiles: false,
				mutatesDesktop: false,
			});
		}

		for (const toolName of ["apply_patch", "edit", "write", "notebook_edit"]) {
			expect(
				classifyToolCapability({ server: "builtin", toolName }),
				`${toolName} should be an explicit file-edit tool`,
			).toMatchObject({
				domain: "file",
				riskClass: "medium",
				mutatesFiles: true,
				mutatesDesktop: false,
				toolLane: "file_edit",
			});
		}
	});

	it("summarizes capability counts for settings and smoke reports", () => {
		const summary = summarizeToolCapabilities([
			classifyToolCapability({
				server: "fathom-cua",
				toolName: "get_app_state",
				annotations: { readOnlyHint: true },
			}),
			classifyToolCapability({
				server: "fathom-cua",
				toolName: "set_value",
				annotations: { readOnlyHint: false },
			}),
			classifyToolCapability({ server: "builtin", toolName: "apply_patch" }),
		]);

		expect(summary).toEqual({
			total: 3,
			byDomain: { desktop: 2, file: 1, shell: 0, web: 0, mcp: 0, unknown: 0 },
			byRiskClass: { observe: 1, low: 0, medium: 2, high: 0 },
			byToolLane: {
				desktop_observe: 1,
				desktop_action: 1,
				file_read: 0,
				file_edit: 1,
				shell_exec: 0,
				web_access: 0,
				mcp_meta: 0,
				unknown: 0,
			},
			mutating: { desktop: 1, files: 1 },
			requiresReceipt: 2,
			rawSecretPossible: 2,
		});
	});
});
