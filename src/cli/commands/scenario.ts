import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { MAESTRO_SCRIPTED_SCENARIO_SCHEMA } from "@evalops/contracts";
import chalk from "chalk";
import { parseScriptedScenario } from "../../agent/providers/scripted.js";
import {
	isRemoteScenarioSource,
	readScenarioJsonSource,
	scenarioSourceBaseDir,
	scenarioSourceLabel,
} from "../../agent/scenario-source.js";
import {
	type MaestroScenario,
	evaluateAgentTrajectoryScenario,
	loadAgentTrajectoryScenarioInputs,
	parseAgentTrajectoryScenario,
	scenarioResultToJunit,
} from "../../server/agent-trajectory-scenarios.js";
import {
	evaluateScriptedScenario,
	scriptedScenarioResultToJunit,
} from "../../server/scripted-scenario-runner.js";

type ScriptedScenario = ReturnType<typeof parseScriptedScenario>;

interface ScenarioCommandOptions {
	json?: boolean;
	junitPath?: string;
}

interface ScenarioOutcomeResult {
	scenario: {
		expectedOutcome: "pass" | "fail";
		observedOutcome: "pass" | "fail";
	};
}

function usage(): never {
	console.error(
		chalk.red(
			'Scenario command required. Try "maestro scenario validate <path>" or "maestro scenario run <path>".',
		),
	);
	process.exit(1);
}

function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index === -1) return undefined;
	return args[index + 1];
}

function positionalArgs(args: string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) continue;
		if (arg === "--json") continue;
		if (arg === "--junit") {
			index++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		result.push(arg);
	}
	return result;
}

function writeJunit(path: string, content: string): void {
	const fullPath = resolve(path);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

function isScriptedReplayJson(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { schemaVersion?: unknown }).schemaVersion ===
			MAESTRO_SCRIPTED_SCENARIO_SCHEMA
	);
}

function outcomeMatchedExpected(result: ScenarioOutcomeResult): boolean {
	return result.scenario.expectedOutcome === result.scenario.observedOutcome;
}

const AGENT_TRAJECTORY_SOURCE_PATH_FIELDS = [
	"trajectoryPath",
	"replayPath",
	"scorePath",
	"inspectionPath",
	"workspaceManifestPath",
	"baselineTrajectoryPath",
	"candidateTrajectoryPath",
	"baselineScorePath",
	"candidateScorePath",
] as const satisfies readonly (keyof MaestroScenario["source"])[];

function rejectRemoteTrajectoryScenarioRelativeSources(
	source: string,
	scenario: MaestroScenario,
): void {
	if (!isRemoteScenarioSource(source)) {
		return;
	}
	for (const field of AGENT_TRAJECTORY_SOURCE_PATH_FIELDS) {
		const path = scenario.source[field];
		if (path && !isAbsolute(path)) {
			throw new Error(
				`Remote scenario ${scenarioSourceLabel(source)} source.${field} must use an absolute path; relative paths are not supported for remote trajectory scenarios.`,
			);
		}
	}
}

function rejectRemoteScriptedScenarioRelativeFileAssertions(
	source: string,
	scenario: ScriptedScenario,
): void {
	if (!isRemoteScenarioSource(source)) {
		return;
	}
	for (const assertion of scenario.assertions ?? []) {
		if (
			(assertion.kind === "file_exists" ||
				assertion.kind === "file_contents") &&
			assertion.path &&
			!isAbsolute(assertion.path)
		) {
			throw new Error(
				`Remote scripted scenario ${scenarioSourceLabel(source)} assertion ${assertion.id} path must be absolute; relative file assertions are not supported for remote scripted scenarios.`,
			);
		}
	}
}

