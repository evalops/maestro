import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
	MaestroScenarioOutcome,
	MaestroScenarioReleaseGate,
	MaestroScenarioRequiredArtifact,
	MaestroScenarioSeverity,
	MaestroScenarioWorkspaceManifest,
	MaestroScriptedScenario,
	MaestroScriptedScenarioAssertion,
	MaestroScriptedScenarioAssertionKind,
	MaestroScriptedStatement,
} from "@evalops/contracts";
import {
	type AgentTrajectoryScenarioReleaseGateSummary,
	type AgentTrajectoryScenarioWorkspaceSummary,
	buildWorkspaceSummary,
	loadScenarioWorkspaceManifest,
} from "./agent-trajectory-scenarios.js";
import { escapeXml } from "./junit-xml.js";

export const SCRIPTED_SCENARIO_RESULT_SCHEMA =
	"evalops.maestro.scripted-scenario-result.v1";

export type ScriptedScenarioAssertionStatus = "pass" | "fail" | "warn";

export interface ScriptedScenarioAssertionEvidence {
	kind: string;
	id: string;
	source: "scenario" | "workspace" | "audit";
	label: string;
}

export interface ScriptedScenarioAssertionResult {
	id: string;
	kind: MaestroScriptedScenarioAssertionKind;
	status: ScriptedScenarioAssertionStatus;
	severity: MaestroScenarioSeverity;
	message: string;
	evidence: ScriptedScenarioAssertionEvidence[];
}

export interface ScriptedScenarioRunResult {
	schemaVersion: typeof SCRIPTED_SCENARIO_RESULT_SCHEMA;
	scenarioSchemaVersion: MaestroScriptedScenario["schemaVersion"];
	scenario: {
		id: string;
		description: string;
		expectedOutcome: MaestroScenarioOutcome;
		observedOutcome: MaestroScenarioOutcome;
	};
	run: {
		scenarioId: string;
		replay: true;
		frames: number;
		toolCalls: number;
		auditEvents: string[];
	};
	counts: {
		assertions: number;
		passed: number;
		failed: number;
		warnings: number;
		workspaceFiles: number;
		toolAdapters: number;
	};
	releaseGate?: AgentTrajectoryScenarioReleaseGateSummary;
	workspace?: AgentTrajectoryScenarioWorkspaceSummary;
	assertions: ScriptedScenarioAssertionResult[];
}

function toolCallStatements(scenario: MaestroScriptedScenario): Array<
	Extract<MaestroScriptedStatement, { kind: "tool_call" }> & {
		frameIndex: number;
		statementIndex: number;
	}
> {
	const calls: Array<
		Extract<MaestroScriptedStatement, { kind: "tool_call" }> & {
			frameIndex: number;
			statementIndex: number;
		}
	> = [];
	for (const frame of scenario.frames) {
		for (const [statementIndex, statement] of frame.statements.entries()) {
			if (statement.kind !== "tool_call") continue;
			calls.push({
				...statement,
				frameIndex: frame.index,
				statementIndex,
			});
		}
	}
	return calls;
}

function evidence(
	kind: string,
	id: string,
	source: ScriptedScenarioAssertionEvidence["source"],
	label = `${kind}:${id}`,
): ScriptedScenarioAssertionEvidence[] {
	return [{ kind, id, source, label }];
}

function pass(
	assertion: MaestroScriptedScenarioAssertion,
	message: string,
	assertionEvidence: ScriptedScenarioAssertionEvidence[] = [],
): ScriptedScenarioAssertionResult {
	return {
		id: assertion.id,
		kind: assertion.kind,
		status: "pass",
		severity: assertion.severity ?? "error",
		message,
		evidence: assertionEvidence,
	};
}

function fail(
	assertion: MaestroScriptedScenarioAssertion,
	message: string,
	assertionEvidence: ScriptedScenarioAssertionEvidence[] = [],
): ScriptedScenarioAssertionResult {
	return {
		id: assertion.id,
		kind: assertion.kind,
		status: assertion.severity === "warning" ? "warn" : "fail",
		severity: assertion.severity ?? "error",
		message,
		evidence: assertionEvidence,
	};
}

