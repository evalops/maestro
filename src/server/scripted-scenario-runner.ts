import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
	MaestroScenarioOutcome,
	MaestroScenarioSeverity,
	MaestroScriptedScenario,
	MaestroScriptedScenarioAssertion,
	MaestroScriptedScenarioAssertionKind,
	MaestroScriptedStatement,
} from "@evalops/contracts";
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
	};
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

export function evaluateScriptedScenario(
	scenario: MaestroScriptedScenario,
	options: { baseDir?: string } = {},
): ScriptedScenarioRunResult {
	const assertions = (scenario.assertions ?? []).map((assertion) =>
		evaluateAssertion(assertion, scenario, options.baseDir ?? process.cwd()),
	);
	const failed = assertions.filter((assertion) => assertion.status === "fail");
	const warnings = assertions.filter(
		(assertion) => assertion.status === "warn",
	);
	const observedOutcome: MaestroScenarioOutcome =
		failed.length > 0 ? "fail" : "pass";
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
			toolCalls: toolCallStatements(scenario).length,
			auditEvents: scenario.metadata.auditEvents ?? [],
		},
		counts: {
			assertions: assertions.length,
			passed: assertions.filter((assertion) => assertion.status === "pass")
				.length,
			failed: failed.length,
			warnings: warnings.length,
		},
		assertions,
	};
}

export function scriptedScenarioResultToJunit(
	result: ScriptedScenarioRunResult,
): string {
	const failures = result.assertions.filter(
		(assertion) => assertion.status === "fail",
	);
	const testcases = result.assertions
		.map((assertion) => {
			const failure =
				assertion.status === "fail"
					? `\n\t\t<failure message="${escapeXml(assertion.message)}">${escapeXml(
							JSON.stringify(assertion.evidence),
						)}</failure>\n\t`
					: "";
			return `\t<testcase classname="${escapeXml(result.scenario.id)}" name="${escapeXml(assertion.id)}">${failure}</testcase>`;
		})
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(
		result.scenario.id,
	)}" tests="${result.counts.assertions}" failures="${failures.length}" warnings="${result.counts.warnings}">\n${testcases}\n</testsuite>\n`;
}
