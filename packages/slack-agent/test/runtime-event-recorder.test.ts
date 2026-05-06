import { describe, expect, it, vi } from "vitest";
import { createRuntimeEventRecorder } from "../src/runtime-event-recorder.js";
import type { SlackContext } from "../src/slack/bot.js";

function context(): SlackContext {
	return {
		teamId: "T123",
		channelName: "eng-ops",
		channels: [],
		users: [],
		threadKey: "1710000000.000100",
		useThread: true,
		runId: "run_test",
		source: "channel",
		message: {
			text: "investigate",
			rawText: "investigate",
			user: "U123",
			userName: "Ada",
			teamId: "T123",
			channel: "C123",
			ts: "1710000000.000100",
			threadTs: undefined,
			attachments: [],
		},
		store: {} as SlackContext["store"],
		respond: async () => undefined,
		replaceMessage: async () => undefined,
		respondInThread: async () => undefined,
		setTyping: async () => undefined,
		uploadFile: async () => undefined,
		setWorking: async () => undefined,
		updateStatus: async () => undefined,
	};
}

describe("createRuntimeEventRecorder", () => {
	it("serializes overlapping runtime event writes", async () => {
		let releaseFirst: () => void = () => undefined;
		const firstWrite = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const calls: string[] = [];
		const writeEvent = vi.fn(async (_ctx, options) => {
			calls.push(`start:${options.message}`);
			if (options.message === "first") {
				await firstWrite;
			}
			calls.push(`end:${options.message}`);
			return null;
		});

		const recorder = createRuntimeEventRecorder(context(), "run_platform", {
			writeEvent,
		});
		const first = recorder.record(
			"RUNTIME_EVENT_TYPE_TOOL_CALL_RECORDED",
			"first",
		);
		const second = recorder.record(
			"RUNTIME_EVENT_TYPE_TOOL_RESULT_RECORDED",
			"second",
		);

		await Promise.resolve();
		expect(calls).toEqual(["start:first"]);

		releaseFirst();
		await Promise.all([first, second, recorder.flush()]);

		expect(calls).toEqual([
			"start:first",
			"end:first",
			"start:second",
			"end:second",
		]);
	});

	it("keeps the queue alive after a failed event write", async () => {
		const calls: string[] = [];
		const logWarning = vi.fn();
		const writeEvent = vi.fn(async (_ctx, options) => {
			calls.push(options.message);
			if (options.message === "first") {
				throw new Error("temporary outage");
			}
			return null;
		});
		const recorder = createRuntimeEventRecorder(context(), "run_platform", {
			writeEvent,
			logWarning,
		});

		await recorder.record(
			"RUNTIME_EVENT_TYPE_AGENT_PROGRESS_RECORDED",
			"first",
		);
		await recorder.record(
			"RUNTIME_EVENT_TYPE_AGENT_PROGRESS_RECORDED",
			"second",
		);

		expect(calls).toEqual(["first", "second"]);
		expect(logWarning).toHaveBeenCalledWith(
			"Platform AgentRuntime event recording skipped",
			"temporary outage",
		);
	});
});
