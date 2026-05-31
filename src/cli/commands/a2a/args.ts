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
const A2A_LEADING_VALUE_FLAGS = new Set(
	Object.values(A2A_VALUE_FLAGS_BY_SUBCOMMAND).flat(),
);
const A2A_LEADING_BOOLEAN_FLAGS = new Set(
	Object.values(A2A_BOOLEAN_FLAGS_BY_SUBCOMMAND).flat(),
);

export interface ParsedA2AArgs {
	positionals: string[];
	flags: Map<string, string | boolean>;
}

export function parseA2AArgs(args: string[]): ParsedA2AArgs {
	const flags = new Map<string, string | boolean>();
	const positionals: string[] = [];
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
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const [flag, inlineValue] = arg.split("=", 2);
			if (!flag) {
				continue;
			}
			if (
				index < subcommandIndex &&
				!valueFlags.has(flag) &&
				!booleanFlags.has(flag) &&
				(A2A_LEADING_VALUE_FLAGS.has(flag) ||
					A2A_LEADING_BOOLEAN_FLAGS.has(flag))
			) {
				if (A2A_LEADING_VALUE_FLAGS.has(flag) && inlineValue === undefined) {
					index++;
				}
				continue;
			}
			if (!valueFlags.has(flag) && !booleanFlags.has(flag)) {
				positionals.push(arg);
				continue;
			}
			if (inlineValue !== undefined) {
				if (collectValueFlags.has(flag) && !inlineValue.trim()) {
					throw new Error(collectValueFlagMissingTextMessage(flag, subcommand));
				}
				flags.set(flag, inlineValue);
				continue;
			}
			if (booleanFlags.has(flag)) {
				flags.set(flag, true);
				continue;
			}
			if (collectValueFlags.has(flag)) {
				const values: string[] = [];
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
					values.push(next);
					index++;
				}
				const value = values.join(" ").trim();
				if (!value) {
					throw new Error(collectValueFlagMissingTextMessage(flag, subcommand));
				}
				flags.set(flag, value);
				continue;
			}
			const next = args[index + 1];
			if (next && next !== "--") {
				flags.set(flag, next);
				index++;
				continue;
			}
			flags.set(flag, true);
			continue;
		}
		positionals.push(arg);
	}
	return { flags, positionals };
}

function collectValueFlagMissingTextMessage(
	flag: string,
	subcommand: string,
): string {
	const usage =
		subcommand === "coordinate" && flag === "--reply"
			? "\nUsage: maestro a2a coordinate [peer] --reply <text> [--wait]"
			: "";
	return `${flag} requires text${usage}`;
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

export function canonicalA2ASubcommand(input: string | undefined): string {
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

export function stringFlag(
	parsed: ParsedA2AArgs,
	name: string,
): string | undefined {
	const value = parsed.flags.get(name);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringListFlag(
	parsed: ParsedA2AArgs,
	name: string,
	fallback: string[],
): string[] {
	const value = stringFlag(parsed, name);
	if (!value) {
		return fallback;
	}
	const parsedValues = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return parsedValues.length > 0 ? parsedValues : fallback;
}

export function numberFlag(
	parsed: ParsedA2AArgs,
	name: string,
): number | undefined {
	const value = stringFlag(parsed, name);
	if (!value) {
		return undefined;
	}
	const parsedValue = Number(value);
	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return parsedValue;
}

export function nonNegativeNumberFlag(
	parsed: ParsedA2AArgs,
	name: string,
): number | undefined {
	const value = stringFlag(parsed, name);
	if (!value) {
		return undefined;
	}
	const parsedValue = Number(value);
	if (!Number.isFinite(parsedValue) || parsedValue < 0) {
		throw new Error(`${name} must be a non-negative number`);
	}
	return parsedValue;
}

export function minutesFlag(
	parsed: ParsedA2AArgs,
	name: string,
): number | undefined {
	const value = numberFlag(parsed, name);
	return value === undefined ? undefined : value * 60 * 1000;
}

export function booleanFlag(parsed: ParsedA2AArgs, name: string): boolean {
	return parsed.flags.get(name) === true;
}
