import { DEFAULT_GUARDED_FILE_PATTERNS } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_GUARDED_FILE_RULES,
	DEFAULT_GUARDED_FILE_RULE_ID,
	describeDefaultGuardedFileMatch,
	findDefaultGuardedFileMatch,
	findDefaultGuardedToolCallMatch,
	findGuardedFileMatch,
	findGuardedToolCallMatch,
} from "../../src/safety/guarded-files.js";

const options = {
	cwd: "/workspace/project",
	homeDir: "/Users/tester",
	env: {
		APPDATA: "C:/Users/tester/AppData/Roaming",
		LOCALAPPDATA: "C:/Users/tester/AppData/Local",
		ProgramData: "C:/ProgramData",
	},
};

describe("default guarded files", () => {
	it("uses the shared guarded-files contract for runtime defaults", () => {
		expect(DEFAULT_GUARDED_FILE_RULES).toEqual(
			DEFAULT_GUARDED_FILE_PATTERNS.map(({ key, description, patterns }) => ({
				key,
				category: description,
				patterns,
			})),
		);
	});

	it("matches SSH and GPG material from absolute and tilde paths", () => {
		expect(
			findDefaultGuardedFileMatch("/Users/tester/.ssh/config", options),
		).toMatchObject({
			ruleId: DEFAULT_GUARDED_FILE_RULE_ID,
			key: "ssh-gpg-keys",
			category: "SSH and GPG keys",
		});
		expect(
			findDefaultGuardedFileMatch("~/.gnupg/private-keys-v1.d/key", options),
		).toMatchObject({
			key: "ssh-gpg-keys",
			category: "SSH and GPG keys",
		});
	});

	it("matches editor and agent configuration defaults", () => {
		const paths = [
			"/workspace/project/.cursor/settings.json",
			"/workspace/project/.windsurf/config.json",
			"/workspace/project/.idea/workspace.xml",
			"/workspace/project/amp.json",
			"/Users/tester/.config/nvim/init.lua",
			"/Users/tester/.config/JetBrains/options.xml",
			"/Users/tester/.gemini/settings.json",
		];

		for (const path of paths) {
			expect(findDefaultGuardedFileMatch(path, options), path).not.toBeNull();
		}
	});

	it("matches shell rc files only in the user's home directory", () => {
		expect(
			findDefaultGuardedFileMatch("/Users/tester/.zshrc", options),
		).toMatchObject({
			key: "shell-config",
			category: "Shell configuration",
		});
		expect(
			findDefaultGuardedFileMatch(
				"/Users/tester/.config/fish/config.fish",
				options,
			),
		).toMatchObject({
			category: "Shell configuration",
		});
		expect(
			findDefaultGuardedFileMatch(
				"/Users/tester/.config/fish/conf.d/aliases.fish",
				options,
			),
		).toMatchObject({
			category: "Shell configuration",
		});
		expect(
			findDefaultGuardedFileMatch("/workspace/project/.zshrc", options),
		).toBeNull();
		expect(
			findDefaultGuardedFileMatch(
				"/Users/tester/.config/fish/config.fish",
				options,
			),
		).toMatchObject({
			category: "Shell configuration",
		});
		expect(
			findDefaultGuardedFileMatch(
				"/Users/tester/.config/fish/conf.d/prompt.fish",
				options,
			),
		).toMatchObject({
			category: "Shell configuration",
		});
	});

	it("matches guarded paths referenced through shell environment tokens", () => {
		expect(findDefaultGuardedFileMatch("$HOME/.bashrc", options)).toMatchObject(
			{
				category: "Shell configuration",
			},
		);
		expect(
			findDefaultGuardedFileMatch("${HOME}/.config/nvim/init.lua", options),
		).toMatchObject({
			category: "Neovim configuration",
		});
	});

	it("expands Windows profile environment patterns when configured", () => {
		expect(
			findDefaultGuardedFileMatch(
				"C:/Users/tester/AppData/Roaming/Cursor/User/settings.json",
				options,
			),
		).toMatchObject({
			category: "Cursor configuration",
		});
		expect(
			findDefaultGuardedFileMatch(
				"%APPDATA%/Cursor/User/settings.json",
				options,
			),
		).toMatchObject({
			category: "Cursor configuration",
		});
		expect(
			findDefaultGuardedFileMatch(
				"C:/Users/tester/AppData/Local/JetBrains/toolbox.json",
				options,
			),
		).toMatchObject({
			category: "JetBrains application configuration",
		});
	});

	it("does not match ordinary project files", () => {
		expect(
			findDefaultGuardedFileMatch("/workspace/project/src/index.ts", options),
		).toBeNull();
	});

	it("matches guarded paths embedded in shell commands", () => {
		expect(
			findDefaultGuardedToolCallMatch(
				"bash",
				{ command: "cat $HOME/.ssh/config" },
				options,
			),
		).toMatchObject({
			category: "SSH and GPG keys",
		});
		expect(
			findDefaultGuardedToolCallMatch(
				"bash",
				{ command: 'cat "/Users/tester/.config/nvim/init.lua"' },
				options,
			),
		).toMatchObject({
			category: "Neovim configuration",
		});
		expect(
			findDefaultGuardedToolCallMatch(
				"bash",
				{ command: "cat config", cwd: "~/.ssh" },
				options,
			),
		).toMatchObject({
			category: "SSH and GPG keys",
		});
		expect(
			findDefaultGuardedToolCallMatch(
				"background_tasks",
				{ command: "cat init.lua", cwd: "~/.config/nvim" },
				options,
			),
		).toMatchObject({
			category: "Neovim configuration",
		});
	});

	it("matches guarded paths passed to read-capable search and list tools", () => {
		expect(
			findDefaultGuardedToolCallMatch(
				"search",
				{ pattern: "Host", paths: ["~/.ssh"] },
				options,
			),
		).toMatchObject({
			category: "SSH and GPG keys",
		});
		expect(
			findDefaultGuardedToolCallMatch(
				"parallel_ripgrep",
				{ patterns: ["token"], cwd: "$HOME/.config/nvim" },
				options,
			),
		).toMatchObject({
			category: "Neovim configuration",
		});
		expect(
			findDefaultGuardedToolCallMatch(
				"list",
				{ path: "/Users/tester/.gnupg" },
				options,
			),
		).toMatchObject({
			category: "SSH and GPG keys",
		});
		expect(
			findDefaultGuardedToolCallMatch(
				"search",
				{ pattern: "Host", cwd: "~", paths: [".ssh"] },
				options,
			),
		).toMatchObject({
			category: "SSH and GPG keys",
		});
		expect(
			findDefaultGuardedToolCallMatch(
				"diff",
				{ cwd: "$HOME", paths: [".config/nvim"] },
				options,
			),
		).toMatchObject({
			category: "Neovim configuration",
		});
	});

	it("honors user allowlist entries by guard key", () => {
		expect(
			findGuardedFileMatch("/Users/tester/.ssh/config", {
				...options,
				policy: {
					user: { allowlist: ["ssh-gpg-keys"] },
				},
			}),
		).toBeNull();
	});

	it("honors path allowlist entries without allowing sibling guarded files", () => {
		expect(
			findGuardedFileMatch("/Users/tester/.ssh/internal-only", {
				...options,
				policy: {
					user: { allowlist: ["/Users/tester/.ssh/internal-only"] },
				},
			}),
		).toBeNull();
		expect(
			findGuardedFileMatch("/Users/tester/.ssh/config", {
				...options,
				policy: {
					user: { allowlist: ["/Users/tester/.ssh/internal-only"] },
				},
			}),
		).toMatchObject({
			key: "ssh-gpg-keys",
		});
	});

	it("does not allow mandatory org guards to be bypassed by user allowlists", () => {
		expect(
			findGuardedFileMatch("/Users/tester/.ssh/config", {
				...options,
				policy: {
					organization: { mandatoryKeys: ["ssh-gpg-keys"] },
					user: { allowlist: ["ssh-gpg-keys", "/Users/tester/.ssh/config"] },
				},
			}),
		).toMatchObject({
			key: "ssh-gpg-keys",
			mandatory: true,
		});
	});

	it("matches custom org and user guard extensions", () => {
		expect(
			findGuardedToolCallMatch(
				"read",
				{ path: "/workspace/project/.secrets/token.txt" },
				{
					...options,
					policy: {
						organization: {
							rules: [
								{
									key: "org-secrets",
									description: "Organization secret fixtures",
									patterns: ["**/.secrets/**"],
									reason: "Organization policy controls secret fixtures.",
									defaultBehavior: "block",
								},
							],
						},
					},
				},
			),
		).toMatchObject({
			key: "org-secrets",
			source: "organization",
			defaultBehavior: "block",
		});

		expect(
			findGuardedFileMatch("/workspace/project/private-notes.md", {
				...options,
				policy: {
					user: {
						rules: [
							{
								key: "personal-notes",
								description: "Personal notes",
								patterns: ["**/private-notes.md"],
								defaultBehavior: "ask",
							},
						],
					},
				},
			}),
		).toMatchObject({
			key: "personal-notes",
			source: "user",
		});
	});

	it("prefers block matches across multi-path tool calls", () => {
		expect(
			findGuardedToolCallMatch(
				"move_file",
				{
					source: "/workspace/project/.cursor/settings.json",
					destination: "/workspace/project/.secrets/token.txt",
				},
				{
					...options,
					policy: {
						organization: {
							rules: [
								{
									key: "org-secrets",
									description: "Organization secret fixtures",
									patterns: ["**/.secrets/**"],
									defaultBehavior: "block",
								},
							],
						},
					},
				},
			),
		).toMatchObject({
			key: "org-secrets",
			path: "/workspace/project/.secrets/token.txt",
			defaultBehavior: "block",
		});
	});

	it("prefers block matches over approval matches for the same path", () => {
		expect(
			findGuardedFileMatch("/Users/tester/.ssh/config", {
				...options,
				policy: {
					organization: {
						rules: [
							{
								key: "org-ssh-freeze",
								description: "Organization SSH freeze",
								patterns: ["~/.ssh/config"],
								defaultBehavior: "block",
							},
						],
					},
				},
			}),
		).toMatchObject({
			key: "org-ssh-freeze",
			defaultBehavior: "block",
		});
	});

	it("does not allow allowlists to bypass block guards", () => {
		expect(
			findGuardedFileMatch("/workspace/project/.secrets/token.txt", {
				...options,
				policy: {
					organization: {
						rules: [
							{
								key: "org-secrets",
								description: "Organization secret fixtures",
								patterns: ["**/.secrets/**"],
								defaultBehavior: "block",
							},
						],
					},
					user: {
						allowlist: ["org-secrets", "/workspace/project/.secrets/token.txt"],
					},
				},
			}),
		).toMatchObject({
			key: "org-secrets",
			defaultBehavior: "block",
		});
	});

	it("describes blocked guarded file matches as blocked", () => {
		const match = findGuardedFileMatch(
			"/workspace/project/.secrets/token.txt",
			{
				...options,
				policy: {
					organization: {
						rules: [
							{
								key: "org-secrets",
								description: "Organization secret fixtures",
								patterns: ["**/.secrets/**"],
								defaultBehavior: "block",
							},
						],
					},
				},
			},
		);
		expect(match).not.toBeNull();
		expect(describeDefaultGuardedFileMatch(match!)).toContain(
			"is blocked by policy",
		);
		expect(describeDefaultGuardedFileMatch(match!)).not.toContain(
			"requires explicit approval",
		);
	});
});
