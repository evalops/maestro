export const CODEX_SUBAGENT_TOOL_PREFIX = "codex.subagent.";
export const CODEX_THREAD_CHILD_RUN_PREFIX = "codex-thread:";
export const CODEX_SUBAGENT_WORK_GRAPH_SCHEMA =
	"evalops.maestro.codex.subagent-workgraph.v1";

export type CodexSubagentCanonicalTool =
	| "spawnAgent"
	| "sendInput"
	| "resumeAgent"
	| "wait"
	| "closeAgent";

export interface CodexSubagentLifecycleOperation {
	tool: CodexSubagentCanonicalTool;
	operation: string;
	aliases: readonly string[];
	activeStatus: string;
	terminalSuccessStatus: string;
	nextAction: string;
}

export const CODEX_SUBAGENT_LIFECYCLE_OPERATIONS = [
	{
		tool: "spawnAgent",
		operation: "spawn_agent",
		aliases: ["spawnAgent", "spawn_agent"],
		activeStatus: "waiting_for_restore",
		terminalSuccessStatus: "spawned",
		nextAction: "wait for child agent initialization or completion",
	},
	{
		tool: "sendInput",
		operation: "send_input",
		aliases: ["sendInput", "send_input"],
		activeStatus: "waiting_for_input_ack",
		terminalSuccessStatus: "acknowledged",
		nextAction: "wait for child agent response",
	},
	{
		tool: "resumeAgent",
		operation: "resume_agent",
		aliases: [
			"resumeAgent",
			"resumeSubagent",
			"resume_agent",
			"resume_subagent",
		],
		activeStatus: "restoring",
		terminalSuccessStatus: "resumed",
		nextAction: "wait for resumed child agent response",
	},
	{
		tool: "wait",
		operation: "wait_agent",
		aliases: ["wait", "waitAgent", "wait_agent"],
		activeStatus: "wait_pending",
		terminalSuccessStatus: "completed",
		nextAction: "wait for selected child agents",
	},
	{
		tool: "closeAgent",
		operation: "close_agent",
		aliases: ["closeAgent", "close_agent"],
		activeStatus: "waiting_for_close",
		terminalSuccessStatus: "closed",
		nextAction: "confirm child agent shutdown",
	},
] as const satisfies readonly CodexSubagentLifecycleOperation[];

const operationByAlias = new Map<string, CodexSubagentLifecycleOperation>();
const operationByCanonicalTool = new Map<
	CodexSubagentCanonicalTool,
	CodexSubagentLifecycleOperation
>();

for (const operation of CODEX_SUBAGENT_LIFECYCLE_OPERATIONS) {
	operationByCanonicalTool.set(operation.tool, operation);
	operationByAlias.set(operation.tool, operation);
	operationByAlias.set(operation.operation, operation);
	operationByAlias.set(
		`${CODEX_SUBAGENT_TOOL_PREFIX}${operation.tool}`,
		operation,
	);
	operationByAlias.set(
		`${CODEX_SUBAGENT_TOOL_PREFIX}${operation.operation}`,
		operation,
	);
	for (const alias of operation.aliases) {
		operationByAlias.set(alias, operation);
		operationByAlias.set(`${CODEX_SUBAGENT_TOOL_PREFIX}${alias}`, operation);
	}
}

export function codexSubagentLifecycleOperation(
	value: string | undefined,
): CodexSubagentLifecycleOperation | undefined {
	return value ? operationByAlias.get(value) : undefined;
}

export function canonicalCodexSubagentTool(
	value: string | undefined,
): CodexSubagentCanonicalTool | undefined {
	return codexSubagentLifecycleOperation(value)?.tool;
}

export function codexSubagentOperationName(
	value: string | undefined,
): string | undefined {
	return codexSubagentLifecycleOperation(value)?.operation;
}

export function codexSubagentActiveStatus(
	value: string | undefined,
): string | undefined {
	return codexSubagentLifecycleOperation(value)?.activeStatus;
}

export function codexSubagentTerminalSuccessStatus(
	value: string | undefined,
): string | undefined {
	return codexSubagentLifecycleOperation(value)?.terminalSuccessStatus;
}

export function codexSubagentNextAction(
	value: string | undefined,
): string | undefined {
	return codexSubagentLifecycleOperation(value)?.nextAction;
}

export function codexSubagentLifecycleOperationForTool(
	tool: CodexSubagentCanonicalTool,
): CodexSubagentLifecycleOperation {
	const operation = operationByCanonicalTool.get(tool);
	if (!operation) {
		throw new Error(`Unknown Codex subagent tool ${tool}`);
	}
	return operation;
}
