import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkBashCommandForNestedAgent,
	nestedAgentGuard,
} from "../../src/safety/nested-agent-guard.js";

describe("nested-agent-guard hard descendant cap (#2481)", () => {
	beforeEach(() => {
		nestedAgentGuard.resetSpawnCount();
	});

	it("allows a benign command under the cap", () => {
		nestedAgentGuard.recordBashSpawn();
		expect(checkBashCommandForNestedAgent("ls -la")).toBeNull();
	});

	it("fires the session cap after maxTotalBashSpawns calls — regardless of pattern", () => {
		// Drive the counter up with completely benign commands that
		// match no agent-spawn regex. The cap should still fire.
		for (let i = 0; i < 500; i++) {
			nestedAgentGuard.recordBashSpawn();
		}
		nestedAgentGuard.recordBashSpawn();
		const reason = checkBashCommandForNestedAgent("echo hello");
		expect(reason).not.toBeNull();
		expect(reason).toMatch(/maximum bash subprocesses/i);
	});

	it("session cap fires on obfuscated agent spawns (the regex bypass)", () => {
		// `$(echo cl)aude` is the canonical bypass from the issue —
		// the regex won't match because the literal "claude" never
		// appears in the source string. The hard cap must still fire.
		for (let i = 0; i < 500; i++) {
			nestedAgentGuard.recordBashSpawn();
		}
		nestedAgentGuard.recordBashSpawn();
		const reason = checkBashCommandForNestedAgent("$(echo cl)aude --help");
		expect(reason).not.toBeNull();
		expect(reason).toMatch(/fork-bomb-style/i);
	});

	it("rate cap fires when many commands happen in a short window", () => {
		// 120 spawns inside the 60s window
		for (let i = 0; i < 121; i++) {
			nestedAgentGuard.recordBashSpawn();
		}
		const reason = checkBashCommandForNestedAgent("ls");
		expect(reason).not.toBeNull();
		expect(reason).toMatch(/rate cap/i);
	});

	it("resetSpawnCount clears both the session counter and the rate window", () => {
		for (let i = 0; i < 121; i++) {
			nestedAgentGuard.recordBashSpawn();
		}
		expect(checkBashCommandForNestedAgent("ls")).not.toBeNull();

		nestedAgentGuard.resetSpawnCount();
		nestedAgentGuard.recordBashSpawn();
		expect(checkBashCommandForNestedAgent("ls")).toBeNull();
	});

	it("rate-cap check happens before the regex check", () => {
		// If both caps would trigger, the response should mention the
		// generic cap (not the agent-spawn pattern), so the user sees
		// the real reason their command was blocked.
		for (let i = 0; i < 121; i++) {
			nestedAgentGuard.recordBashSpawn();
		}
		const reason = checkBashCommandForNestedAgent("claude --version");
		expect(reason).toMatch(/rate cap|fork-bomb/i);
		expect(reason).not.toMatch(/nesting depth/i);
	});
});

