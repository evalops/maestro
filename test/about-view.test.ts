import { describe, expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({ existsSync: () => false }));

import { AboutView } from "../src/tui/about-view.js";

describe("AboutView", () => {
	it("builds a richly formatted about card", () => {
		const about = new AboutView({
			agent: {
				state: {
					model: { provider: "anthropic", id: "claude-sonnet" },
					pendingToolCalls: new Map(),
				},
			} as any,
			sessionManager: {
				getSessionId: () => "sess-123",
				getSessionFile: () => "/tmp/composer/session.log",
			} as any,
			gitView: {
				getWorkingTreeState: () => ({ branch: "main", dirty: false }),
				getCurrentCommit: () => "abcdef",
				getStatusSummary: () => "## main\n M src/index.ts",
			} as any,
			chatContainer: { addChild: () => {} } as any,
			ui: { requestRender: () => {} } as any,
			version: "0.10.0",
			telemetryStatus: () => "enabled",
			getApprovalMode: () => "auto",
		});
		const card = about.buildAboutCard();
		expect(card).toContain("composer about");
		expect(card).toContain("[status]");
		expect(card).toContain("git");
		expect(card).toContain("Session directory");
	});
});