function workspaceEvidence(
	manifest: MaestroScenarioWorkspaceManifest,
): ScriptedScenarioAssertionEvidence[] {
	return [
		{
			kind: "workspace_manifest",
			id: manifest.id,
			source: "scenario",
			label: `workspace_manifest:${manifest.id}`,
		},
		...manifest.toolAdapters.map((adapter) => ({
			kind: "tool_adapter",
			id: adapter.tool,
			source: "scenario" as const,
			label: `tool_adapter:${adapter.tool}:${adapter.mode}`,
		})),
	];
}

function manifestWorkspaceFileExists(
	manifest: MaestroScenarioWorkspaceManifest,
	baseDir: string,
	relativePath: string,
): boolean {
	if (manifest.hydration.mode === "manifest_only") return true;
	const rootPath = manifest.hydration.rootPath;
	if (!rootPath) return false;
	if (isAbsolute(relativePath)) return false;
	const rootDir = resolve(baseDir, rootPath);
	const fullPath = resolve(rootDir, relativePath);
	const pathFromRoot = relative(rootDir, fullPath);
	if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return false;
	return existsSync(fullPath) && statSync(fullPath).isFile();
}

function evaluateWorkspaceManifestAssertion(
	assertion: MaestroScriptedScenarioAssertion,
	scenario: MaestroScriptedScenario,
	baseDir: string,
	workspaceManifest: MaestroScenarioWorkspaceManifest | undefined,
): ScriptedScenarioAssertionResult {
	if (!workspaceManifest) {
		return fail(
			assertion,
			"workspace_manifest requires workspaceManifestPath.",
		);
	}
	const manifestFiles = new Set(
		workspaceManifest.files.map((file) => file.path),
	);
	const missingFiles = (assertion.requiredWorkspaceFiles ?? []).filter(
		(path) =>
			!manifestFiles.has(path) ||
			!manifestWorkspaceFileExists(workspaceManifest, baseDir, path),
	);
	const manifestAdapters = new Set(
		workspaceManifest.toolAdapters.map((adapter) => adapter.tool),
	);
	const missingAdapters = (assertion.requiredToolAdapters ?? []).filter(
		(tool) => !manifestAdapters.has(tool),
	);
	const hydrationMismatch =
		assertion.requiredHydrationModes !== undefined &&
		!assertion.requiredHydrationModes.includes(
			workspaceManifest.hydration.mode,
		);
	const tierMismatch =
		assertion.requiredReleaseGateTier !== undefined &&
		scenario.releaseGate?.tier !== assertion.requiredReleaseGateTier;
	const workspaceFileBudgetMissed =
		assertion.minWorkspaceFiles !== undefined &&
		workspaceManifest.files.length < assertion.minWorkspaceFiles;
	const toolAdapterBudgetMissed =
		assertion.minToolAdapters !== undefined &&
		workspaceManifest.toolAdapters.length < assertion.minToolAdapters;
	const failures = [
		missingFiles.length > 0
			? `missing workspace file(s): ${missingFiles.join(", ")}`
			: undefined,
		missingAdapters.length > 0
			? `missing tool adapter(s): ${missingAdapters.join(", ")}`
			: undefined,
		hydrationMismatch
			? `hydration mode ${workspaceManifest.hydration.mode} not allowed`
			: undefined,
		tierMismatch
			? `release gate tier ${scenario.releaseGate?.tier ?? "missing"} did not match ${assertion.requiredReleaseGateTier}`
			: undefined,
		workspaceFileBudgetMissed
			? `workspace files ${workspaceManifest.files.length}/${assertion.minWorkspaceFiles}`
			: undefined,
		toolAdapterBudgetMissed
			? `tool adapters ${workspaceManifest.toolAdapters.length}/${assertion.minToolAdapters}`
			: undefined,
	].filter((value): value is string => value !== undefined);

	if (failures.length > 0) {
		return fail(
			assertion,
			`Workspace manifest check failed: ${failures.join("; ")}.`,
			workspaceEvidence(workspaceManifest),
		);
	}

	return pass(
		assertion,
		`Workspace manifest ${workspaceManifest.id} matched replay requirements.`,
		workspaceEvidence(workspaceManifest),
	);
}

