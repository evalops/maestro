import {
	type OperatingPlaneInspection,
	type OperatingPlaneRunQuery,
	inspectOperatingPlaneRuns,
} from "../../platform/operating-plane-client.js";
import {
	formatOperatingPlaneStatusReport,
	summarizeOperatingPlaneInspection,
} from "../../platform/operating-plane-summary.js";

export interface ParsedOperatingPlaneArgs {
	subcommand: string;
	query: OperatingPlaneRunQuery;
	json: boolean;
	help: boolean;
}

export interface HandleOperatingPlaneCommandOptions {
	inspect?: (
		query: OperatingPlaneRunQuery,
	) => Promise<OperatingPlaneInspection>;
	write?: (line: string) => void;
}

const VALUE_FLAGS = new Set([
	"--agent-id",
	"--audience",
	"--auth-subject",
	"--autonomy-session-id",
	"--channel-thread-id",
	"--evidence-id",
	"--gateway-authenticated-subject",
	"--limit",
	"--run-id",
	"--session-id",
	"--thread-id",
	"--trace-id",
	"--work-envelope-id",
	"--workspace-id",
]);

const BOOLEAN_FLAGS = new Set(["--help", "--include-gates", "--json"]);

export async function handleOperatingPlaneCommand(
	args: string[],
	options: HandleOperatingPlaneCommandOptions = {},
): Promise<void> {
	const parsed = parseOperatingPlaneArgs(args);
	const write = options.write ?? ((line: string) => console.log(line));
	if (parsed.help || parsed.subcommand === "help") {
		write(operatingPlaneHelpText());
		return;
	}
	if (parsed.subcommand !== "status" && parsed.subcommand !== "inspect") {
		throw new Error(`Unknown operating-plane command: ${parsed.subcommand}`);
	}

	const inspect = options.inspect ?? inspectOperatingPlaneRuns;
	const inspection = await inspect(parsed.query);
	const report = summarizeOperatingPlaneInspection(inspection);
	write(
		parsed.json
			? JSON.stringify(report, null, 2)
			: formatOperatingPlaneStatusReport(report),
	);
}

export function parseOperatingPlaneArgs(
	args: string[],
): ParsedOperatingPlaneArgs {
	const positionals: string[] = [];
	const flags = new Map<string, string | boolean>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) {
			continue;
		}
		if (arg === "--") {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}

		const [flag, inlineValue] = arg.split("=", 2);
		if (!flag) {
			continue;
		}
		if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) {
			throw new Error(`Unknown operating-plane option: ${flag}`);
		}
		if (inlineValue !== undefined) {
			flags.set(flag, inlineValue);
			continue;
		}
		if (BOOLEAN_FLAGS.has(flag)) {
			flags.set(flag, true);
			continue;
		}
		const next = args[index + 1];
		if (!next || next === "--" || next.startsWith("--")) {
			throw new Error(`${flag} requires a value`);
		}
		flags.set(flag, next);
		index++;
	}

	return {
		subcommand: positionals.shift()?.toLowerCase() ?? "status",
		query: queryFromFlags(flags),
		json: flagBoolean(flags, "--json") === true,
		help: flagBoolean(flags, "--help") === true,
	};
}

function queryFromFlags(
	flags: Map<string, string | boolean>,
): OperatingPlaneRunQuery {
	return stripUndefined({
		workspaceId: flagString(flags, "--workspace-id"),
		runId: flagString(flags, "--run-id"),
		workEnvelopeId: flagString(flags, "--work-envelope-id"),
		autonomySessionId: flagString(flags, "--autonomy-session-id"),
		agentId: flagString(flags, "--agent-id"),
		threadId: flagString(flags, "--thread-id"),
		channelThreadId: flagString(flags, "--channel-thread-id"),
		traceId: flagString(flags, "--trace-id"),
		sessionId: flagString(flags, "--session-id"),
		evidenceId: flagString(flags, "--evidence-id"),
		gatewayAuthenticatedSubject:
			flagString(flags, "--gateway-authenticated-subject") ??
			flagString(flags, "--auth-subject"),
		audience: flagString(flags, "--audience") as
			| OperatingPlaneRunQuery["audience"]
			| undefined,
		includeGates: flagBoolean(flags, "--include-gates"),
		limit: flagNonNegativeInt(flags, "--limit"),
	});
}

function flagString(
	flags: Map<string, string | boolean>,
	name: string,
): string | undefined {
	const value = flags.get(name);
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function flagBoolean(
	flags: Map<string, string | boolean>,
	name: string,
): boolean | undefined {
	const value = flags.get(name);
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "boolean") {
		return value;
	}
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
			return true;
		case "0":
		case "false":
		case "no":
			return false;
		default:
			throw new Error(`${name} must be true or false`);
	}
}

function flagNonNegativeInt(
	flags: Map<string, string | boolean>,
	name: string,
): number | undefined {
	const value = flagString(flags, name);
	if (!value) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return parsed;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}

function operatingPlaneHelpText(): string {
	return `Usage: maestro operating-plane status [filters]

Filters:
  --thread-id <id>                  Slack/channel thread id
  --evidence-id <id>                Evidence ref id
  --auth-subject <subject>          Gateway-authenticated subject
  --trace-id <id>                   Trace id
  --session-id <id>                 Maestro/session id
  --run-id <id>                     Agent runtime run id
  --workspace-id <id>               Workspace id
  --audience <audience>             agent, channel, audit, system, ...
  --include-gates=<true|false>      Include release/replay gates
  --limit <n>                       Maximum runs
  --json                            Emit safe summary JSON`;
}
