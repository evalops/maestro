import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackageCommandHandler } from "../../../src/cli-tui/commands/package-handlers.js";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const tempDir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(tempDir);
	return tempDir;
}

function createContext(
	rawInput: string,
	argumentText = rawInput.replace(/^\/\S+\s*/, ""),
): CommandExecutionContext {
	return {
		command: { name: "package", description: "package" },
		rawInput,
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
});

describe("package command", () => {
	it("adds a configured package to local config by default", async () => {
		const root = createTempDir("maestro-package-command-");
		mkdirSync(join(root, ".maestro"), { recursive: true });

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package add ./vendor/pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining('Added configured package "./vendor/pack"'),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("scope: local"),
		);
		expect(
			readFileSync(join(root, ".maestro", "config.local.toml"), "utf-8"),
		).toContain("../vendor/pack");
	});

	it("removes a configured package and reports fallback scope", async () => {
		const root = createTempDir("maestro-package-command-");
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			'packages = ["../vendor/pack"]\n',
			"utf-8",
		);
		writeFileSync(
			join(root, ".maestro", "config.local.toml"),
			'packages = ["../vendor/pack"]\n',
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package remove ./vendor/pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining('Removed configured package "./vendor/pack"'),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("fallback: still configured in project"),
		);
		expect(
			readFileSync(join(root, ".maestro", "config.local.toml"), "utf-8"),
		).toBe("");
	});

	it("lists configured packages from project config", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "vendor", "pack");
		mkdirSync(join(packageDir, "skills", "package-skill"), {
			recursive: true,
		});
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/listed-package",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			'packages = [{ source = "../vendor/pack", skills = ["package-skill"] }]\n',
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package list"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Configured Maestro Packages:"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("@test/listed-package"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Filters: skills=package-skill"),
		);
	});

	it("surfaces configured package inspection errors in list output", async () => {
		const root = createTempDir("maestro-package-command-");
		mkdirSync(join(root, ".maestro"), { recursive: true });
		writeFileSync(
			join(root, ".maestro", "config.toml"),
			'packages = ["git:github.com/evalops/maestro"]\n',
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package list"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Git source resolution not yet implemented"),
		);
	});

	it("inspects a valid package from a quoted local path", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "my package");
		mkdirSync(join(packageDir, "skills", "review-skill"), { recursive: true });
		mkdirSync(join(packageDir, "prompts", "release-note"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/my-package",
				version: "1.2.3",
				keywords: ["maestro-package"],
				maestro: {
					skills: ["./skills"],
					prompts: ["./prompts"],
				},
			}),
			"utf-8",
		);

		const addContent = vi.fn();
		const requestRender = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender,
		});

		await handler(createContext('/plugin "./my package"'));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Maestro Package Inspection:"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Name: @test/my-package"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Skills: 1 (review-skill)"),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Prompts: 1 (release-note)"),
		);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("reports validation success for a valid local package", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "pack");
		mkdirSync(join(packageDir, "extensions", "my-extension"), {
			recursive: true,
		});
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/validated-package",
				keywords: ["maestro-package"],
				maestro: {
					extensions: ["./extensions"],
				},
			}),
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package validate ./pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Package validation passed."),
		);
		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("Extensions: 1"),
		);
	});

	it("reports missing maestro-package keyword during validation", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "pack");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/not-maestro",
				maestro: {
					skills: ["./skills"],
				},
			}),
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package validate ./pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining('Missing "maestro-package" keyword.'),
		);
	});

	it("reports missing manifest paths during validation", async () => {
		const root = createTempDir("maestro-package-command-");
		const packageDir = join(root, "pack");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@test/missing-dirs",
				keywords: ["maestro-package"],
				maestro: {
					themes: ["./themes"],
				},
			}),
			"utf-8",
		);

		const addContent = vi.fn();
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent,
			requestRender: vi.fn(),
		});

		await handler(createContext("/package validate ./pack"));

		expect(addContent).toHaveBeenCalledWith(
			expect.stringContaining("themes path does not exist: ./themes"),
		);
	});

	it("surfaces unimplemented remote package resolution honestly", async () => {
		const root = createTempDir("maestro-package-command-");
		const ctx = createContext(
			"/package inspect git:github.com/evalops/maestro",
		);
		const handler = createPackageCommandHandler({
			cwd: root,
			addContent: vi.fn(),
			requestRender: vi.fn(),
		});

		await handler(ctx);

		expect(ctx.showError).toHaveBeenCalledWith(
			expect.stringContaining("Git source resolution not yet implemented"),
		);
	});
});
