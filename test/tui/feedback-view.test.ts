import type * as fs from "node:fs";
import { Container, type TUI } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import { FeedbackView } from "../../src/cli-tui/feedback-view.js";
import { stripAnsiSequences } from "../../src/cli-tui/utils/text-formatting.js";

vi.mock("clipboardy", () => ({
	default: {
		writeSync: vi.fn(),
	},
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		existsSync: () => false,
	};
});

type FeedbackViewOptions = ConstructorParameters<typeof FeedbackView>[0];

function createView(container: Container): FeedbackView {
	return new FeedbackView({
		agent: {
			state: {
				model: { provider: "anthropic", id: "claude-sonnet" },
				pendingToolCalls: new Map(),
				messages: [],
			},
		} as unknown as FeedbackViewOptions["agent"],
		sessionManager: {
			getSessionId: () => "sess-123",
			getSessionFile: () => "/tmp/maestro/session.log",
		} as unknown as FeedbackViewOptions["sessionManager"],
		chatContainer: container,
		ui: { requestRender: vi.fn() } as unknown as FeedbackViewOptions["ui"],
		gitView: {
			getStatusSummary: () => "## main\n M src/index.ts",
			getCurrentCommit: () => "abcdef",
			getWorkingTreeState: () => ({ branch: "main", dirty: false }),
		} as unknown as FeedbackViewOptions["gitView"],
		version: "0.10.0",
		getApprovalMode: () => "auto",
	});
}

function renderContainer(container: Container): string {
	return stripAnsiSequences(container.render(120).join("\n"));
}

describe("FeedbackView", () => {
	it("renders Maestro branding in the feedback template", () => {
		const container = new Container();
		const view = createView(container);

		view.handleFeedbackCommand();

		const output = renderContainer(container);
		expect(output).toContain("Maestro feedback");
		expect(output).not.toContain("Composer feedback");
	});

	it("renders a Maestro-named bug report archive", () => {
		const container = new Container();
		const view = createView(container);

		view.handleBugCommand();

		const output = renderContainer(container);
		expect(output).toContain("tar czf maestro-bug-report.tgz");
		expect(output).not.toContain("composer-bug-report.tgz");
		expect(output).toContain("Maestro: 0.10.0");
		expect(output).not.toContain("Composer: 0.10.0");
	});
});