export async function handleScenarioCommand(
	subcommand: string | undefined,
	args: string[],
	options: ScenarioCommandOptions = {},
): Promise<void> {
	if (!subcommand || subcommand === "help") {
		usage();
	}
	const positional = positionalArgs(args);
	const scenarioPath = positional[0];
	if (!scenarioPath) {
		usage();
	}

	if (subcommand === "validate") {
		const scenarioJson = await readScenarioJsonSource(scenarioPath);
		const scenarioLabel = scenarioSourceLabel(scenarioPath);
		const isScriptedReplay = isScriptedReplayJson(scenarioJson);
		if (isScriptedReplay) {
			const scenario = parseScriptedScenario(scenarioJson, scenarioLabel);
			rejectRemoteScriptedScenarioRelativeFileAssertions(
				scenarioPath,
				scenario,
			);
			if (options.json || args.includes("--json")) {
				console.log(
					JSON.stringify(
						{
							status: "pass",
							schemaVersion: scenario.schemaVersion,
							scenarioId: scenario.id,
							frames: scenario.frames.length,
						},
						null,
						2,
					),
				);
				return;
			}
			console.log(
				chalk.green(
					`Validated scripted replay ${scenario.id} (${scenario.frames.length} frame(s)).`,
				),
			);
			return;
		}

		const scenario = parseAgentTrajectoryScenario(scenarioJson, scenarioLabel);
		rejectRemoteTrajectoryScenarioRelativeSources(scenarioPath, scenario);
		if (options.json || args.includes("--json")) {
			console.log(
				JSON.stringify(
					{
						status: "pass",
						schemaVersion: scenario.schemaVersion,
						scenarioId: scenario.id,
						assertions: scenario.assertions.length,
					},
					null,
					2,
				),
			);
			return;
		}
		console.log(
			chalk.green(
				`Validated scenario ${scenario.id} (${scenario.assertions.length} assertion(s)).`,
			),
		);
		return;
	}

	if (subcommand === "run") {
		const scenarioJson = await readScenarioJsonSource(scenarioPath);
		const scenarioLabel = scenarioSourceLabel(scenarioPath);
		const baseDir = scenarioSourceBaseDir(scenarioPath);
		const isScriptedReplay = isScriptedReplayJson(scenarioJson);
		const junitPath = options.junitPath ?? valueAfter(args, "--junit");
		if (isScriptedReplay) {
			const scenario = parseScriptedScenario(scenarioJson, scenarioLabel);
			rejectRemoteScriptedScenarioRelativeFileAssertions(
				scenarioPath,
				scenario,
			);
			const result = evaluateScriptedScenario(scenario, {
				baseDir,
			});
			if (junitPath) {
				writeJunit(junitPath, scriptedScenarioResultToJunit(result));
			}
			if (options.json || args.includes("--json")) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				const summary = `${result.counts.passed}/${result.counts.assertions} passed, ${result.counts.failed} failed, ${result.counts.warnings} warning(s)`;
				const color = outcomeMatchedExpected(result) ? chalk.green : chalk.red;
				console.log(
					color(`Scripted scenario ${result.scenario.id}: ${summary}`),
				);
				for (const assertion of result.assertions) {
					const marker =
						assertion.status === "pass"
							? chalk.green("PASS")
							: assertion.status === "warn"
								? chalk.yellow("WARN")
								: chalk.red("FAIL");
					console.log(`  ${marker} ${assertion.id}: ${assertion.message}`);
				}
			}
			if (!outcomeMatchedExpected(result)) {
				process.exit(1);
			}
			return;
		}

		const scenario = parseAgentTrajectoryScenario(scenarioJson, scenarioLabel);
		rejectRemoteTrajectoryScenarioRelativeSources(scenarioPath, scenario);
		const result = evaluateAgentTrajectoryScenario(
			scenario,
			loadAgentTrajectoryScenarioInputs(scenario, baseDir),
		);
		if (junitPath) {
			writeJunit(junitPath, scenarioResultToJunit(result));
		}
		if (options.json || args.includes("--json")) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			const summary = `${result.counts.passed}/${result.counts.assertions} passed, ${result.counts.failed} failed, ${result.counts.warnings} warning(s)`;
			const color = outcomeMatchedExpected(result) ? chalk.green : chalk.red;
			console.log(color(`Scenario ${result.scenario.id}: ${summary}`));
			for (const assertion of result.assertions) {
				const marker =
					assertion.status === "pass"
						? chalk.green("PASS")
						: assertion.status === "warn"
							? chalk.yellow("WARN")
							: chalk.red("FAIL");
				console.log(`  ${marker} ${assertion.id}: ${assertion.message}`);
			}
		}
		if (!outcomeMatchedExpected(result)) {
			process.exit(1);
		}
		return;
	}

	console.error(chalk.red(`Unknown scenario subcommand: ${subcommand}`));
	usage();
}
