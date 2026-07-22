/**
 * A2A argv helpers used by the Node CLI arg scanner (stream-json tail flags).
 * The `maestro a2a` command itself is native (`packages/tui-rs/src/a2a_cli/`).
 */

const A2A_VALUE_FLAGS_BY_SUBCOMMAND: Record<string, readonly string[]> = {
	accept: [
		"--name",
		"--organization-id",
		"--registry",
		"--token-env",
		"--token-file",
		"--workspace-id",
	],
	card: ["--registry", "--timeout-ms"],
	cockpit: ["--registry", "--tasks", "--timeout-ms", "--peer", "--limit"],
	discover: [
		"--capability",
		"--limit",
		"--offset",
		"--registry",
		"--skill",
		"--status",
		"--surface",
		"--workspace-id",
	],
	delegate: [
		"--capability",
		"--cwd",
		"--from-agent-id",
		"--interval-ms",
		"--limit",
		"--max-wait-ms",
		"--objective-id",
		"--offset",
		"--registry",
		"--reason",
		"--role",
		"--skill",
		"--status",
		"--surface",
		"--tasks",
		"--timeout-ms",
		"--to-agent-id",
		"--workspace-id",
		"--workflow-run-id",
		"--workflow-step-id",
	],
	coordinate: [
		"--interval-ms",
		"--max-wait-ms",
		"--registry",
		"--reply",
		"--tasks",
		"--timeout-ms",
	],
	control: [
		"--child-run-id",
		"--delegation-id",
		"--idempotency-key",
		"--message",
		"--mode",
		"--subagent-lane-id",
		"--target-run-id",
		"--work-item-id",
		"--workspace-id",
	],
	fleet: ["--registry", "--tasks", "--timeout-ms"],
	graph: [
		"--delegation-id",
		"--limit",
		"--max-depth",
		"--root",
		"--root-delegation-id",
		"--workspace-id",
	],
	offer: [
		"--agent-card-url",
		"--base-url",
		"--name",
		"--peer-id",
		"--ttl-minutes",
		"--url",
	],
	peers: ["--registry"],
	register: [
		"--agent-card-etag",
		"--agent-card-hash",
		"--agent-card-url",
		"--agent-id",
		"--capabilities",
		"--description",
		"--internal-url",
		"--name",
		"--owner-id",
		"--protocol-version",
		"--public-url",
		"--security-schemes",
		"--status",
		"--surface",
		"--surface-types",
		"--type",
		"--url",
		"--workspace-id",
	],
	reply: [
		"--interval-ms",
		"--max-wait-ms",
		"--registry",
		"--tasks",
		"--timeout-ms",
	],
	send: [
		"--interval-ms",
		"--max-wait-ms",
		"--registry",
		"--tasks",
		"--timeout-ms",
	],
	tasks: ["--registry", "--tasks", "--timeout-ms"],
	telemetry: ["--events", "--swarm-id"],
	wait: [
		"--interval-ms",
		"--max-wait-ms",
		"--registry",
		"--tasks",
		"--timeout-ms",
	],
};
const A2A_BOOLEAN_FLAGS_BY_SUBCOMMAND: Record<string, readonly string[]> = {
	accept: ["--default"],
	cockpit: ["--json"],
	coordinate: ["--json", "--refresh", "--wait", "--work-graph"],
	delegate: [
		"--discover",
		"--platform",
		"--prefer-internal",
		"--wait",
		"--work-graph",
	],
	discover: ["--default", "--import", "--json", "--prefer-internal"],
	fleet: ["--json"],
	graph: ["--json"],
	register: ["--heartbeat-only", "--json", "--no-heartbeat", "--update-only"],
	reply: ["--wait", "--work-graph"],
	send: ["--wait", "--work-graph"],
	tasks: ["--json", "--refresh", "--work-graph"],
	telemetry: ["--json"],
	wait: ["--work-graph"],
};
const A2A_COLLECT_VALUE_FLAGS_BY_SUBCOMMAND: Record<string, readonly string[]> =
	{
		coordinate: ["--reply"],
		control: ["--message"],
	};
const A2A_FREEFORM_POSITIONAL_PREFIX_LENGTH: Record<string, number> = {
	control: 3,
	delegate: 2,
	reply: 3,
	send: 2,
};
const A2A_LEADING_VALUE_FLAGS = new Set(
	Object.values(A2A_VALUE_FLAGS_BY_SUBCOMMAND).flat(),
);
const A2A_LEADING_BOOLEAN_FLAGS = new Set(
	Object.values(A2A_BOOLEAN_FLAGS_BY_SUBCOMMAND).flat(),
);

