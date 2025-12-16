import { describe, expect, it } from "vitest";
import { detectHeuristicFindings } from "../../src/guardian/runner.js";

describe("guardian heuristic scan", () => {
	it("does not flag natural language token text in concatenated strings", () => {
		const contents = 'const msg = "Token: " + "xoxb-FAKE-TEST-TOKEN-abc";\n';
		expect(detectHeuristicFindings(contents)).toEqual([]);
	});

	it("flags identifier-style token assignments", () => {
		const contents =
			'const cfg = { token: "abcdefghijklmnopqrstuvwxyz0123456789" };\n';
		expect(detectHeuristicFindings(contents)).toContain("Generic API key");
	});

	it("flags JSON-style token keys", () => {
		const contents = '{ "token": "abcdefghijklmnopqrstuvwxyz0123456789" }\n';
		expect(detectHeuristicFindings(contents)).toContain("Generic API key");
	});

	it("flags Slack token shapes with numeric segments", () => {
		const contents = 'const t = "xoxb-123456789-123456789-abcDEF0123456789";\n';
		expect(detectHeuristicFindings(contents)).toContain("Slack token");
	});
});
