import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluateSkillPackages,
	formatSkillEvalText,
	hasSkillEvalFailures,
} from "../../src/skills/index.js";

async function writePackage(
	root: string,
	name: string,
	options: {
		mcpTools?: string[];
		toolboxMode?: "valid" | "non-executable";
	} = {},
): Promise<string> {
	const skillDir = join(root, name);
	await mkdir(join(skillDir, "reference"), { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: "Evaluate ${name}. Use when the user asks for Agent Core package validation."\nallowed-tools:\n  - read\nbuiltin-tools:\n  - read\nisolatedContext: true\n---\n\n# ${name}\n\nKeep core instructions compact and move bulky examples to reference files.\n`,
	);
	writeFileSync(
		join(skillDir, "reference", "overview.md"),
		"# Overview\n\nReference files hold larger examples and remediation notes.\n",
	);
	if (options.mcpTools) {
		writeFileSync(
			join(skillDir, "mcp.json"),
			JSON.stringify(
				{
					github: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-github"],
						includeTools: options.mcpTools,
					},
				},
				null,
				2,
			),
		);
	}
	if (options.toolboxMode) {
		await mkdir(join(skillDir, "toolbox"), { recursive: true });
		const useWindowsTool =
			process.platform === "win32" && options.toolboxMode === "valid";
		const toolPath = join(
			skillDir,
			"toolbox",
			useWindowsTool ? "describe.cmd" : "describe.sh",
		);
		const toolScript = useWindowsTool
			? '@echo off\r\nif "%MAESTRO_TOOLBOX_ACTION%"=="describe" (\r\n  echo {"name":"describe"}\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n'
			: "#!/usr/bin/env bash\nif [ \"$MAESTRO_TOOLBOX_ACTION\" = describe ]; then echo '{\"name\":\"describe\"}'; exit 0; fi\nexit 0\n";
		writeFileSync(toolPath, toolScript);
		if (options.toolboxMode === "valid" && process.platform !== "win32") {
			chmodSync(toolPath, 0o755);
		}
	}
	return skillDir;
}

const root = mkdtempSync(join(tmpdir(), "maestro-skill-package-evals-"));

try {
	const valid = await writePackage(root, "shipping-releases", {
		mcpTools: ["get_pull_request", "list_pull_request_files"],
		toolboxMode: "valid",
	});
	const unfilteredMcp = await writePackage(root, "unfiltered-mcp", {
		mcpTools: [],
	});
	const nonExecutableToolbox = await writePackage(root, "non-executable-toolbox", {
		toolboxMode: "non-executable",
	});
	const firstPartySkillPackages = [
		"pr-review",
		"release-verification",
		"incident-triage",
	].map((name) => ({
		id: `first-party-${name}`,
		path: join(process.cwd(), "skills", name),
		expectedOutcome: "pass" as const,
	}));

	const report = await evaluateSkillPackages(
		[
			...firstPartySkillPackages,
			{
				id: "valid-agent-core-package",
				path: valid,
				expectedOutcome: "pass",
			},
			{
				id: "reject-unfiltered-mcp",
				path: unfilteredMcp,
				expectedOutcome: "fail",
			},
			{
				id: "reject-non-executable-toolbox",
				path: nonExecutableToolbox,
				expectedOutcome: "fail",
			},
		],
		{ describeToolbox: true },
	);

	console.log(formatSkillEvalText(report));
	if (hasSkillEvalFailures(report)) {
		process.exitCode = 1;
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
