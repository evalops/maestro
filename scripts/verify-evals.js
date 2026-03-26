import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(__filename));

export const deterministicEvalScenarioVerifications = [
	{
		name: "read tool returns first line",
		expectedCommand: ["node", "scripts/run-read-tool.js", "README.md"],
		expectedRegex: "Maestro by EvalOps",
		actual: ({ repoRoot }) => {
			const firstLine = readText("README.md", repoRoot).split(/\r?\n/)[0] ?? "";
			return firstLine.trim();
		},
	},
	{
		name: "settings view-model eval suite",
		expectedCommand: [
			"bunx",
			"tsx",
			"scripts/evals/run-settings-view-model-evals.ts",
		],
		expectedRegex: "\\[settings-view-model-evals\\] \\d+/\\d+ passed",
	},
	{
		name: "quick settings eval suite",
		expectedCommand: ["bunx", "tsx", "scripts/evals/run-quick-settings-evals.ts"],
		expectedRegex: "\\[quick-settings-evals\\] \\d+/\\d+ passed",
	},
	{
		name: "openrouter compat eval suite",
		expectedCommand: [
			"bunx",
			"tsx",
			"scripts/evals/run-openrouter-compat-evals.ts",
		],
		expectedRegex: "\\[openrouter-compat-evals\\] \\d+/\\d+ passed",
	},
	{
		name: "approvals flow eval suite",
		expectedCommand: ["bunx", "tsx", "scripts/evals/run-approvals-flow-evals.ts"],
		expectedRegex: "\\[approvals-flow-evals\\] \\d+/\\d+ passed",
	},
	{
		name: "tool surface smoke eval suite",
		expectedCommand: [
			"bunx",
			"tsx",
			"scripts/evals/run-tool-surface-smoke-evals.ts",
		],
		expectedRegex: "\\[tool-surface-smoke-evals\\] \\d+/\\d+ passed",
	},
];

export const liveEvalEntrypointVerifications = [
	{
		scriptName: "evals:openrouter-live-smoke",
		targetName: "evals:openrouter-live-smoke",
		runnerPath: "scripts/evals/run-openrouter-live-smoke.ts",
	},
	{
		scriptName: "evals:openrouter-approvals-judge",
		targetName: "evals:openrouter-approvals-judge",
		runnerPath: "scripts/evals/run-openrouter-approvals-judge-evals.ts",
	},
	{
		scriptName: "evals:openrouter-tool-surface-judge",
		targetName: "evals:openrouter-tool-surface-judge",
		runnerPath: "scripts/evals/run-openrouter-tool-surface-judge-evals.ts",
	},
];


function loadJSON(relativePath, repoRoot = defaultRepoRoot) {
	const absolute = join(repoRoot, relativePath);
	return JSON.parse(readFileSync(absolute, "utf8"));
}

function readText(relativePath, repoRoot = defaultRepoRoot) {
	const absolute = join(repoRoot, relativePath);
	return readFileSync(absolute, "utf8");
}

export function loadEvalConfiguration(repoRoot = defaultRepoRoot) {
	return {
		scenarios: loadJSON("evals/scenarios.json", repoRoot),
		packageJson: loadJSON("package.json", repoRoot),
		projectJson: loadJSON("project.json", repoRoot),
		repoRoot,
	};
}

export function validateEvalConfiguration({
	scenarios,
	packageJson,
	projectJson,
	repoRoot = defaultRepoRoot,
}) {
	const failures = [];

	if (!Array.isArray(scenarios)) {
		return ["evals/scenarios.json must contain a JSON array."];
	}

	for (const validation of deterministicEvalScenarioVerifications) {
		failures.push(
			...validateScenarioDefinition(validation, scenarios, repoRoot),
		);
	}

	for (const entrypoint of liveEvalEntrypointVerifications) {
		failures.push(
			...validateLiveEvalEntrypoint(entrypoint, packageJson, projectJson, repoRoot),
		);
	}

	return failures;
}

