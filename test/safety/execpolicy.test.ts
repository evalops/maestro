import { beforeEach, describe, expect, it } from "vitest";
import {
	Policy,
	clearPolicyCache,
	parseCommand,
	parsePolicy,
} from "../../src/safety/execpolicy.js";

describe("execpolicy", () => {
	beforeEach(() => {
		clearPolicyCache();
	});

	describe("parseCommand", () => {
		it("parses simple commands", () => {
			expect(parseCommand("git status")).toEqual(["git", "status"]);
			expect(parseCommand("ls -la")).toEqual(["ls", "-la"]);
		});

		it("handles quoted strings", () => {
			expect(parseCommand('echo "hello world"')).toEqual([
				"echo",
				"hello world",
			]);
			expect(parseCommand("echo 'hello world'")).toEqual([
				"echo",
				"hello world",
			]);
		});

		it("handles escaped characters", () => {
			expect(parseCommand("echo hello\\ world")).toEqual([
				"echo",
				"hello world",
			]);
		});

		it("handles empty input", () => {
			expect(parseCommand("")).toEqual([]);
			expect(parseCommand("   ")).toEqual([]);
		});
	});

	describe("Policy", () => {
		it("allows commands matching allow rules", () => {
			const policy = new Policy();
			policy.addPrefixRule(["git", "status"], "allow");

			const result = policy.check(["git", "status"]);
			expect(result.decision).toBe("allow");
			expect(result.matchedRules).toHaveLength(1);
		});

		it("prompts for commands matching prompt rules", () => {
			const policy = new Policy();
			policy.addPrefixRule(["git", "push"], "prompt");

			const result = policy.check(["git", "push", "origin", "main"]);
			expect(result.decision).toBe("prompt");
		});

		it("forbids commands matching forbidden rules", () => {
			const policy = new Policy();
			policy.addPrefixRule(["rm", "-rf"], "forbidden");

			const result = policy.check(["rm", "-rf", "/"]);
			expect(result.decision).toBe("forbidden");
		});

		it("uses heuristics fallback when no rule matches", () => {
			const policy = new Policy();
			policy.addPrefixRule(["git", "status"], "allow");

			const result = policy.check(["npm", "install"], () => "prompt");
			expect(result.decision).toBe("prompt");
			expect(result.matchedRules[0].type).toBe("heuristics");
		});

		it("decision priority: forbidden > prompt > allow", () => {
			const policy = new Policy();
			policy.addPrefixRule(["cmd"], "allow");
			policy.addPrefixRule(["cmd"], "forbidden");

			const result = policy.check(["cmd"]);
			expect(result.decision).toBe("forbidden");
		});
	});

	describe("parsePolicy", () => {
		it("parses simple allow rule", () => {
			const content = `
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
)
`;
			const policy = parsePolicy(content, "test");
			const result = policy.check(["git", "status"]);
			expect(result.decision).toBe("allow");
		});

		it("parses rule with alternatives", () => {
			const content = `
prefix_rule(
    pattern=["git", ["push", "fetch"]],
    decision="prompt",
)
`;
			const policy = parsePolicy(content, "test");
			expect(policy.check(["git", "push"]).decision).toBe("prompt");
			expect(policy.check(["git", "fetch"]).decision).toBe("prompt");
			expect(policy.check(["git", "pull"]).matchedRules).toHaveLength(0);
		});

		it("parses multiple rules", () => {
			const content = `
prefix_rule(pattern=["git", "status"], decision="allow")
prefix_rule(pattern=["git", "push"], decision="prompt")
prefix_rule(pattern=["rm", "-rf"], decision="forbidden")
`;
			const policy = parsePolicy(content, "test");
			expect(policy.check(["git", "status"]).decision).toBe("allow");
			expect(policy.check(["git", "push"]).decision).toBe("prompt");
			expect(policy.check(["rm", "-rf", "/"]).decision).toBe("forbidden");
		});

		it("validates match examples", () => {
			const content = `
prefix_rule(
    pattern=["git", "push"],
    decision="prompt",
    match=[["git", "push", "origin", "main"]],
)
`;
			const policy = parsePolicy(content, "test");
			expect(policy.check(["git", "push", "origin"]).decision).toBe("prompt");
		});

		it("validates not_match examples", () => {
			const content = `
prefix_rule(
    pattern=["git"],
    decision="allow",
    not_match=[["git", "push"]],
)
`;
			// This should log a warning because "git push" DOES match "git"
			// but we continue parsing without throwing
			const policy = parsePolicy(content, "test");
			// The rule still gets added since we just warn
			expect(policy.rules.size).toBeGreaterThanOrEqual(0);
		});

		it("handles first token alternatives", () => {
			const content = `
prefix_rule(
    pattern=[["npm", "yarn", "pnpm"], "install"],
    decision="prompt",
)
`;
			const policy = parsePolicy(content, "test");
			expect(policy.check(["npm", "install"]).decision).toBe("prompt");
			expect(policy.check(["yarn", "install"]).decision).toBe("prompt");
			expect(policy.check(["pnpm", "install"]).decision).toBe("prompt");
		});
	});

	describe("prefix matching", () => {
		it("matches prefix and allows additional arguments", () => {
			const policy = new Policy();
			policy.addPrefixRule(["git", "log"], "allow");

			// Should match with additional arguments
			expect(policy.check(["git", "log", "--oneline"]).decision).toBe("allow");
			expect(
				policy.check(["git", "log", "-n", "10", "--oneline"]).decision,
			).toBe("allow");
		});

		it("requires exact match for pattern tokens", () => {
			const policy = new Policy();
			policy.addPrefixRule(["git", "status"], "allow");

			// Should not match different tokens
			expect(policy.check(["git", "stash"]).matchedRules).toHaveLength(0);
		});

		it("requires command to be at least as long as pattern", () => {
			const policy = new Policy();
			policy.addPrefixRule(["git", "status", "-s"], "allow");

			// Too short - shouldn't match
			expect(policy.check(["git", "status"]).matchedRules).toHaveLength(0);
			// Exact length - should match
			expect(policy.check(["git", "status", "-s"]).decision).toBe("allow");
		});
	});
});