function requireAssertionString(
	assertion: MaestroScriptedScenarioAssertion,
	field: "tool" | "toolCallId" | "path" | "contains" | "equals" | "eventType",
	options: { allowEmpty?: boolean } = {},
): string | undefined {
	const value = assertion[field];
	if (typeof value !== "string") {
		return undefined;
	}
	return value.length > 0 || options.allowEmpty ? value : undefined;
}

function evaluateAssertion(
	assertion: MaestroScriptedScenarioAssertion,
	scenario: MaestroScriptedScenario,
	baseDir: string,
	workspaceManifest: MaestroScenarioWorkspaceManifest | undefined,
): ScriptedScenarioAssertionResult {
	const toolCalls = toolCallStatements(scenario);
	switch (assertion.kind) {
		case "tool_called": {
			const tool = requireAssertionString(assertion, "tool");
			const toolCallId = requireAssertionString(assertion, "toolCallId");
			if (!tool && !toolCallId) {
				return fail(assertion, "tool_called requires tool or toolCallId.");
			}
			const matches = toolCalls.filter(
				(call) =>
					(tool === undefined || call.tool === tool) &&
					(toolCallId === undefined || call.id === toolCallId),
			);
			return matches.length > 0
				? pass(
						assertion,
						`Matched ${matches.length} scripted tool call(s).`,
						matches.map((call) => ({
							kind: "tool_call",
							id:
								call.id ??
								`${scenario.id}:${call.frameIndex}:${call.statementIndex}`,
							source: "scenario",
							label: `${call.tool}:${call.frameIndex}.${call.statementIndex}`,
						})),
					)
				: fail(assertion, "No scripted tool call matched.");
		}
		case "tool_not_called": {
			const tool = requireAssertionString(assertion, "tool");
			if (!tool) {
				return fail(assertion, "tool_not_called requires tool.");
			}
			const matches = toolCalls.filter((call) => call.tool === tool);
			return matches.length === 0
				? pass(assertion, `Tool ${tool} was not called.`)
				: fail(
						assertion,
						`Tool ${tool} was called ${matches.length} time(s).`,
						matches.map((call) => ({
							kind: "tool_call",
							id:
								call.id ??
								`${scenario.id}:${call.frameIndex}:${call.statementIndex}`,
							source: "scenario",
							label: `${call.tool}:${call.frameIndex}.${call.statementIndex}`,
						})),
					);
		}
		case "file_exists": {
			const path = requireAssertionString(assertion, "path");
			if (!path) {
				return fail(assertion, "file_exists requires path.");
			}
			const fullPath = resolve(baseDir, path);
			const exists = existsSync(fullPath) && statSync(fullPath).isFile();
			return exists
				? pass(
						assertion,
						`File exists: ${path}.`,
						evidence("file", path, "workspace"),
					)
				: fail(assertion, `File does not exist: ${path}.`);
		}
		case "file_contents": {
			const path = requireAssertionString(assertion, "path");
			if (!path) {
				return fail(assertion, "file_contents requires path.");
			}
			const contains = requireAssertionString(assertion, "contains");
			const equals = requireAssertionString(assertion, "equals", {
				allowEmpty: true,
			});
			if (!contains && equals === undefined) {
				return fail(assertion, "file_contents requires contains or equals.");
			}
			const fullPath = resolve(baseDir, path);
			if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
				return fail(assertion, `File does not exist: ${path}.`);
			}
			const content = readFileSync(fullPath, "utf8");
			const matched =
				(contains !== undefined && content.includes(contains)) ||
				(equals !== undefined && content === equals);
			return matched
				? pass(
						assertion,
						`File contents matched: ${path}.`,
						evidence("file", path, "workspace"),
					)
				: fail(assertion, `File contents did not match: ${path}.`);
		}
		case "workspace_manifest":
			return evaluateWorkspaceManifestAssertion(
				assertion,
				scenario,
				baseDir,
				workspaceManifest,
			);
		case "audit_event_emitted": {
			const eventType = requireAssertionString(assertion, "eventType");
			if (!eventType) {
				return fail(assertion, "audit_event_emitted requires eventType.");
			}
			const events = scenario.metadata.auditEvents ?? [];
			return events.includes(eventType)
				? pass(
						assertion,
						`Audit event present: ${eventType}.`,
						evidence("audit_event", eventType, "audit"),
					)
				: fail(assertion, `Audit event missing: ${eventType}.`);
		}
	}
	const _exhaustive: never = assertion.kind;
	return fail(assertion, `Unsupported scripted assertion kind: ${_exhaustive}`);
}

