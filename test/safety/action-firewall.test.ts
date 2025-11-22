import { describe, expect, it } from "vitest";
import {
	type ActionApprovalContext,
	ActionFirewall,
	defaultActionFirewall,
} from "../../src/safety/action-firewall.js";

function makeBashContext(command?: unknown): ActionApprovalContext {
	return {
		toolName: "bash",
		args: command === undefined ? {} : { command },
	};
}

function makeBackgroundTaskContext(
	command: unknown,
	action = "start",
): ActionApprovalContext {
	const args: Record<string, unknown> = { action };
	if (action === "start") {
		args.command = command;
	}
	return {
		toolName: "background_tasks",
		args,
	};
}

function makeShellBackgroundTaskContext(
	command: string,
): ActionApprovalContext {
	return {
		toolName: "background_tasks",
		args: { action: "start", command, shell: true },
	};
}

function makeCustomCommandContext(command: string): ActionApprovalContext {
	return {
		toolName: "custom_exec",
		args: { command },
	};
}

describe("ActionFirewall", () => {
	it("requires approval for dangerous rm -rf patterns", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeBashContext('rm -rf /tmp/test && echo "oops"'),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("allows harmless commands", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeBashContext('echo "safe command"'),
		);
		expect(verdict.action).toBe("allow");
	});

	it("ignores non-string commands gracefully", () => {
		const firewall = new ActionFirewall();
		const verdict = firewall.evaluate(makeBashContext(1234));
		expect(verdict.action).toBe("allow");
	});

	it("applies safeguards to background task start commands", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeBackgroundTaskContext("rm -rf /", "start"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("does not flag non-start background task actions", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeBackgroundTaskContext("rm -rf /", "logs"),
		);
		expect(verdict.action).toBe("allow");
	});

	it("requires approval for shell-mode background tasks", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeShellBackgroundTaskContext("echo 'pipe | tee'"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("guards arbitrary tools that expose a command string", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeCustomCommandContext("mkfs.ext4 /dev/sda"),
		);
		expect(verdict.action).toBe("require_approval");
	});
});
