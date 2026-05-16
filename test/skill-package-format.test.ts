import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { handleSkillCommand } from "../src/cli/commands/skill.js";
import { buildSkillArtifactMetadata } from "../src/skills/artifact-metadata.js";
import {
	buildSkillRuntimeActivation,
	hasSkillLintErrors,
	isWindowsRunnableToolboxEntry,
	lintSkillDirectory,
	loadSkills,
	parseFrontmatter,
	scaffoldSkill,
	shouldUseShellForToolboxDescribe,
	skillToDict,
	toolboxDescribeSpawnCommand,
} from "../src/skills/index.js";

const tempDirs: string[] = [];
const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(value: string): string {
	return value.replace(ANSI_REGEX, "");
}

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-skill-package-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	process.exitCode = undefined;
});

describe("skill package format", () => {
	it("loads Agent Core package metadata without loading reference content", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "reviewing-prs");
		await mkdir(join(skillDir, "reference"), { recursive: true });
		await mkdir(join(skillDir, "toolbox"), { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: reviewing-prs\ndescription: "Review pull requests. Use when the user asks for PR review."\nallowed-tools:\n  - read\n  - search\nbuiltin-tools:\n  - read\nmodel: gpt-5.5\nmode: review\nisolatedContext: true\n---\n\n# Reviewing PRs\n\nKeep findings first.\n`,
		);
		writeFileSync(
			join(skillDir, "mcp.json"),
			JSON.stringify(
				{
					github: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-github"],
						includeTools: ["get_pull_request", "list_pull_request_files"],
					},
				},
				null,
				2,
			),
		);
		writeFileSync(join(skillDir, "mcp.json.example"), "{}\n");
		writeFileSync(
			join(skillDir, "reference", "rubric.md"),
			"# Rubric\n\nFind bugs before style notes.\n",
		);

		const { skills, errors } = loadSkills(workspace, { includeSystem: false });

		expect(errors).toEqual([]);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("reviewing-prs");
		expect(skills[0]?.allowedTools).toEqual(["read", "search"]);
		expect(skills[0]?.builtinTools).toEqual(["read"]);
		expect(skills[0]?.model).toBe("gpt-5.5");
		expect(skills[0]?.mode).toBe("review");
		expect(skills[0]?.isolatedContext).toBe(true);
		expect(skills[0]?.resourceDirs.referenceDir).toBe(
			join(skillDir, "reference"),
		);
		expect(skills[0]?.resourceDirs.toolboxDir).toBe(join(skillDir, "toolbox"));
		expect(skills[0]?.resourceDirs.mcpJsonPath).toBe(
			join(skillDir, "mcp.json"),
		);
		expect(skills[0]?.resources.map((resource) => resource.name)).not.toContain(
			"mcp.json",
		);
		expect(skills[0]?.resources.map((resource) => resource.name)).not.toContain(
			"mcp.json.example",
		);
	});

	it("emits the runtime activation contract from skill inspect json", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "reviewing-prs");
		await mkdir(join(skillDir, "reference"), { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: reviewing-prs\ndescription: "Review pull requests. Use when the user asks for PR review."\nallowed-tools:\n  - read\nbuiltin-tools:\n  - read\nisolatedContext: true\n---\n\n# Reviewing PRs\n`,
		);
		writeFileSync(
			join(skillDir, "mcp.json"),
			JSON.stringify({
				github: {
					command: "npx",
					includeTools: ["get_pull_request"],
					env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
				},
			}),
		);

		const originalLog = console.log;
		const logs: string[] = [];
		console.log = (...args: unknown[]) => {
			logs.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			await handleSkillCommand("inspect", ["reviewing-prs", "--json"], {
				workspaceDir: workspace,
			});
		} finally {
			console.log = originalLog;
		}

		const payload = JSON.parse(logs.join("\n")) as {
			runtimeActivation?: {
				name: string;
				tools: { allowed: string[]; builtin: string[] };
				resources: { directories: { reference?: string } };
				toolPackage: {
					mcp?: {
						configPath: string;
						servers: Array<{ name: string; includeTools: string[] }>;
					};
				};
			};
		};

		expect(payload.runtimeActivation).toMatchObject({
			name: "reviewing-prs",
			tools: { allowed: ["read"], builtin: ["read"] },
			resources: { directories: { reference: join(skillDir, "reference") } },
			toolPackage: {
				mcp: {
					configPath: join(skillDir, "mcp.json"),
					servers: [{ name: "github", includeTools: ["get_pull_request"] }],
				},
			},
		});
		expect(
			payload.runtimeActivation?.toolPackage.mcp?.servers[0],
		).not.toHaveProperty("env");
	});

	it("accepts quoted isolatedContext consistently across load and lint", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "reviewing-prs");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: reviewing-prs\ndescription: "Review pull requests. Use when the user asks for PR review."\nisolatedContext: "true"\n---\n\n# Reviewing PRs\n`,
		);

		const lintResult = await lintSkillDirectory(skillDir);
		const loaded = loadSkills(workspace, { includeSystem: false });

		expect(hasSkillLintErrors([lintResult])).toBe(false);
		expect(loaded.errors).toEqual([]);
		expect(loaded.skills[0]?.isolatedContext).toBe(true);
	});

	it("coerces scalar metadata frontmatter values to strings", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "shipping-releases");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: shipping-releases\ndescription: "Ship releases. Use when the user asks for release validation."\nmetadata:\n  currentVersion: 1.2\n  workspaceId: 42\n  dryRun: true\n  nested:\n    ignored: true\n---\n\n# Shipping Releases\n`,
		);

		const { skills, errors } = loadSkills(workspace, { includeSystem: false });

		expect(errors).toEqual([]);
		expect(skills[0]?.metadata).toEqual({
			currentVersion: "1.2",
			workspaceId: "42",
			dryRun: "true",
		});
		expect(buildSkillArtifactMetadata(skills[0]!).version).toBe("1.2");
		expect(buildSkillArtifactMetadata(skills[0]!).workspaceId).toBe("42");
	});

	it("ignores non-string package metadata fields", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "shipping-releases");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: shipping-releases\ndescription: "Ship releases. Use when the user asks for release validation."\nlicense: 2.0\ncompatibility: ">=0.10"\n---\n\n# Shipping Releases\n`,
		);

		const { skills, errors } = loadSkills(workspace, { includeSystem: false });

		expect(errors).toEqual([]);
		expect(skills[0]?.license).toBeUndefined();
		expect(skills[0]?.compatibility).toBe(">=0.10");
	});

	it("rejects non-string compatibility metadata fields", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "shipping-releases");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: shipping-releases\ndescription: "Ship releases. Use when the user asks for release validation."\ncompatibility: 0\n---\n\n# Shipping Releases\n`,
		);

		const lintResult = await lintSkillDirectory(skillDir);
		const loaded = loadSkills(workspace, { includeSystem: false });

		expect(hasSkillLintErrors([lintResult])).toBe(true);
		expect(lintResult.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "invalid_compatibility",
					severity: "error",
				}),
			]),
		);
		expect(loaded.skills).toEqual([]);
		expect(loaded.errors[0]?.code).toBe("INVALID_COMPATIBILITY");
	});

	it("rejects mixed-type tool permission lists", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "reviewing-prs");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: reviewing-prs\ndescription: "Review pull requests. Use when the user asks for PR review."\nallowed-tools:\n  - read\n  - 123\nbuiltin-tools:\n  - read\n---\n\n# Reviewing PRs\n`,
		);

		const lintResult = await lintSkillDirectory(skillDir);
		const loaded = loadSkills(workspace, { includeSystem: false });

		expect(hasSkillLintErrors([lintResult])).toBe(true);
		expect(lintResult.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "invalid_string_list",
					severity: "error",
				}),
			]),
		);
		expect(loaded.skills).toEqual([]);
		expect(loaded.errors[0]?.code).toBe("INVALID_TOOL_LIST");
	});

	it("fails lint when bundled MCP tools are unfiltered", async () => {
		const skillDir = join(tempRoot(), "researching-code");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: researching-code\ndescription: "Research code paths. Use when the user asks for codebase investigation."\n---\n\n# Researching Code\n`,
		);
		writeFileSync(
			join(skillDir, "mcp.json"),
			JSON.stringify({ github: { command: "npx", args: ["-y", "server"] } }),
		);

		const result = await lintSkillDirectory(skillDir);

		expect(hasSkillLintErrors([result])).toBe(true);
		expect(result.issues.map((issue) => issue.code)).toContain(
			"mcp_tools_unfiltered",
		);
	});

	it("omits mixed-type bundled MCP includeTools from runtime activation", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "reviewing-prs");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: reviewing-prs\ndescription: "Review pull requests. Use when the user asks for PR review."\nallowed-tools:\n  - read\nbuiltin-tools:\n  - read\n---\n\n# Reviewing PRs\n`,
		);
		writeFileSync(
			join(skillDir, "mcp.json"),
			JSON.stringify({
				github: {
					command: "npx",
					includeTools: ["get_pull_request", 42, "list_pull_request_files"],
				},
			}),
		);

		const { skills, errors } = loadSkills(workspace, { includeSystem: false });

		expect(errors).toEqual([]);
		expect(
			buildSkillRuntimeActivation(skills[0]!).toolPackage.mcp,
		).toMatchObject({
			servers: [],
			warnings: [
				"MCP server 'github' includeTools entries must be non-empty strings.",
			],
		});
	});

	it("omits unbounded bundled MCP servers from runtime activation", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "reviewing-prs");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: reviewing-prs\ndescription: "Review pull requests. Use when the user asks for PR review."\n---\n\n# Reviewing PRs\n`,
		);
		writeFileSync(
			join(skillDir, "mcp.json"),
			JSON.stringify({
				github: {
					command: "npx",
				},
				unsafe: {
					includeTools: ["unsafe_tool"],
				},
				linear: {
					command: "npx",
					includeTools: ["get_issue"],
				},
			}),
		);

		const { skills, errors } = loadSkills(workspace, { includeSystem: false });

		expect(errors).toEqual([]);
		expect(
			buildSkillRuntimeActivation(skills[0]!).toolPackage.mcp,
		).toMatchObject({
			servers: [{ name: "linear", includeTools: ["get_issue"] }],
			warnings: [
				"MCP server 'github' does not declare bounded includeTools.",
				"MCP server 'unsafe' requires a non-empty command.",
			],
		});
	});

	it("degrades oversized MCP configs to bounded activation warnings", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "oversized-mcp");
		await mkdir(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: oversized-mcp\ndescription: Test oversized MCP activation surfaces.\n---\n\n# Oversized MCP\n",
		);
		writeFileSync(join(skillDir, "mcp.json"), " ".repeat(1024 * 1024 + 1));

		const { skills, errors } = loadSkills(workspace, { includeSystem: false });

		expect(errors).toEqual([]);
		expect(
			buildSkillRuntimeActivation(skills[0]!).toolPackage.mcp,
		).toMatchObject({
			servers: [],
			warnings: [expect.stringContaining("mcp.json is too large to load")],
		});
	});

	it("degrades unreadable toolbox directories to an empty activation", async () => {
		if (process.platform === "win32" || process.getuid?.() === 0) {
			return;
		}

		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "reviewing-prs");
		const toolboxDir = join(skillDir, "toolbox");
		await mkdir(toolboxDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: reviewing-prs\ndescription: "Review pull requests. Use when the user asks for PR review."\n---\n\n# Reviewing PRs\n`,
		);
		writeFileSync(join(toolboxDir, "run"), "echo ok\n", { mode: 0o755 });
		const { skills, errors } = loadSkills(workspace, { includeSystem: false });
		chmodSync(toolboxDir, 0o000);

		try {
			expect(errors).toEqual([]);
			expect(
				buildSkillRuntimeActivation(skills[0]!).toolPackage.toolbox,
			).toMatchObject({
				directory: toolboxDir,
				entries: [],
				warnings: [
					expect.stringContaining("toolbox directory could not be read"),
				],
			});
		} finally {
			chmodSync(toolboxDir, 0o700);
		}
	});

	it("classifies Windows toolbox entries by executable extension", () => {
		expect(isWindowsRunnableToolboxEntry("tool.cmd", ".CMD;.EXE")).toBe(true);
		expect(isWindowsRunnableToolboxEntry("tool.exe", ".CMD;.EXE")).toBe(true);
		expect(isWindowsRunnableToolboxEntry("tool.ps1", ".CMD;.EXE")).toBe(false);
		expect(isWindowsRunnableToolboxEntry("tool")).toBe(false);
		expect(shouldUseShellForToolboxDescribe("win32")).toBe(true);
		expect(shouldUseShellForToolboxDescribe("darwin")).toBe(false);
		expect(
			toolboxDescribeSpawnCommand("C:\\Program Files\\tool.cmd", "win32"),
		).toBe('"C:\\Program Files\\tool.cmd"');
		expect(toolboxDescribeSpawnCommand("/usr/local/bin/tool", "darwin")).toBe(
			"/usr/local/bin/tool",
		);
	});

	it("scaffolds a package that passes lint", async () => {
		const root = tempRoot();
		const scaffold = scaffoldSkill(root, "processing-incidents", {
			description:
				"Process incident reports. Use when the user asks for incident triage.",
		});

		const result = await lintSkillDirectory(scaffold.directory);

		expect(
			scaffold.files.map((file) => file.replace(scaffold.directory, "")),
		).toEqual(
			expect.arrayContaining([
				"/SKILL.md",
				"/reference/overview.md",
				"/scripts/README.md",
				"/toolbox/README.md",
				"/mcp.json.example",
			]),
		);
		expect(hasSkillLintErrors([result])).toBe(false);
	});

	it("validates toolbox executables with Windows runnable shapes", async () => {
		const root = tempRoot();
		const invalidSkillDir = join(root, "invalid-toolbox");
		const validSkillDir = join(root, "valid-toolbox");
		await mkdir(join(invalidSkillDir, "toolbox"), { recursive: true });
		await mkdir(join(validSkillDir, "toolbox"), { recursive: true });
		writeFileSync(
			join(invalidSkillDir, "SKILL.md"),
			`---\nname: invalid-toolbox\ndescription: "Run toolbox commands. Use when testing Windows executable validation."\n---\n\n# Invalid Toolbox\n`,
		);
		writeFileSync(join(invalidSkillDir, "toolbox", "run"), "echo nope\n");
		writeFileSync(
			join(validSkillDir, "SKILL.md"),
			`---\nname: valid-toolbox\ndescription: "Run toolbox commands. Use when testing Windows executable validation."\n---\n\n# Valid Toolbox\n`,
		);
		writeFileSync(join(validSkillDir, "toolbox", "run.cmd"), "@echo off\n");

		const invalidResult = await lintSkillDirectory(invalidSkillDir, {
			platform: "win32",
		});
		const validResult = await lintSkillDirectory(validSkillDir, {
			platform: "win32",
		});

		expect(invalidResult.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "toolbox_not_executable" }),
			]),
		);
		expect(hasSkillLintErrors([validResult])).toBe(false);
	});

	it("preserves backslashes in scaffolded descriptions", () => {
		const root = tempRoot();
		const description = "Handle C:\\new folder\\templates literally.";
		const scaffold = scaffoldSkill(root, "handling-windows-paths", {
			description,
		});

		const rawSkill = readFileSync(
			join(scaffold.directory, "SKILL.md"),
			"utf-8",
		);
		const { frontmatter } = parseFrontmatter(rawSkill);

		expect(frontmatter.description).toBe(description);
	});

	it("routes maestro skill as a command with raw command args", () => {
		const parsed = parseArgs(["skill", "lint", "--json", ".maestro/skills"]);

		expect(parsed.command).toBe("skill");
		expect(parsed.subcommand).toBe("lint");
		expect(parsed.commandArgs).toEqual(["--json", ".maestro/skills"]);
	});

	it("supports the skill CLI scaffold command", async () => {
		const workspace = tempRoot();

		await handleSkillCommand(
			"new",
			[
				"testing-ui",
				"--description",
				"Test UI flows. Use when a user asks for browser UI verification.",
				"--json",
			],
			{ workspaceDir: workspace },
		);

		const result = await lintSkillDirectory(
			join(workspace, ".maestro", "skills", "testing-ui"),
		);
		expect(hasSkillLintErrors([result])).toBe(false);
	});

	it("reports load warnings when skill list finds only invalid packages", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "invalid-tools");
		const emptySystemSkills = join(workspace, "empty-system-skills");
		const emptyHome = join(workspace, "empty-home");
		await mkdir(skillDir, { recursive: true });
		await mkdir(emptySystemSkills, { recursive: true });
		await mkdir(emptyHome, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: invalid-tools\ndescription: "Invalid tools. Use when testing error reporting."\nallowed-tools:\n  - read\n  - 123\n---\n\n# Invalid Tools\n`,
		);

		const previousSystemSkills = process.env.MAESTRO_SYSTEM_SKILLS_DIR;
		const previousHome = process.env.MAESTRO_HOME;
		const originalLog = console.log;
		const originalError = console.error;
		const textOutput: string[] = [];
		const errorOutput: string[] = [];
		process.env.MAESTRO_SYSTEM_SKILLS_DIR = emptySystemSkills;
		process.env.MAESTRO_HOME = emptyHome;
		console.log = (...args: unknown[]) => {
			textOutput.push(args.map((arg) => String(arg)).join(" "));
		};
		console.error = (...args: unknown[]) => {
			errorOutput.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			await handleSkillCommand("list", [], {
				workspaceDir: workspace,
				includeSystemSkills: false,
			});
		} finally {
			console.log = originalLog;
			console.error = originalError;
			if (previousSystemSkills === undefined) {
				delete process.env.MAESTRO_SYSTEM_SKILLS_DIR;
			} else {
				process.env.MAESTRO_SYSTEM_SKILLS_DIR = previousSystemSkills;
			}
			if (previousHome === undefined) {
				delete process.env.MAESTRO_HOME;
			} else {
				process.env.MAESTRO_HOME = previousHome;
			}
		}

		expect(textOutput.map(stripAnsi)).toEqual(["No skills found."]);
		expect(errorOutput.map(stripAnsi)).toEqual(["\n1 skill load warning(s)."]);
	});

	it("prints human-readable inspect output unless --json is set", async () => {
		const workspace = tempRoot();
		const skillDir = join(workspace, ".maestro", "skills", "reviewing-prs");
		await mkdir(join(skillDir, "reference"), { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: reviewing-prs\ndescription: "Review pull requests. Use when the user asks for PR review."\nallowed-tools:\n  - read\nbuiltin-tools:\n  - read\nmodel: gpt-5.5\nmode: review\nisolatedContext: true\n---\n\n# Reviewing PRs\n\nKeep findings first.\n`,
		);
		writeFileSync(
			join(skillDir, "reference", "rubric.md"),
			"# Rubric\n\nFind bugs before style notes.\n",
		);

		const skill = loadSkills(workspace, { includeSystem: false }).skills[0]!;
		const expectedJson = JSON.stringify(
			{
				...skillToDict(skill),
				sourceType: skill.sourceType,
				sourcePath: skill.sourcePath,
				resources: skill.resources,
				resourceDirs: skill.resourceDirs,
				runtimeActivation: buildSkillRuntimeActivation(skill),
			},
			null,
			2,
		);

		const originalLog = console.log;
		const textOutput: string[] = [];
		const jsonOutput: string[] = [];

		console.log = (...args: unknown[]) => {
			textOutput.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			await handleSkillCommand("inspect", ["reviewing-prs"], {
				workspaceDir: workspace,
			});
		} finally {
			console.log = originalLog;
		}

		console.log = (...args: unknown[]) => {
			jsonOutput.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			await handleSkillCommand("inspect", ["reviewing-prs", "--json"], {
				workspaceDir: workspace,
			});
		} finally {
			console.log = originalLog;
		}

		expect(textOutput).toHaveLength(1);
		expect(textOutput[0]).toContain("name: 'reviewing-prs'");
		expect(textOutput[0]).toContain("sourceType: 'project'");
		expect(textOutput[0]).not.toBe(expectedJson);
		expect(jsonOutput).toEqual([expectedJson]);
	});
});