function hasRequiredScriptedArtifact(
	artifact: MaestroScenarioRequiredArtifact,
	workspaceManifest: MaestroScenarioWorkspaceManifest | undefined,
): boolean {
	switch (artifact) {
		case "replay":
			return true;
		case "workspace_manifest":
			return workspaceManifest !== undefined;
		case "trajectory":
		case "score":
		case "inspection":
			return false;
	}
}

function workspacePolicyViolations(
	gate: MaestroScenarioReleaseGate,
	workspaceManifest: MaestroScenarioWorkspaceManifest | undefined,
): string[] {
	if (!gate.requiredArtifacts.includes("workspace_manifest")) {
		return [];
	}
	if (!workspaceManifest) {
		return [];
	}
	return [
		workspaceManifest.redaction.secretsRemoved !== true
			? "workspace manifest did not confirm secret redaction"
			: undefined,
		workspaceManifest.redaction.rawPromptsIncluded !== false
			? "workspace manifest did not confirm raw prompts were excluded"
			: undefined,
	].filter((value): value is string => value !== undefined);
}

function buildScriptedReleaseGateSummary(
	scenario: MaestroScriptedScenario,
	result: {
		assertions: ScriptedScenarioAssertionResult[];
		toolCalls: number;
		frames: number;
	},
	workspaceManifest: MaestroScenarioWorkspaceManifest | undefined,
): AgentTrajectoryScenarioReleaseGateSummary | undefined {
	const gate = scenario.releaseGate;
	if (!gate) return undefined;
	const missingArtifacts = gate.requiredArtifacts.filter(
		(artifact) => !hasRequiredScriptedArtifact(artifact, workspaceManifest),
	);
	const replayDeltas = 0;
	const scoreFailures = 0;
	const scoreWarnings = 0;
	const budgetViolations = [
		gate.maxEvents !== undefined && result.frames > gate.maxEvents
			? `events ${result.frames}/${gate.maxEvents}`
			: undefined,
		gate.maxToolCalls !== undefined && result.toolCalls > gate.maxToolCalls
			? `toolCalls ${result.toolCalls}/${gate.maxToolCalls}`
			: undefined,
		gate.maxReplayDeltas !== undefined && replayDeltas > gate.maxReplayDeltas
			? `replayDeltas ${replayDeltas}/${gate.maxReplayDeltas}`
			: undefined,
		gate.maxScoreFailures !== undefined && scoreFailures > gate.maxScoreFailures
			? `scoreFailures ${scoreFailures}/${gate.maxScoreFailures}`
			: undefined,
		gate.maxScoreWarnings !== undefined && scoreWarnings > gate.maxScoreWarnings
			? `scoreWarnings ${scoreWarnings}/${gate.maxScoreWarnings}`
			: undefined,
	].filter((value): value is string => value !== undefined);
	const policyViolations = [
		...workspacePolicyViolations(gate, workspaceManifest),
		...(gate.requiredArtifacts.includes("workspace_manifest")
			? result.assertions
					.filter(
						(assertion) =>
							assertion.kind === "workspace_manifest" &&
							assertion.status === "fail",
					)
					.map(
						(assertion) =>
							`workspace manifest assertion ${assertion.id} failed`,
					)
			: []),
	];
	return {
		...gate,
		satisfied:
			missingArtifacts.length === 0 &&
			budgetViolations.length === 0 &&
			policyViolations.length === 0,
		missingArtifacts,
		budgetViolations,
		policyViolations,
	};
}

