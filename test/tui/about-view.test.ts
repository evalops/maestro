import type * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { stripAnsiSequences } from "../../src/cli-tui/utils/text-formatting.js";
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		existsSync: () => false,
	};
});

import { AboutView } from "../../src/cli-tui/about-view.js";

type AboutViewOptions = ConstructorParameters<typeof AboutView>[0];

describe("AboutView", () => {
	it("builds a richly formatted about card", () => {
		const about = new AboutView({
			agent: {
				state: {
					model: { provider: "anthropic", id: "claude-sonnet" },
					pendingToolCalls: new Map(),
				},
			} as unknown as AboutViewOptions["agent"],
			sessionManager: {
				getSessionId: () => "sess-123",
				getSessionFile: () => "/tmp/composer/session.log",
			} as unknown as AboutViewOptions["sessionManager"],
			gitView: {
				getWorkingTreeState: () => ({ branch: "main", dirty: false }),
				getCurrentCommit: () => "abcdef",
				getStatusSummary: () => "## main\n M src/index.ts",
			} as unknown as AboutViewOptions["gitView"],
			chatContainer: {
				addChild: () => {},
			} as unknown as AboutViewOptions["chatContainer"],
			ui: { requestRender: () => {} } as unknown as AboutViewOptions["ui"],
			version: "0.10.0",
			telemetryStatus: () => "enabled",
			getApprovalMode: () => "auto",
		});
		const card = stripAnsiSequences(about.buildAboutCard());
		expect(card).toContain("maestro about");
		expect(card).toContain("[status]");
		expect(card).toContain("git");
		expect(card).toContain("Session directory");
		expect(card).toContain("▣ maestro ");
		expect(card).toContain("tar czf maestro-about.tgz");
		expect(card).not.toContain("▣ composer ");
		expect(card).not.toContain("composer-about.tgz");
	});
});
