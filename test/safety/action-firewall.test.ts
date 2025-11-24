import { describe, expect, it } from "vitest";
import {
	type ActionApprovalContext,
	ActionFirewall,
	defaultActionFirewall,
} from "../../src/safety/action-firewall.js";

const withPlanMode = (fn: () => void) => {
	const prev = process.env.COMPOSER_PLAN_MODE;
	process.env.COMPOSER_PLAN_MODE = "1";
	try {
		fn();
	} finally {
		if (prev === undefined) {
			// biome-ignore lint/performance/noDelete: need to fully unset env var
			delete process.env.COMPOSER_PLAN_MODE;
		} else {
			process.env.COMPOSER_PLAN_MODE = prev;
		}
	}
};

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

function makeWriteContext(): ActionApprovalContext {
	return { toolName: "write", args: { path: "file.txt" } };
}

function makeEditContext(): ActionApprovalContext {
	return { toolName: "edit", args: { path: "file.txt" } };
}

function makeTodoContext(): ActionApprovalContext {
	return { toolName: "todo", args: { items: [] } };
}

function makeGhPrContext(action: string): ActionApprovalContext {
	return { toolName: "gh_pr", args: { action } };
}

function makeGhIssueContext(action: string): ActionApprovalContext {
	return { toolName: "gh_issue", args: { action } };
}

function makeBatchContext(): ActionApprovalContext {
	return { toolName: "batch", args: { tasks: [] } };
}

function makeWorkflowContext(
	toolName: string,
	pendingPii: Array<{ id: string; label: string; redacted?: boolean }>,
): ActionApprovalContext {
	return {
		toolName,
		args: {},
		metadata: {
			workflowState: {
				pendingPii: pendingPii.map((item) => ({
					id: item.id,
					label: item.label,
					sourceToolCallId: item.id,
					redacted: item.redacted ?? false,
				})),
				orphanedRedactions: [],
			},
		},
	};
}

function makeMcpToolContext(
	toolName: string,
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	},
): ActionApprovalContext {
	return {
		toolName,
		args: {},
		metadata: annotations ? { annotations } : undefined,
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

	it("requires approval for mutating tools when plan mode is on", () => {
		withPlanMode(() => {
			const bashVerdict = defaultActionFirewall.evaluate(
				makeBashContext("echo hi"),
			);
			expect(bashVerdict.action).toBe("require_approval");

			const writeVerdict = defaultActionFirewall.evaluate(makeWriteContext());
			expect(writeVerdict.action).toBe("require_approval");

			const editVerdict = defaultActionFirewall.evaluate(makeEditContext());
			expect(editVerdict.action).toBe("require_approval");

			const todoVerdict = defaultActionFirewall.evaluate(makeTodoContext());
			expect(todoVerdict.action).toBe("require_approval");

			const ghPrVerdict = defaultActionFirewall.evaluate(
				makeGhPrContext("create"),
			);
			expect(ghPrVerdict.action).toBe("require_approval");

			const ghIssueVerdict = defaultActionFirewall.evaluate(
				makeGhIssueContext("create"),
			);
			expect(ghIssueVerdict.action).toBe("require_approval");

			const batchVerdict = defaultActionFirewall.evaluate(makeBatchContext());
			expect(batchVerdict.action).toBe("require_approval");

			const bgVerdict = defaultActionFirewall.evaluate(
				makeShellBackgroundTaskContext("echo"),
			);
			expect(bgVerdict.action).toBe("require_approval");
		});
	});

	it("requires approval when human egress sees unredacted PII", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeWorkflowContext("handoff_to_human", [
				{ id: "transcript", label: "Case-742" },
			]),
		);
		expect(verdict.action).toBe("require_approval");
		expect(verdict).toMatchObject({
			reason: expect.stringContaining("Case-742"),
		});
	});

	it("allows human egress once all PII is redacted", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeWorkflowContext("handoff_to_human", []),
		);
		expect(verdict.action).toBe("allow");
	});

	it("fails closed for untagged egress-like tool names", () => {
		const verdict = defaultActionFirewall.evaluate(
			makeWorkflowContext("send_status_update", [
				{ id: "pii-2", label: "Account Plan" },
			]),
		);
		expect(verdict.action).toBe("require_approval");
	});

	it("leaves legacy rules unchanged when workflow metadata is present", () => {
		const verdict = defaultActionFirewall.evaluate({
			toolName: "bash",
			args: { command: "echo ok" },
			metadata: {
				workflowState: { pendingPii: [], orphanedRedactions: [] },
			},
		});
		expect(verdict.action).toBe("allow");
	});

	describe("MCP tool annotations", () => {
		it("requires approval for MCP tools with destructiveHint=true", () => {
			const verdict = defaultActionFirewall.evaluate(
				makeMcpToolContext("mcp_server_delete_file", {
					destructiveHint: true,
				}),
			);
			expect(verdict.action).toBe("require_approval");
			expect(verdict).toMatchObject({
				ruleId: "mcp-destructive-tool",
				reason: expect.stringContaining("destructive"),
			});
		});

		it("allows MCP tools with destructiveHint=false", () => {
			const verdict = defaultActionFirewall.evaluate(
				makeMcpToolContext("mcp_server_read_file", {
					destructiveHint: false,
				}),
			);
			expect(verdict.action).toBe("allow");
		});

		it("allows MCP tools with no annotations", () => {
			const verdict = defaultActionFirewall.evaluate(
				makeMcpToolContext("mcp_server_list_files"),
			);
			expect(verdict.action).toBe("allow");
		});

		it("allows MCP tools with readOnlyHint=true even if destructiveHint=true", () => {
			// readOnlyHint takes precedence - tool is safe
			const verdict = defaultActionFirewall.evaluate(
				makeMcpToolContext("mcp_server_safe_delete", {
					readOnlyHint: true,
					destructiveHint: true,
				}),
			);
			expect(verdict.action).toBe("allow");
		});

		it("does not apply MCP annotation rule to non-MCP tools", () => {
			const verdict = defaultActionFirewall.evaluate({
				toolName: "bash",
				args: { command: "echo safe" },
				metadata: {
					annotations: { destructiveHint: true },
				},
			});
			// Should not trigger MCP rule (bash doesn't start with mcp_)
			expect(verdict.action).toBe("allow");
		});

		it("allows MCP tools with only readOnlyHint=true", () => {
			const verdict = defaultActionFirewall.evaluate(
				makeMcpToolContext("mcp_server_query", {
					readOnlyHint: true,
				}),
			);
			expect(verdict.action).toBe("allow");
		});

		it("allows MCP tools with idempotentHint and openWorldHint", () => {
			const verdict = defaultActionFirewall.evaluate(
				makeMcpToolContext("mcp_server_fetch", {
					idempotentHint: true,
					openWorldHint: true,
				}),
			);
			expect(verdict.action).toBe("allow");
		});
	});
});