function validateScenarioDefinition(validation, scenarios, repoRoot) {
	const failures = [];
	const scenario = scenarios.find((candidate) => candidate.name === validation.name);

	if (!scenario) {
		return [`Missing eval scenario: ${validation.name}`];
	}

	if (validation.expectedRegex && scenario.expectedRegex !== validation.expectedRegex) {
		failures.push(
			`Scenario "${validation.name}" expectedRegex drifted from ${validation.expectedRegex}`,
		);
	}

	if (
		Array.isArray(validation.expectedCommand) &&
		!arrayShallowEqual(scenario.command, validation.expectedCommand)
	) {
		failures.push(
			`Scenario "${validation.name}" command drifted from ${JSON.stringify(validation.expectedCommand)}`,
		);
	}

	const scriptPath = validation.expectedCommand?.[validation.expectedCommand.length - 1];
	if (typeof scriptPath === "string" && scriptPath.startsWith("scripts/")) {
		const scriptAbsolute = join(repoRoot, scriptPath);
		try {
			readFileSync(scriptAbsolute, "utf8");
		} catch {
			failures.push(
				`Scenario "${validation.name}" references missing script ${scriptPath}`,
			);
		}
	}

	if (typeof validation.actual === "function") {
		if (!scenario.expectedRegex) {
			failures.push(
				`Scenario "${validation.name}" is missing expectedRegex; cannot verify sample output`,
			);
		} else {
			const regex = new RegExp(scenario.expectedRegex);
			const sample = validation.actual({ repoRoot });

			if (!regex.test(sample)) {
				failures.push(
					`Scenario "${validation.name}" expectedRegex ${scenario.expectedRegex} does not match sample "${sample}"`,
				);
			}
		}
	}

	return failures;
}

function validateLiveEvalEntrypoint(
	entrypoint,
	packageJson,
	projectJson,
	repoRoot,
) {
	const failures = [];
	const scriptAbsolute = join(repoRoot, entrypoint.runnerPath);

	try {
		readFileSync(scriptAbsolute, "utf8");
	} catch {
		failures.push(`Missing live eval runner: ${entrypoint.runnerPath}`);
	}

	const packageScript = packageJson?.scripts?.[entrypoint.scriptName];
	if (typeof packageScript !== "string") {
		failures.push(`Missing package.json script: ${entrypoint.scriptName}`);
	} else {
		if (!packageScript.includes("run build")) {
			failures.push(
				`package.json script "${entrypoint.scriptName}" must build before running`,
			);
		}
		if (!packageScript.includes(entrypoint.runnerPath)) {
			failures.push(
				`package.json script "${entrypoint.scriptName}" must reference ${entrypoint.runnerPath}`,
			);
		}
	}

	const target = projectJson?.targets?.[entrypoint.targetName];
	if (!target) {
		failures.push(`Missing project.json target: ${entrypoint.targetName}`);
	} else if (target.executor !== "nx:run-commands") {
		failures.push(
			`project.json target "${entrypoint.targetName}" must use nx:run-commands`,
		);
	} else if (target.options?.command !== `bun run ${entrypoint.scriptName}`) {
		failures.push(
			`project.json target "${entrypoint.targetName}" must call "bun run ${entrypoint.scriptName}"`,
		);
	}

	return failures;
}

function arrayShallowEqual(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
		return false;
	}

	return left.every((value, index) => value === right[index]);
}

export function main() {
	const failures = validateEvalConfiguration(loadEvalConfiguration());

	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(failure);
		}
		console.error(
			`Eval verification failed (${failures.length} issue${failures.length === 1 ? "" : "s"}).`,
		);
		process.exit(1);
	}

	console.log("Eval scenarios verified.");
}

function isExecutedDirectly(moduleUrl) {
	const entryPoint = process.argv[1];
	return Boolean(entryPoint) && moduleUrl === pathToFileURL(entryPoint).href;
}

if (isExecutedDirectly(import.meta.url)) {
	main();
}
