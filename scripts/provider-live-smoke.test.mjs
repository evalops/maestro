import assert from "node:assert/strict";
import test from "node:test";
import {
	parseJsonl,
	redactSecrets,
	verifyScenarioOutput,
} from "./provider-live-smoke.mjs";

const scenario = {
	name: "fixture",
	marker: "MARKER_OK",
	markerResultIndex: 1,
	tools: ["glob", "read"],
};

function transcript(overrides = {}) {
	const events = [
		{
			type: "item",
			subtype: "tool_call",
			call_id: "call-glob",
			tool: "glob",
			args: { pattern: "fixture/*.txt" },
		},
		{
			type: "item",
			subtype: "tool_result",
			call_id: "call-glob",
			tool: "glob",
			success: true,
			output: "fixture/marker.txt",
		},
		{
			type: "item",
			subtype: "tool_call",
			call_id: "call-read",
			tool: "read",
			args: { path: "fixture/marker.txt" },
		},
		{
			type: "item",
			subtype: "tool_result",
			call_id: "call-read",
			tool: "read",
			success: true,
			output: "MARKER_OK",
		},
		{ type: "item", subtype: "message_complete", text: "MARKER_OK" },
		{ type: "done", status: "ok" },
	];
	Object.assign(events[overrides.index ?? -1] ?? {}, overrides.value ?? {});
	return events.map((event) => JSON.stringify(event)).join("\n");
}

test("verifies exact tool call/result IDs, marker, and terminal done", () => {
	const result = verifyScenarioOutput(transcript(), scenario);
	assert.deepEqual(result.callIds, ["call-glob", "call-read"]);
});

test("rejects a result ID that does not match its call", () => {
	assert.throws(
		() =>
			verifyScenarioOutput(
				transcript({ index: 3, value: { call_id: "wrong" } }),
				scenario,
			),
		/does not match/,
	);
});

test("rejects a missing marker or done event", () => {
	assert.throws(
		() =>
			verifyScenarioOutput(
				transcript({ index: 4, value: { text: "wrong" } }),
				scenario,
			),
		/final assistant marker/,
	);
	const withoutDone = parseJsonl(transcript()).slice(0, -1);
	assert.throws(
		() =>
			verifyScenarioOutput(
				withoutDone.map((event) => JSON.stringify(event)).join("\n"),
				scenario,
			),
		/unexpected semantic event count|expected one final done event/,
	);
});

test("rejects result-before-call and extra assistant messages", () => {
	const events = parseJsonl(transcript());
	[events[0], events[1]] = [events[1], events[0]];
	assert.throws(
		() => verifyScenarioOutput(events.map(JSON.stringify).join("\n"), scenario),
		/expected tool_call/,
	);

	const extra = parseJsonl(transcript());
	extra.splice(-2, 0, {
		type: "item",
		subtype: "message_complete",
		text: "UNEXPECTED",
	});
	assert.throws(
		() => verifyScenarioOutput(extra.map(JSON.stringify).join("\n"), scenario),
		/unexpected semantic event count/,
	);
});

test("redacts every occurrence of provider keys", () => {
	assert.equal(
		redactSecrets("key-one key-two key-one", ["key-one", "key-two"]),
		"[REDACTED] [REDACTED] [REDACTED]",
	);
});

test("usage-only events preserve strict semantic verification", () => {
	const events = parseJsonl(transcript());
	events.splice(2, 0, {
		type: "item",
		subtype: "response_usage",
		response_id: "tool",
		usage: { input_tokens: 100 },
	});
	assert.deepEqual(
		verifyScenarioOutput(events.map(JSON.stringify).join("\n"), scenario).callIds,
		["call-glob", "call-read"],
	);
	events.find((event) => event.subtype === "message_complete").text = "WRONG";
	assert.throws(
		() => verifyScenarioOutput(events.map(JSON.stringify).join("\n"), scenario),
		/final assistant marker/,
	);
});
