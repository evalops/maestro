import { describe, expect, it } from "vitest";

import { codexSubagentStatusIsTerminal } from "../src/cli/headless-protocol.js";

describe("headless Codex subagent lifecycle", () => {
	it("keeps spawned and resumed child work active until a terminal edge arrives", () => {
		expect(codexSubagentStatusIsTerminal("spawned")).toBe(false);
		expect(codexSubagentStatusIsTerminal("Spawned")).toBe(false);
		expect(codexSubagentStatusIsTerminal("resumed")).toBe(false);
		expect(codexSubagentStatusIsTerminal("reSumed")).toBe(false);
		expect(codexSubagentStatusIsTerminal("completed")).toBe(true);
		expect(codexSubagentStatusIsTerminal("closed")).toBe(true);
	});
});