describe("nested-agent-guard HMAC depth token (#2481 part 2)", () => {
	let testHome: string;
	let prevHome: string | undefined;
	let prevDepth: string | undefined;
	let prevToken: string | undefined;
	let prevParentPid: string | undefined;

	beforeEach(() => {
		testHome = mkdtempSync(join(tmpdir(), "maestro-agent-guard-"));
		prevHome = process.env.MAESTRO_HOME;
		prevDepth = process.env.MAESTRO_AGENT_DEPTH;
		prevToken = process.env.MAESTRO_AGENT_DEPTH_TOKEN;
		prevParentPid = process.env.MAESTRO_PARENT_PID;
		process.env.MAESTRO_HOME = testHome;
		delete process.env.MAESTRO_AGENT_DEPTH;
		delete process.env.MAESTRO_AGENT_DEPTH_TOKEN;
		delete process.env.MAESTRO_PARENT_PID;
		nestedAgentGuard.resetForTests();
	});

	afterEach(() => {
		if (prevHome === undefined) delete process.env.MAESTRO_HOME;
		else process.env.MAESTRO_HOME = prevHome;
		if (prevDepth === undefined) delete process.env.MAESTRO_AGENT_DEPTH;
		else process.env.MAESTRO_AGENT_DEPTH = prevDepth;
		if (prevToken === undefined) delete process.env.MAESTRO_AGENT_DEPTH_TOKEN;
		else process.env.MAESTRO_AGENT_DEPTH_TOKEN = prevToken;
		if (prevParentPid === undefined) delete process.env.MAESTRO_PARENT_PID;
		else process.env.MAESTRO_PARENT_PID = prevParentPid;
		if (existsSync(testHome)) {
			rmSync(testHome, { recursive: true, force: true });
		}
		nestedAgentGuard.resetForTests();
	});

	it("first run with no env reaches depth=0 and is not flagged nested", () => {
		nestedAgentGuard.initialize();
		expect(nestedAgentGuard.getDepth()).toBe(0);
		// PPID fallback may or may not fire depending on what spawned
		// the test runner; the important contract here is that no env
		// + a non-agent parent leaves depth at 0.
	});

	it("first run also writes a signed token to env for our children", () => {
		nestedAgentGuard.initialize();
		const token = process.env.MAESTRO_AGENT_DEPTH_TOKEN;
		expect(token).toBeDefined();
		// Token shape: `<depth>.<hex sig>`
		expect(token).toMatch(/^\d+\.[a-f0-9]{64}$/);
	});

	it("rejects MAESTRO_AGENT_DEPTH set without a signing token", () => {
		// This is the env-stripping bypass attempt: child sets DEPTH=0
		// but lacks the token to sign it. Fail closed at max depth.
		process.env.MAESTRO_AGENT_DEPTH = "0";
		// No token.
		nestedAgentGuard.initialize();
		expect(nestedAgentGuard.getDepth()).toBe(2);
		expect(nestedAgentGuard.isAtMaxDepth()).toBe(true);
	});

	it("rejects a tampered token (invalid HMAC)", () => {
		process.env.MAESTRO_AGENT_DEPTH = "0";
		process.env.MAESTRO_AGENT_DEPTH_TOKEN = `0.${"a".repeat(64)}`;
		nestedAgentGuard.initialize();
		expect(nestedAgentGuard.getDepth()).toBe(2);
		expect(nestedAgentGuard.isAtMaxDepth()).toBe(true);
	});

	it("rejects a malformed token (no dot)", () => {
		process.env.MAESTRO_AGENT_DEPTH_TOKEN = "notatoken";
		nestedAgentGuard.initialize();
		expect(nestedAgentGuard.getDepth()).toBe(2);
	});

	it("accepts a valid token issued by the same trust key (parent → child handoff)", () => {
		// Parent does first-run init: writes a signed token.
		nestedAgentGuard.initialize();
		const inheritedToken = process.env.MAESTRO_AGENT_DEPTH_TOKEN;
		const inheritedDepth = process.env.MAESTRO_AGENT_DEPTH;
		expect(inheritedToken).toBeDefined();

		// Simulate child process startup: same MAESTRO_HOME (=> same
		// trust key file). Reset the in-memory guard to re-init from
		// the inherited env.
		nestedAgentGuard.resetForTests();
		nestedAgentGuard.initialize();

		// Depth should match what the parent wrote (next-depth = 1)
		// and the gate should NOT be at max yet.
		expect(nestedAgentGuard.getDepth()).toBe(Number(inheritedDepth));
		expect(nestedAgentGuard.isAtMaxDepth()).toBe(false);
	});

	it("trust key persists on disk with mode 0o600", async () => {
		nestedAgentGuard.initialize();
		const keyPath = join(testHome, ".runtime-trust-key");
		expect(existsSync(keyPath)).toBe(true);
		const { statSync } = await import("node:fs");
		const mode = statSync(keyPath).mode & 0o777;
		// Some test environments may upgrade to group-readable on
		// rename across filesystems; accept anything where group/other
		// can't read.
		expect(mode & 0o077).toBe(0);
	});

	it("caps nextDepth at MAX_AGENT_DEPTH so max-depth processes cannot mint new tokens", () => {
		// Adversarial-review fix: `nextDepth` is capped with
		// Math.min(this.agentDepth + 1, MAX_AGENT_DEPTH). A process
		// at max depth must set env to MAX_AGENT_DEPTH (not deeper),
		// so the bash-tool firewall `>=` gate blocks further spawns.
		//
		// Round-2 finding on PR #2751 (`discussion_r3425208946`): the
		// prior shape of this test set DEPTH="2" and asserted env was
		// still "2" — but that value matched the test's own setup, so
		// removing the env-write or the cap wouldn't have flipped the
		// assertion. We now set DEPTH to a value HIGHER than
		// MAX_AGENT_DEPTH so the assertion only passes if `initialize`
		// actively writes the capped value back.
		process.env.MAESTRO_AGENT_DEPTH = "5";
		delete process.env.MAESTRO_AGENT_DEPTH_TOKEN;
		// No token + DEPTH set → fail closed at max depth, env rewritten.
		nestedAgentGuard.initialize();
		expect(nestedAgentGuard.isAtMaxDepth()).toBe(true);
		// The env for child processes must be REWRITTEN from "5" → "2".
		// If the env-write or the cap were removed, this assertion fails.
		expect(process.env.MAESTRO_AGENT_DEPTH).toBe("2");
	});

	it("caps the Math.min boundary even when a valid token claims depth=MAX", () => {
		// The previous test exercises the fail-closed branch (no token).
		// This one exercises the legitimate-claim branch: a valid token
		// signs depth=MAX_AGENT_DEPTH, so `this.agentDepth = MAX`. The
		// subsequent `nextDepth = Math.min(agentDepth + 1, MAX)` must
		// resolve to MAX, not MAX+1. Without the `Math.min`, a max-depth
		// process could mint a legitimately-signed token for depth=MAX+1,
		// extending the chain past the bash-tool firewall's `>=` gate.

		// Parent at depth 0 issues a token for its (first) child →
		// child env will say depth=1, token signs "1".
		nestedAgentGuard.initialize();
		// Take the inherited env from depth=1, then have the child re-
		// init at depth=2 by promoting it. Easier: just chain two
		// inheritances.
		let inheritedDepth = process.env.MAESTRO_AGENT_DEPTH;
		nestedAgentGuard.resetForTests();
		nestedAgentGuard.initialize();
		expect(nestedAgentGuard.getDepth()).toBe(Number(inheritedDepth)); // 1
		// One more inheritance — the child of the child runs at MAX.
		inheritedDepth = process.env.MAESTRO_AGENT_DEPTH;
		nestedAgentGuard.resetForTests();
		nestedAgentGuard.initialize();
		expect(nestedAgentGuard.getDepth()).toBe(Number(inheritedDepth)); // 2 = MAX
		expect(nestedAgentGuard.isAtMaxDepth()).toBe(true);
		// The env written for this process's children must be capped at
		// MAX, NOT MAX+1. If `Math.min(...)` were `agentDepth + 1` only,
		// env would now be "3" and this assertion would catch it.
		expect(process.env.MAESTRO_AGENT_DEPTH).toBe("2");
	});
});
