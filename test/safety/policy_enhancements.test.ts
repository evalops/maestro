import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionApprovalContext } from "../../src/agent/types.js";
import {
	checkPolicy,
	checkSessionLimits,
	loadPolicy,
} from "../../src/safety/policy.js";

const MOCK_POLICY_PATH = join(homedir(), ".composer", "policy.json");

describe("Policy Enhancements", () => {
	beforeEach(() => {
		vi.resetModules();
		if (existsSync(MOCK_POLICY_PATH)) {
			unlinkSync(MOCK_POLICY_PATH);
		}
	});

	afterEach(() => {
		if (existsSync(MOCK_POLICY_PATH)) {
			unlinkSync(MOCK_POLICY_PATH);
		}
	});

	it("should block obfuscated bash commands", async () => {
		const policy = {
			dependencies: { allowed: ["npm"] }, // Enable dependency check to trigger command scanning
		};
		writeFileSync(MOCK_POLICY_PATH, JSON.stringify(policy));
		loadPolicy(true);

		const dangerousCommands = [
			"echo 'bad' | base64 -d | sh",
			"python -c 'import os; os.system(\"ls\")'",
			"node -e 'console.log(process.env)'",
			"perl -e 'exec \"/bin/sh\"'",
			"php -r 'system(\"ls\");'",
			"ruby -e 'exec \"/bin/sh\"'",
			"eval(base64_decode('...'))", // generic eval catch
		];

		for (const cmd of dangerousCommands) {
			const context: ActionApprovalContext = {
				toolName: "bash",
				args: { command: cmd },
				user: { id: "test", orgId: "test" },
			};
			const result = await checkPolicy(context);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("obfuscated or dangerous patterns");
		}
	});

	it("should enforce session limits", () => {
		const policy = {
			limits: {
				maxSessionDurationMinutes: 10,
				maxTokensPerSession: 1000,
			},
		};
		writeFileSync(MOCK_POLICY_PATH, JSON.stringify(policy));
		loadPolicy(true);

		// Test active session within limit
		const recentSession = {
			startedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 mins ago
		};
		// We must provide token usage if limit is set, otherwise it blocks (fail-closed)
		expect(checkSessionLimits(recentSession, { tokenCount: 0 }).allowed).toBe(
			true,
		);

		// Test expired session
		const oldSession = {
			startedAt: new Date(Date.now() - 11 * 60 * 1000), // 11 mins ago
		};
		const result = checkSessionLimits(oldSession);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("Session duration limit exceeded");

		// Test token limit
		const tokenUsage = { tokenCount: 1500 };
		const tokenResult = checkSessionLimits(recentSession, tokenUsage);
		expect(tokenResult.allowed).toBe(false);
		expect(tokenResult.reason).toContain("Session token limit exceeded");
	});
});
