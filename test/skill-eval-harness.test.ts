import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { handleSkillCommand } from "../src/cli/commands/skill.js";
import {
	evaluateSkillPackages,
	formatSkillEvalText,
	hasSkillEvalFailures,
} from "../src/skills/index.js";

const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-skill-eval-"));
	tempDirs.push(dir);
	return dir;
}

async function writeSkillPackage(
	root: string,
	name: string,
	options: { mcpTools?: string[]; toolbox?: boolean } = {},
): Promise<string> {
	const skillDir = join(root, name);
	await mkdir(join(skillDir, "reference"), { recursive: true });
	if (options.toolbox) {
		await mkdir(join(skillDir, "toolbox"), { recursive: true });
		const toolPath = join(
			skillDir,
			"toolbox",
			process.platform === "win32" ? "describe.cmd" : "describe.sh",
		);
		writeFileSync(
			toolPath,
			process.platform === "win32"
				? '@echo off\r\nif "%MAESTRO_TOOLBOX_ACTION%"=="describe" (\r\n  echo {"name":"describe"}\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n'
				: '#!/usr/bin/env bash\nif [ "$MAESTRO_TOOLBOX_ACTION" = describe ]; then echo \'{"name":"describe"}\'; exit 0; fi\nexit 0\n',
		);
		if (process.platform !== "win32") {
			chmodSync(toolPath, 0o755);
		}
	}
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: "Evaluate ${name}. Use when the user asks for Agent Core skill validation."\nallowed-tools:\n  - read\nbuiltin-tools:\n  - read\nisolatedContext: true\n---\n\n# ${name}\n\nKeep the package small and load heavy context from reference files.\n`,
	);
	writeFileSync(
		join(skillDir, "reference", "overview.md"),
		"# Overview\n\nReference content stays outside SKILL.md.\n",
	);
	if (options.mcpTools) {
		writeFileSync(
			join(skillDir, "mcp.json"),
			JSON.stringify({
				github: {
					command: "npx",
					args: ["-y", "server"],
					includeTools: options.mcpTools,
				},
			}),
		);
	}
	return skillDir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	process.exitCode = undefined;
});

describe("skill package eval harness", () => {
	it("scores expected pass and fail skill package cases", async () => {
		const root = tempRoot();
		const valid = await writeSkillPackage(root, "shipping-releases", {
			mcpTools: ["get_pull_request"],
			toolbox: true,
		});
		const invalid = await writeSkillPackage(root, "unsafe-runtime", {
			mcpTools: [],
		});

		const report = await evaluateSkillPackages([
			{ id: "valid-agent-core-package", path: valid, expectedOutcome: "pass" },
			{ id: "invalid-unfiltered-mcp", path: invalid, expectedOutcome: "fail" },
		]);

		expect(report.summary).toEqual({
			total: 2,
			passed: 2,
			failed: 0,
			score: 1,
		});
		expect(report.results[0]).toEqual(
			expect.objectContaining({
				id: "valid-agent-core-package",
				observedOutcome: "pass",
				matchedExpectation: true,
			}),
		);
		expect(report.results[1]).toEqual(
			expect.objectContaining({
				id: "invalid-unfiltered-mcp",
				observedOutcome: "fail",
				matchedExpectation: true,
			}),
		);
		expect(hasSkillEvalFailures(report)).toBe(false);
		expect(formatSkillEvalText(report)).toContain(
			"2 passed, 0 failed, score 1.00",
		);
	});

	it("routes maestro skill eval and emits JSON", async () => {
		const workspace = tempRoot();
		const skillDir = await writeSkillPackage(
			join(workspace, ".maestro", "skills"),
			"reviewing-prs",
		);
		const parsed = parseArgs(["skill", "eval", "--json", skillDir]);

		expect(parsed.command).toBe("skill");
		expect(parsed.subcommand).toBe("eval");
		expect(parsed.commandArgs).toEqual(["--json", skillDir]);

		const originalLog = console.log;
		const output: string[] = [];
		console.log = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			await handleSkillCommand("eval", ["--json", skillDir], {
				workspaceDir: workspace,
			});
		} finally {
			console.log = originalLog;
		}

		const payload = JSON.parse(output.join("\n"));
		expect(payload.summary).toEqual({
			total: 1,
			passed: 1,
			failed: 0,
			score: 1,
		});
		expect(payload.results[0].id).toBe("reviewing-prs");
		expect(payload.results[0].observedOutcome).toBe("pass");
	});
});
