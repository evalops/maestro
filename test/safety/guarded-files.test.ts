import { describe, expect, it } from "vitest";
import {
	DEFAULT_GUARDED_FILE_RULE_ID,
	findDefaultGuardedFileMatch,
	findDefaultGuardedToolCallMatch,
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
	it("matches SSH and GPG material from absolute and tilde paths", () => {
		expect(
			findDefaultGuardedFileMatch("/Users/tester/.ssh/config", options),
		).toMatchObject({
			ruleId: DEFAULT_GUARDED_FILE_RULE_ID,
			category: "SSH and GPG keys",
		});
		expect(
			findDefaultGuardedFileMatch("~/.gnupg/private-keys-v1.d/key", options),
		).toMatchObject({
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
});
