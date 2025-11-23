import { describe, expect, it } from "vitest";

import type { ToolCall, ToolResultMessage } from "../../src/agent/types.js";
import { defaultActionFirewall } from "../../src/safety/action-firewall.js";
import {
	WorkflowStateError,
	WorkflowStateTracker,
	applyWorkflowStateHooks,
} from "../../src/safety/workflow-state.js";

function makeToolCall(
	name: string,
	id: string,
	args: Record<string, unknown> = {},
): ToolCall {
	return {
		type: "toolCall",
		id,
		name,
		arguments: args,
	};
}

function makeResult(toolCall: ToolCall): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("WorkflowStateTracker", () => {
	it("tracks and clears pending PII artifacts", () => {
		const tracker = new WorkflowStateTracker();
		tracker.notePiiCapture({
			artifactId: "pii-1",
			label: "Case-1",
			sourceToolCallId: "collect-call",
		});
		let snapshot = tracker.snapshot();
		expect(snapshot.pendingPii).toHaveLength(1);
		expect(snapshot.pendingPii[0]).toMatchObject({
			id: "pii-1",
			label: "Case-1",
			sourceToolCallId: "collect-call",
			redacted: false,
		});
		expect(tracker.noteRedaction({ artifactId: "pii-1" })).toBe(true);
		snapshot = tracker.snapshot();
		expect(snapshot.pendingPii).toHaveLength(0);
		expect(snapshot.orphanedRedactions).toHaveLength(0);
		tracker.reset();
		expect(tracker.snapshot().pendingPii).toHaveLength(0);
	});

	it("records orphaned redaction attempts", () => {
		const tracker = new WorkflowStateTracker();
		expect(() => tracker.noteRedaction({ artifactId: "missing-1" })).toThrow(
			WorkflowStateError,
		);
		const snapshot = tracker.snapshot();
		expect(snapshot.orphanedRedactions).toContain("missing-1");
	});

	it("throws when redact_transcript references an unknown artifact", () => {
		const tracker = new WorkflowStateTracker();
		const collect = makeToolCall("collect_customer_context", "collect-err", {
			subject: "Case-ERR",
		});
		applyWorkflowStateHooks({
			toolCall: collect,
			result: makeResult(collect),
			tracker,
			isError: false,
		});
		const redact = makeToolCall("redact_transcript", "redact-err", {
			artifactId: "does-not-exist",
		});
		expect(() =>
			applyWorkflowStateHooks({
				toolCall: redact,
				result: makeResult(redact),
				tracker,
				isError: false,
			}),
		).toThrow(WorkflowStateError);
	});

	it("infers redaction artifact id from subject label when omitted", () => {
		const tracker = new WorkflowStateTracker();
		const collect = makeToolCall("collect_customer_context", "collect-3", {
			subject: "Case-ABC",
		});
		applyWorkflowStateHooks({
			toolCall: collect,
			result: makeResult(collect),
			tracker,
			isError: false,
		});
		expect(tracker.snapshot().pendingPii).toHaveLength(1);
		const redact = makeToolCall("redact_transcript", "redact-3", {
			subject: "Case-ABC",
		});
		applyWorkflowStateHooks({
			toolCall: redact,
			result: makeResult(redact),
			tracker,
			isError: false,
		});
		expect(tracker.snapshot().pendingPii).toHaveLength(0);
	});

	it("defaults to the only pending artifact when no hints are provided", () => {
		const tracker = new WorkflowStateTracker();
		const collect = makeToolCall("collect_customer_context", "collect-4", {
			subject: "Case-ONLY",
		});
		applyWorkflowStateHooks({
			toolCall: collect,
			result: makeResult(collect),
			tracker,
			isError: false,
		});
		const redact = makeToolCall("redact_transcript", "redact-4", {});
		applyWorkflowStateHooks({
			toolCall: redact,
			result: makeResult(redact),
			tracker,
			isError: false,
		});
		expect(tracker.snapshot().pendingPii).toHaveLength(0);
	});

	it("throws when subject is provided but does not match a pending artifact", () => {
		const tracker = new WorkflowStateTracker();
		const collect = makeToolCall("collect_customer_context", "collect-5", {
			subject: "Case-MATCH",
		});
		applyWorkflowStateHooks({
			toolCall: collect,
			result: makeResult(collect),
			tracker,
			isError: false,
		});
		const redact = makeToolCall("redact_transcript", "redact-5", {
			subject: "Case-TYPO",
		});
		expect(() =>
			applyWorkflowStateHooks({
				toolCall: redact,
				result: makeResult(redact),
				tracker,
				isError: false,
			}),
		).toThrow(WorkflowStateError);
	});
});

describe("PII invariant workflow story", () => {
	it("requires approval until redaction occurs", () => {
		const tracker = new WorkflowStateTracker();
		const firewall = defaultActionFirewall;

		const collect = makeToolCall("collect_customer_context", "call-1", {
			subject: "Case-742",
		});
		applyWorkflowStateHooks({
			toolCall: collect,
			result: makeResult(collect),
			tracker,
			isError: false,
		});

		const requireVerdict = firewall.evaluate({
			toolName: "handoff_to_human",
			args: {},
			metadata: { workflowState: tracker.snapshot() },
		});
		expect(requireVerdict.action).toBe("require_approval");
		expect(requireVerdict.reason).toContain("Case-742");

		const redact = makeToolCall("redact_transcript", "call-2", {
			artifactId: collect.id,
		});
		applyWorkflowStateHooks({
			toolCall: redact,
			result: makeResult(redact),
			tracker,
			isError: false,
		});

		const allowVerdict = firewall.evaluate({
			toolName: "handoff_to_human",
			args: {},
			metadata: { workflowState: tracker.snapshot() },
		});
		expect(allowVerdict.action).toBe("allow");
	});
});
