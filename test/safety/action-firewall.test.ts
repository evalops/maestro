import { describe, expect, it } from "vitest";
import {
	type ActionApprovalContext,
	ActionFirewall,
	defaultActionFirewall,
} from "../../src/safety/action-firewall.js";

function makeContext(command?: unknown): ActionApprovalContext {
	return {
		toolName: "bash",
		args: command === undefined ? {} : { command },
	};
}

describe("ActionFirewall", () => {
	it("requires approval for dangerous rm -rf patterns", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeContext('rm -rf /tmp/test && echo "oops"'),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("allows harmless commands", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeContext('echo "safe command"'),
		);
		expect(verdict.action).toBe("allow");
	});

	it("ignores non-string commands gracefully", () => {
		const firewall = new ActionFirewall();
		const verdict = firewall.evaluate(makeContext(1234));
		expect(verdict.action).toBe("allow");
	});
});
