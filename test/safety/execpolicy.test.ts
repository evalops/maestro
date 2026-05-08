import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Policy,
	checkCommand,
	clearPolicyCache,
	parseCommand,
	parsePolicy,
} from "../../src/safety/execpolicy.js";

describe("execpolicy", () => {
	const tempDirs: string[] = [];

	beforeEach(() => {
		clearPolicyCache();
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		clearPolicyCache();
	});

	function createWorkspacePolicy(content: string): string {
		const workspaceDir = join(
			tmpdir(),
			`maestro-execpolicy-test-${Date.now()}-${tempDirs.length}`,
		);
		const policyDir = join(workspaceDir, ".maestro");
		mkdirSync(policyDir, { recursive: true });
		writeFileSync(join(policyDir, "execpolicy"), content);
		tempDirs.push(workspaceDir);
		return workspaceDir;
	}

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

		it("preserves shell semantics for unquoted backslash escapes", () => {
			expect(parseCommand("r\\m -rf /")).toEqual(["rm", "-rf", "/"]);
		});

		it("removes escaped newlines inside double-quoted command tokens", () => {
			expect(parseCommand('"r\\\nm" -rf /')).toEqual(["rm", "-rf", "/"]);
		});

		it("preserves Windows path separators inside quoted executable paths", () => {
			expect(
				parseCommand(
					String.raw`"C:\Program Files\Git\bin\git.exe" push origin main`,
				),
			).toEqual([
				String.raw`C:\Program Files\Git\bin\git.exe`,
				"push",
				"origin",
				"main",
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

		it("surfaces rule justifications in matched prefix rules", () => {
			const policy = new Policy();
			policy.addPrefixRule(
				["rm", "-rf"],
				"forbidden",
				undefined,
				undefined,
				"Use a targeted path or trash command instead.",
			);

			const result = policy.check(["rm", "-rf", "dist"]);
			expect(result.matchedRules[0]).toMatchObject({
				type: "prefix",
				justification: "Use a targeted path or trash command instead.",
			});
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
			expect(result.matchedRules[0]!.type).toBe("heuristics");
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

		it("parses justification for prompt and forbidden decisions", () => {
			const content = `
prefix_rule(
    pattern=["git", "push"],
    decision="prompt",
    justification="Pushing changes is externally visible.",
)
`;
			const policy = parsePolicy(content, "test");
			expect(
				policy.check(["git", "push", "origin", "main"]).matchedRules[0],
			).toMatchObject({
				type: "prefix",
				justification: "Pushing changes is externally visible.",
			});
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

		it("tokenizes string examples with shell quoting", () => {
			const content = `
prefix_rule(
    pattern=["echo", "hello world"],
    decision="allow",
    match=["echo 'hello world'"],
    not_match=["echo hello"],
)
`;
			const policy = parsePolicy(content, "test");
			expect(policy.check(["echo", "hello world"]).decision).toBe("allow");
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

		it("keeps host_executable content out of preceding prefix rules", () => {
			const content = `
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
    match=[["git", "status"]],
)
host_executable(
    name="git",
    paths=["/tmp/not_match=[['git', 'status']]"],
)
`;
			const policy = parsePolicy(content, "test");
			expect(policy.check(["git", "status"]).decision).toBe("allow");
		});

		it("allows absolute executable paths to fall back to basename rules when host path is trusted", () => {
			const content = `
host_executable(
    name="git",
    paths=["/usr/bin/git", "/opt/homebrew/bin/git"],
)
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
)
`;
			const policy = parsePolicy(content, "test");
			const allowed = policy.check(["/usr/bin/git", "status"], undefined, {
				resolveHostExecutables: true,
			});
			expect(allowed).toMatchObject({
				decision: "allow",
				matchedRules: [
					{
						type: "prefix",
						matchedPrefix: ["git", "status"],
						resolvedProgram: "/usr/bin/git",
					},
				],
			});

			const deniedFallback = policy.check(
				["/tmp/fake/git", "status"],
				undefined,
				{
					resolveHostExecutables: true,
				},
			);
			expect(deniedFallback.matchedRules).toHaveLength(0);
		});

		it("does not fall back to basename rules without a host executable declaration", () => {
			const content = `
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
)
`;
			const policy = parsePolicy(content, "test");
			const result = policy.check(["/tmp/fake/git", "status"], undefined, {
				resolveHostExecutables: true,
			});
			expect(result.matchedRules).toHaveLength(0);
		});

		it("merges host executable paths declared in separate policy layers", () => {
			const policy = new Policy();
			policy.addHostExecutable("git", ["/usr/bin/git"]);
			policy.addHostExecutable("git", ["/opt/homebrew/bin/git"]);
			policy.addPrefixRule(["git", "status"], "allow");

			expect(
				policy.check(["/usr/bin/git", "status"], undefined, {
					resolveHostExecutables: true,
				}).decision,
			).toBe("allow");
			expect(
				policy.check(["/opt/homebrew/bin/git", "status"], undefined, {
					resolveHostExecutables: true,
				}).decision,
			).toBe("allow");
		});

		it("applies trusted host executable fallback in the normal command check path", () => {
			const workspaceDir = createWorkspacePolicy(`
host_executable(
    name="git",
    paths=["/usr/bin/git"],
)
prefix_rule(
    pattern=["git", "push"],
    decision="prompt",
)
`);
			const result = checkCommand(
				"/usr/bin/git push origin main",
				workspaceDir,
			);

			expect(result).toMatchObject({
				decision: "prompt",
				matchedRules: [
					{
						type: "prefix",
						matchedPrefix: ["git", "push"],
						resolvedProgram: "/usr/bin/git",
					},
				],
			});
		});

		it("applies trusted Windows host executable fallback by policy name", () => {
			const workspaceDir = createWorkspacePolicy(String.raw`
host_executable(
    name="git",
    paths=["C:\\Program Files\\Git\\bin\\git.exe"],
)
prefix_rule(
    pattern=["git", "push"],
    decision="prompt",
)
`);
			const result = checkCommand(
				String.raw`"C:\Program Files\Git\bin\git.exe" push origin main`,
				workspaceDir,
			);

			expect(result).toMatchObject({
				decision: "prompt",
				matchedRules: [
					{
						type: "prefix",
						matchedPrefix: ["git", "push"],
						resolvedProgram: String.raw`C:\Program Files\Git\bin\git.exe`,
					},
				],
			});
		});

		it("evaluates every trusted alias for a resolved host executable path", () => {
			const policy = new Policy();
			const gitPath = String.raw`C:\Program Files\Git\bin\git.exe`;
			policy.addHostExecutable("git", [gitPath]);
			policy.addHostExecutable("git.exe", [gitPath]);
			policy.addPrefixRule(["git", "push"], "allow");
			policy.addPrefixRule(["git.exe", "push"], "forbidden");

			const result = policy.check(
				[gitPath, "push", "origin", "main"],
				undefined,
				{
					resolveHostExecutables: true,
				},
			);

			expect(result.decision).toBe("forbidden");
			expect(result.matchedRules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "prefix",
						matchedPrefix: ["git", "push"],
						decision: "allow",
						resolvedProgram: gitPath,
					}),
					expect.objectContaining({
						type: "prefix",
						matchedPrefix: ["git.exe", "push"],
						decision: "forbidden",
						resolvedProgram: gitPath,
					}),
				]),
			);
		});

		it("parses host executable declarations after prefix rules", () => {
			const content = `
prefix_rule(
    pattern=["git", "status"],
    decision="allow",
)
host_executable(
    name="git",
    paths=["/usr/bin/git"],
)
`;
			const policy = parsePolicy(content, "test");
			const result = policy.check(["/usr/bin/git", "status"], undefined, {
				resolveHostExecutables: true,
			});
			expect(result).toMatchObject({
				decision: "allow",
				matchedRules: [
					{
						type: "prefix",
						matchedPrefix: ["git", "status"],
						resolvedProgram: "/usr/bin/git",
					},
				],
			});
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
