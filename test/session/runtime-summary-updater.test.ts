import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/types.js";
import { createRuntimeSessionSummaryUpdater } from "../../src/session/runtime-summary-updater.js";

function createToolBatchStatus(
	status: string,
): Extract<AgentEvent, { type: "status" }> {
	return {
		type: "status",
		status,
		details: { kind: "tool_batch_summary" },
	};
}

describe("runtime-session-summary-updater", () => {
	it("persists tool batch summaries for active sessions", () => {
		const sessionManager = {
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			saveSessionSummary: vi.fn(),
		};
		const update = createRuntimeSessionSummaryUpdater(sessionManager);

		update(createToolBatchStatus("Read 2 files, ran tests"));

		expect(sessionManager.saveSessionSummary).toHaveBeenCalledWith(
			"Read 2 files, ran tests",
			"/tmp/session.jsonl",
		);
	});

	it("deduplicates repeated summaries", () => {
		const sessionManager = {
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			saveSessionSummary: vi.fn(),
		};
		const update = createRuntimeSessionSummaryUpdater(sessionManager);
		const event = createToolBatchStatus("Read 1 file");

		update(event);
		update(event);

		expect(sessionManager.saveSessionSummary).toHaveBeenCalledTimes(1);
	});

	it("ignores non-tool-batch status events", () => {
		const sessionManager = {
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			saveSessionSummary: vi.fn(),
		};
		const update = createRuntimeSessionSummaryUpdater(sessionManager);

		update({
			type: "status",
			status: "planning",
			details: { kind: "other" },
		});

		expect(sessionManager.saveSessionSummary).not.toHaveBeenCalled();
	});

	it("does not mark a summary as saved before a session file exists", () => {
		const getSessionFile = vi
			.fn<() => string | null>()
			.mockReturnValueOnce(null)
			.mockReturnValueOnce("/tmp/session.jsonl");
		const sessionManager = {
			getSessionFile,
			saveSessionSummary: vi.fn(),
		};
		const update = createRuntimeSessionSummaryUpdater(sessionManager);
		const event = createToolBatchStatus("Read 1 file");

		update(event);
		update(event);

		expect(sessionManager.saveSessionSummary).toHaveBeenCalledTimes(1);
		expect(sessionManager.saveSessionSummary).toHaveBeenCalledWith(
			"Read 1 file",
			"/tmp/session.jsonl",
		);
	});
});