/**
 * Scan `maestro a2a …` argv for a root-level stream/json tail flag that the
 * Node `parseArgs` path must honor without running the native a2a command.
 * Full A2A argv parsing lives in packages/tui-rs (TS parseA2AArgs was removed
 * after the a2a CLI nativized).
 */
export function findA2ACommandTailFlag(
	args: string[],
	matchesFlag: (arg: string) => string | undefined,
): string | undefined {
	const subcommandIndex = findA2ASubcommandIndex(args);
	const subcommand =
		subcommandIndex >= 0
			? canonicalA2ASubcommand(args[subcommandIndex])
			: "help";
	const valueFlags = new Set(A2A_VALUE_FLAGS_BY_SUBCOMMAND[subcommand] ?? []);
	const booleanFlags = new Set(
		A2A_BOOLEAN_FLAGS_BY_SUBCOMMAND[subcommand] ?? [],
	);
	if (subcommand === "delegate" && args.includes("--platform")) {
		booleanFlags.add("--json");
	}
	const collectValueFlags = new Set(
		A2A_COLLECT_VALUE_FLAGS_BY_SUBCOMMAND[subcommand] ?? [],
	);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) continue;
		if (arg === "--") {
			break;
		}
		if (!arg.startsWith("--")) {
			continue;
		}
		const [flag, inlineValue] = arg.split("=", 2);
		if (!flag) {
			continue;
		}
		if (!valueFlags.has(flag) && !booleanFlags.has(flag)) {
			const matched = matchesFlag(arg);
			if (matched && !isA2AFreeformPositionalText(args, index, subcommand)) {
				return matched;
			}
			continue;
		}
		const matched = matchesFlag(arg);
		if (matched) {
			return matched;
		}
		if (inlineValue !== undefined || booleanFlags.has(flag)) {
			continue;
		}
		if (collectValueFlags.has(flag)) {
			while (args[index + 1] && args[index + 1] !== "--") {
				const next = args[index + 1]!;
				const [nextFlag] = next.split("=", 2);
				if (
					next.startsWith("--") &&
					nextFlag &&
					(valueFlags.has(nextFlag) || booleanFlags.has(nextFlag))
				) {
					break;
				}
				index++;
			}
			continue;
		}
		if (args[index + 1] && args[index + 1] !== "--") {
			index++;
		}
	}
	return undefined;
}

function isA2AFreeformPositionalText(
	args: string[],
	index: number,
	subcommand: string,
): boolean {
	const requiredPositionals = A2A_FREEFORM_POSITIONAL_PREFIX_LENGTH[subcommand];
	if (requiredPositionals === undefined) {
		return false;
	}
	if (subcommand === "delegate" && args.includes("--discover")) {
		return countRawPositionalsBefore(args, index) >= 1;
	}
	return countRawPositionalsBefore(args, index) >= requiredPositionals;
}

function countRawPositionalsBefore(args: string[], endIndex: number): number {
	let count = 0;
	for (let index = 0; index < endIndex; index++) {
		const arg = args[index];
		if (!arg || arg === "--") {
			break;
		}
		if (!arg.startsWith("--")) {
			count++;
		}
	}
	return count;
}

function findA2ASubcommandIndex(args: readonly string[]): number {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg || arg === "--") {
			break;
		}
		if (!arg.startsWith("--")) {
			return index;
		}
		const [flag = "", inlineValue] = arg.split("=", 2);
		if (A2A_LEADING_VALUE_FLAGS.has(flag) && inlineValue === undefined) {
			index++;
			continue;
		}
		if (
			A2A_LEADING_VALUE_FLAGS.has(flag) ||
			A2A_LEADING_BOOLEAN_FLAGS.has(flag)
		) {
			continue;
		}
		break;
	}
	return -1;
}

function canonicalA2ASubcommand(input: string | undefined): string {
	switch (input?.toLowerCase()) {
		case "pair":
		case "create":
			return "offer";
		case "list":
			return "peers";
		case "dashboard":
			return "cockpit";
		case "delegation":
			return "delegate";
		case "continue":
			return "reply";
		case "publish":
			return "register";
		default:
			return input?.toLowerCase() ?? "help";
	}
}