export function evaluateScriptedScenario(
	scenario: MaestroScriptedScenario,
	options: { baseDir?: string } = {},
): ScriptedScenarioRunResult {
	const baseDir = options.baseDir ?? process.cwd();
	const workspaceManifest = scenario.workspaceManifestPath
		? loadScenarioWorkspaceManifest(
				resolve(baseDir, scenario.workspaceManifestPath),
			)
		: undefined;
	const assertions = (scenario.assertions ?? []).map((assertion) =>
		evaluateAssertion(assertion, scenario, baseDir, workspaceManifest),
	);
	const failed = assertions.filter((assertion) => assertion.status === "fail");
	const warnings = assertions.filter(
		(assertion) => assertion.status === "warn",
	);
	const observedOutcome: MaestroScenarioOutcome =
		failed.length > 0 ? "fail" : "pass";
	const toolCalls = toolCallStatements(scenario).length;
	const releaseGate = buildScriptedReleaseGateSummary(
		scenario,
		{ assertions, toolCalls, frames: scenario.frames.length },
		workspaceManifest,
	);
	const workspace = buildWorkspaceSummary(workspaceManifest);
	return {
		schemaVersion: SCRIPTED_SCENARIO_RESULT_SCHEMA,
		scenarioSchemaVersion: scenario.schemaVersion,
		scenario: {
			id: scenario.id,
			description: scenario.description,
			expectedOutcome: scenario.expectedOutcome ?? "pass",
			observedOutcome,
		},
		run: {
			scenarioId: scenario.id,
			replay: true,
			frames: scenario.frames.length,
			toolCalls,
			auditEvents: scenario.metadata.auditEvents ?? [],
		},
		counts: {
			assertions: assertions.length,
			passed: assertions.filter((assertion) => assertion.status === "pass")
				.length,
			failed: failed.length,
			warnings: warnings.length,
			workspaceFiles: workspaceManifest?.files.length ?? 0,
			toolAdapters: workspaceManifest?.toolAdapters.length ?? 0,
		},
		...(releaseGate ? { releaseGate } : {}),
		...(workspace ? { workspace } : {}),
		assertions,
	};
}

export function scriptedScenarioResultToJunit(
	result: ScriptedScenarioRunResult,
): string {
	const outcomeMatches =
		result.scenario.observedOutcome === result.scenario.expectedOutcome;
	const failures = result.assertions.filter(
		(assertion) => assertion.status === "fail",
	);
	const testcases = result.assertions
		.map((assertion) => {
			const failure =
				!outcomeMatches && assertion.status === "fail"
					? `\n\t\t<failure message="${escapeXml(assertion.message)}">${escapeXml(
							JSON.stringify(assertion.evidence),
						)}</failure>\n\t`
					: "";
			const expectedFailureOutput =
				outcomeMatches && assertion.status === "fail"
					? `\n\t\t<system-out>${escapeXml(
							[
								`Expected failing assertion observed: ${assertion.message}`,
								JSON.stringify(assertion.evidence),
							].join("\n"),
						)}</system-out>\n\t`
					: "";
			return `\t<testcase classname="${escapeXml(result.scenario.id)}" name="${escapeXml(assertion.id)}">${failure}${expectedFailureOutput}</testcase>`;
		})
		.join("\n");
	const outcomeFailure =
		!outcomeMatches && failures.length === 0
			? `\t<testcase classname="${escapeXml(result.scenario.id)}" name="scenario-outcome">\n\t\t<failure message="${escapeXml(
					`Observed outcome ${result.scenario.observedOutcome}; expected ${result.scenario.expectedOutcome}.`,
				)}"></failure>\n\t</testcase>\n`
			: "";
	const failureCount = outcomeMatches ? 0 : Math.max(1, failures.length);
	const testCount = result.counts.assertions + (outcomeFailure ? 1 : 0);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(
		result.scenario.id,
	)}" tests="${testCount}" failures="${failureCount}" warnings="${result.counts.warnings}">\n${outcomeFailure}${testcases}\n</testsuite>\n`;
}
