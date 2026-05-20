import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCodexSubagentContinuityEdges,
	codexSubagentOperation,
} from "../../src/cli/headless-protocol.js";
import {
	CODEX_SUBAGENT_LIFECYCLE_OPERATIONS,
	CODEX_SUBAGENT_TOOL_PREFIX,
	CODEX_SUBAGENT_WORK_GRAPH_SCHEMA,
	CODEX_THREAD_CHILD_RUN_PREFIX,
	canonicalCodexSubagentTool,
	codexSubagentActiveStatus,
	codexSubagentNextAction,
	codexSubagentOperationName,
	codexSubagentTerminalSuccessStatus,
} from "../../src/codex/subagent-workgraph.js";

interface FixtureLifecycleOperation {
	tool: string;
	operation: string;
	aliases: string[];
	activeStatus: string;
	terminalSuccessStatus: string;
	nextAction: string;
}

interface CodexSubagentWorkGraphFixture {
	schemaVersion: string;
	toolPrefix: string;
	threadChildRunPrefix: string;
	operations: FixtureLifecycleOperation[];
}

const fixture = JSON.parse(
	readFileSync(
		join(process.cwd(), "docs/protocols/codex-subagent-workgraph-v1.json"),
		"utf8",
	),
) as CodexSubagentWorkGraphFixture;

describe("Codex subagent work graph contract", () => {
	it("keeps the TypeScript lifecycle operation table aligned with the fixture", () => {
		expect(CODEX_SUBAGENT_WORK_GRAPH_SCHEMA).toBe(fixture.schemaVersion);
		expect(CODEX_SUBAGENT_TOOL_PREFIX).toBe(fixture.toolPrefix);
		expect(CODEX_THREAD_CHILD_RUN_PREFIX).toBe(fixture.threadChildRunPrefix);
		expect(
			CODEX_SUBAGENT_LIFECYCLE_OPERATIONS.map((operation) => ({
				tool: operation.tool,
				operation: operation.operation,
				aliases: [...operation.aliases],
				activeStatus: operation.activeStatus,
				terminalSuccessStatus: operation.terminalSuccessStatus,
				nextAction: operation.nextAction,
			})),
		).toEqual(
			fixture.operations.map((operation) => ({
				tool: operation.tool,
				operation: operation.operation,
				aliases: operation.aliases,
				activeStatus: operation.activeStatus,
				terminalSuccessStatus: operation.terminalSuccessStatus,
				nextAction: operation.nextAction,
			})),
		);
	});

	it("normalizes every canonical, snake-case, and fully qualified lifecycle alias", () => {
		for (const operation of fixture.operations) {
			for (const alias of [
				operation.tool,
				operation.operation,
				...operation.aliases,
			]) {
				expect(canonicalCodexSubagentTool(alias)).toBe(operation.tool);
				expect(
					canonicalCodexSubagentTool(`${fixture.toolPrefix}${alias}`),
				).toBe(operation.tool);
				expect(codexSubagentOperationName(alias)).toBe(operation.operation);
				expect(codexSubagentOperation(`${fixture.toolPrefix}${alias}`)).toBe(
					operation.operation,
				);
				expect(codexSubagentActiveStatus(alias)).toBe(operation.activeStatus);
				expect(codexSubagentTerminalSuccessStatus(alias)).toBe(
					operation.terminalSuccessStatus,
				);
				expect(codexSubagentNextAction(alias)).toBe(operation.nextAction);
			}
		}
	});

	it("builds remote-runner continuity edges for the complete subagent lifecycle", () => {
		for (const operation of fixture.operations) {
			const [alias] = operation.aliases;
			const edges = buildCodexSubagentContinuityEdges({
				call_id: `collab-${operation.operation}`,
				tool_execution_id: `tool-exec-${operation.operation}`,
				tool: `${fixture.toolPrefix}${alias}`,
				status: operation.activeStatus,
				args: {
					receiverThreadIds: [`thread-${operation.operation}`],
					childRunIds: [`agent-run-${operation.operation}`],
				},
			});

			expect(edges).toEqual([
				expect.objectContaining({
					operation: operation.operation,
					status: operation.activeStatus,
					child_run_id: `agent-run-${operation.operation}`,
					thread_id: `thread-${operation.operation}`,
					...(operation.operation === "spawn_agent"
						? { spawn_tool_execution_id: `tool-exec-${operation.operation}` }
						: { wait_tool_execution_id: `tool-exec-${operation.operation}` }),
				}),
			]);
		}
	});
});
