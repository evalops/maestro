import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ActionApprovalContext,
	ActionFirewall,
	defaultActionFirewall,
} from "../../src/safety/action-firewall.js";

// Mock process.cwd to return a known path
const MOCK_CWD = "/Users/test/project";
const originalCwd = process.cwd;

beforeAll(() => {
	process.cwd = () => MOCK_CWD;
});

afterAll(() => {
	process.cwd = originalCwd;
});

function makeWriteContext(path: string): ActionApprovalContext {
	return { toolName: "write", args: { path } };
}

function makeDeleteContext(path: string): ActionApprovalContext {
	return { toolName: "delete_file", args: { target_file: path } };
}

describe("ActionFirewall - Workspace Containment", () => {
	it("allows writing files inside workspace", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("/Users/test/project/src/file.ts"),
		);
		expect(verdict.action).toBe("allow");
	});

	it("allows writing files in nested workspace directories", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("/Users/test/project/src/components/button.tsx"),
		);
		expect(verdict.action).toBe("allow");
	});

	it("requires approval for writing files outside workspace", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("/Users/test/other-project/file.ts"),
		);
		expect(verdict.action).toBe("require_approval");
		expect(verdict).toMatchObject({
			ruleId: "workspace-containment",
		});
	});

	it("requires approval for parent directory traversal", async () => {
		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext("../file.ts"),
		);
		expect(verdict.action).toBe("require_approval");
		expect(verdict).toMatchObject({
			ruleId: "workspace-containment",
		});
	});

	it("requires approval for deletion outside workspace", async () => {
		// Use a path that's outside both workspace and temp dir
		const verdict = await defaultActionFirewall.evaluate(
			makeDeleteContext("/home/otheruser/some-file"),
		);
		expect(verdict.action).toBe("require_approval");
		expect(verdict).toMatchObject({
			ruleId: "workspace-containment",
		});
	});

	it("allows writing to temporary directories", async () => {
		// Should allow OS temp dir
		const { tmpdir } = await import("node:os");
		const tempFile = `${tmpdir()}/scratch.txt`;

		const verdict = await defaultActionFirewall.evaluate(
			makeWriteContext(tempFile),
		);
		expect(verdict.action).toBe("allow");
	});
});
