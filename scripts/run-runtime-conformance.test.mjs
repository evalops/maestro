import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateConformanceReceipt } from "./run-runtime-conformance.mjs";

const fixture = JSON.parse(
	readFileSync("packages/runtime-rs/fixtures/runtime-conformance-v1.json", "utf8"),
);

function receiptWithOutcome(outcome) {
	return {
		cases: fixture.cases.map((name) => ({
			name,
			tool: "test",
			outcome: name === "wrong_session_rejected" ? outcome : "passed",
		})),
	};
}

test("expected wrong-session rejection is a passing conformance case", () => {
	assert.doesNotThrow(() => validateConformanceReceipt(receiptWithOutcome("passed")));
});

test("unexpected negative-case receipt outcome is rejected", () => {
	assert.throws(
		() => validateConformanceReceipt(receiptWithOutcome("rejected:409")),
		/expected negative cases must be recorded as passed/,
	);
});
