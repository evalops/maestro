import { headlessProtocolVersion } from "@evalops/contracts";
import chalk from "chalk";
import { getPackageVersion } from "../../package-metadata.js";
import {
	attachToRemoteRunnerSession,
	shouldUseInteractiveRemoteAttach,
} from "../../remote-runner/attach-client.js";
import {
	DEFAULT_REMOTE_RUNNER_WAIT_POLL_INTERVAL_MS,
	DEFAULT_REMOTE_RUNNER_WAIT_TIMEOUT_MS,
	RUNNER_ATTACH_ROLES,
	type RunnerAttachRole,
	type RunnerSession,
	type RunnerSessionState,
	createRunnerSession,
	extendRunnerSession,
	getRemoteRunnerStatus,
	getRunnerSession,
	listRunnerSessionEvents,
	listRunnerSessions,
	mintRunnerAttachToken,
	remoteRunnerGatewayBaseUrl,
	resolveRemoteRunnerConfig,
	revokeRunnerAttachToken,
	stopRunnerSession,
	verifyRunnerHeadlessAttach,
	waitForRunnerSessionReady,
} from "../../remote-runner/client.js";

type RemoteFlagValue = true | string;

interface RemoteCommandOptions {
	flags: Map<string, RemoteFlagValue[]>;
	positionals: string[];
}

const REMOTE_USAGE = `maestro remote <command> [options]

Commands:
  start --workspace <id> --repo <repo> --branch <branch> [--ttl 90m] [--profile standard] [--wait] [--wait-timeout 5m] [--poll-interval 5s] [--verify]
  list --workspace <id> [--state running] [--limit 20]
  status --workspace <id>
  get <session-id>
  events <session-id> [--after <sequence>] [--limit 50]
  extend <session-id> --ttl 2h [--idle-ttl 30m]
  stop <session-id> [--reason <text>]
  attach <session-id> [--role controller] [--ttl 30m] [--verify] [--print-env]
  attach-token <session-id> [--role viewer] [--ttl 30m] [--json]
  revoke-token <session-id> <token-id>
  target <session-id>

Shared options:
  --base-url <url>       Remote runner URL (defaults to https://runner.evalops.dev)
  --org <id>            EvalOps organization id
  --workspace <id>      EvalOps workspace id
  --token <token>       EvalOps access token
  --json                Print machine-readable JSON
  --help                Show this help`;

function parseRemoteOptions(args: readonly string[]): RemoteCommandOptions {
	const flags = new Map<string, RemoteFlagValue[]>();
	const positionals: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
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
		const equalsIndex = arg.indexOf("=");
		const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
		const inlineValue =
			equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;
		const next = args[index + 1];
		const value =
			inlineValue !== undefined
				? inlineValue
				: next && !next.startsWith("--")
					? next
					: true;
		if (inlineValue === undefined && value !== true) {
			index += 1;
		}
		const values = flags.get(key) ?? [];
		values.push(value);
		flags.set(key, values);
	}

	return { flags, positionals };
}

function hasFlag(options: RemoteCommandOptions, name: string): boolean {
	return options.flags.has(name);
}

function getFlag(
	options: RemoteCommandOptions,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const values = options.flags.get(name);
		const last = values?.at(-1);
		if (typeof last === "string" && last.trim().length > 0) {
			return last.trim();
		}
	}
	return undefined;
}

function getRepeatedFlag(
	options: RemoteCommandOptions,
	...names: string[]
): string[] {
	const values: string[] = [];
	for (const name of names) {
		for (const value of options.flags.get(name) ?? []) {
			if (typeof value === "string" && value.trim().length > 0) {
				values.push(value.trim());
			}
		}
	}
	return values;
}

function parseIntFlag(
	options: RemoteCommandOptions,
	name: string,
	fallback?: number,
): number | undefined {
	const raw = getFlag(options, name);
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`--${name} must be a non-negative integer`);
	}
	return parsed;
}

export function parseRemoteDurationMinutes(
	raw: string | undefined,
	fallback: number,
): number {
	if (!raw) {
		return fallback;
	}
	const value = raw.trim().toLowerCase();
	const match = value.match(
		/^(\d+(?:\.\d+)?)(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/u,
	);
	if (!match) {
		throw new Error(`Invalid duration "${raw}". Use minutes, 90m, or 2h.`);
	}
	const amount = Number(match[1]);
	const unit = match[2] ?? "m";
	const minutes = unit.startsWith("h") ? amount * 60 : amount;
	if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(minutes)) {
		throw new Error(
			`Invalid duration "${raw}". Duration must resolve to whole minutes.`,
		);
	}
	return minutes;
}

function parseOptionalDurationMinutes(
	raw: string | undefined,
): number | undefined {
	if (!raw) {
		return undefined;
	}
	return parseRemoteDurationMinutes(raw, 0);
}

function parseWaitDurationMs(
	raw: string | undefined,
	fallback: number,
): number {
	if (!raw) {
		return fallback;
	}
	const value = raw.trim().toLowerCase();
	const match = value.match(
		/^(\d+(?:\.\d+)?)(ms|msec|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/u,
	);
	if (!match) {
		throw new Error(
			`Invalid wait duration "${raw}". Use values like 5s, 30s, 5m, or 1h.`,
		);
	}
	const amount = Number(match[1]);
	const unit = match[2] ?? "s";
	let milliseconds = amount * 1000;
	if (unit === "ms" || unit === "msec" || unit.startsWith("millisecond")) {
		milliseconds = amount;
	} else if (unit.startsWith("m") && unit !== "ms" && unit !== "msec") {
		milliseconds = amount * 60 * 1000;
	} else if (unit.startsWith("h")) {
		milliseconds = amount * 60 * 60 * 1000;
	}
	if (!Number.isFinite(milliseconds) || milliseconds < 1) {
		throw new Error(
			`Invalid wait duration "${raw}". Duration must resolve to at least 1ms.`,
		);
	}
	return Math.round(milliseconds);
}

function formatElapsedMs(rawMs: number | undefined): string {
	if (!rawMs || rawMs < 1000) {
		return `${rawMs ?? 0}ms`;
	}
	if (rawMs < 60_000) {
		return `${(rawMs / 1000).toFixed(rawMs % 1000 === 0 ? 0 : 1)}s`;
	}
	const minutes = rawMs / 60_000;
	if (rawMs < 60 * 60_000) {
		return `${minutes.toFixed(rawMs % 60_000 === 0 ? 0 : 1)}m`;
	}
	const hours = rawMs / (60 * 60_000);
	return `${hours.toFixed(rawMs % (60 * 60_000) === 0 ? 0 : 1)}h`;
}

function parseMetadata(
	values: readonly string[],
): Record<string, unknown> | undefined {
	if (!values.length) {
		return undefined;
	}
	const metadata: Record<string, unknown> = {};
	for (const value of values) {
		const equalsIndex = value.indexOf("=");
		if (equalsIndex <= 0) {
			throw new Error(`--metadata values must be key=value pairs: ${value}`);
		}
		const key = value.slice(0, equalsIndex).trim();
		const raw = value.slice(equalsIndex + 1).trim();
		if (!key) {
			throw new Error(`--metadata values must include a key: ${value}`);
		}
		metadata[key] = raw;
	}
	return metadata;
}

function jsonFlag(options: RemoteCommandOptions): boolean {
	return hasFlag(options, "json");
}

function clientOptions(options: RemoteCommandOptions) {
	return {
		baseUrl: getFlag(options, "base-url", "url"),
		token: getFlag(options, "token"),
		organizationId: getFlag(options, "org", "organization"),
		workspaceId: getFlag(options, "workspace"),
	};
}

function stateLabel(state: RunnerSessionState | string | undefined): string {
	return (
		state
			?.replace(/^RUNNER_SESSION_STATE_/u, "")
			.toLowerCase()
			.replaceAll("_", "-") ?? "unknown"
	);
}

function roleValues(options: RemoteCommandOptions): RunnerAttachRole[] {
	const rawRoles = getRepeatedFlag(options, "role", "roles");
	const roles = rawRoles.length
		? rawRoles.flatMap((role) => role.split(","))
		: hasFlag(options, "viewer")
			? ["viewer"]
			: hasFlag(options, "admin")
				? ["admin"]
				: ["controller"];
	return roles.map((role) => {
		const normalized = role
			.trim()
			.toUpperCase()
			.replace(/^RUNNER_ATTACH_ROLE_/u, "");
		const value =
			RUNNER_ATTACH_ROLES[normalized as keyof typeof RUNNER_ATTACH_ROLES];
		if (!value || value === RUNNER_ATTACH_ROLES.UNSPECIFIED) {
			throw new Error(`Unknown remote attach role: ${role}`);
		}
		return value;
	});
}

function attachConnectionRole(
	options: RemoteCommandOptions,
): "viewer" | "controller" {
	return roleValues(options).every(
		(role) => role === RUNNER_ATTACH_ROLES.VIEWER,
	)
		? "viewer"
		: "controller";
}

function shouldWaitForStart(options: RemoteCommandOptions): boolean {
	return hasFlag(options, "wait") || hasFlag(options, "verify");
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function printSession(session: RunnerSession): void {
	console.log(chalk.bold(session.id));
	console.log(`  state:     ${stateLabel(session.state)}`);
	console.log(`  workspace: ${session.workspaceId ?? "-"}`);
	console.log(`  profile:   ${session.runnerProfile ?? "-"}`);
	console.log(`  repo:      ${session.repoUrl ?? "-"}`);
	console.log(`  branch:    ${session.branch ?? "-"}`);
	console.log(`  expires:   ${session.expiresAt ?? "-"}`);
	console.log(`  idle:      ${session.idleExpiresAt ?? "-"}`);
	if (session.stopReason) {
		console.log(`  stopped:   ${session.stopReason}`);
	}
}

function printSessionTable(sessions: readonly RunnerSession[]): void {
	if (!sessions.length) {
		console.log(chalk.dim("No remote runner sessions found."));
		return;
	}
	const rows = sessions.map((session) => ({
		id: session.id,
		state: stateLabel(session.state),
		profile: session.runnerProfile ?? "-",
		repo: session.repoUrl ?? "-",
		branch: session.branch ?? "-",
		expires: session.expiresAt ?? "-",
	}));
	const widths = {
		id: Math.max("session".length, ...rows.map((row) => row.id.length)),
		state: Math.max("state".length, ...rows.map((row) => row.state.length)),
		profile: Math.max(
			"profile".length,
			...rows.map((row) => row.profile.length),
		),
		repo: Math.max("repo".length, ...rows.map((row) => row.repo.length)),
		branch: Math.max("branch".length, ...rows.map((row) => row.branch.length)),
	};
	console.log(
		[
			"session".padEnd(widths.id),
			"state".padEnd(widths.state),
			"profile".padEnd(widths.profile),
			"repo".padEnd(widths.repo),
			"branch".padEnd(widths.branch),
			"expires",
		].join("  "),
	);
	for (const row of rows) {
		console.log(
			[
				row.id.padEnd(widths.id),
				row.state.padEnd(widths.state),
				row.profile.padEnd(widths.profile),
				row.repo.padEnd(widths.repo),
				row.branch.padEnd(widths.branch),
				row.expires,
			].join("  "),
		);
	}
}

function printAttachInstructions(input: {
	sessionId: string;
	gatewayBaseUrl: string;
	tokenId: string;
	tokenSecret: string;
	expiresAt?: string;
	json: boolean;
	showSecret: boolean;
	verified?: Record<string, unknown>;
}): void {
	if (input.json) {
		printJson({
			sessionId: input.sessionId,
			gatewayBaseUrl: input.gatewayBaseUrl,
			tokenId: input.tokenId,
			tokenSecret: input.tokenSecret,
			expiresAt: input.expiresAt,
			verified: input.verified,
		});
		return;
	}
	console.log(
		chalk.bold(`Remote runner attach token minted for ${input.sessionId}`),
	);
	console.log(`  gateway: ${input.gatewayBaseUrl}`);
	console.log(`  token:   ${input.tokenId}`);
	console.log(`  expires: ${input.expiresAt ?? "-"}`);
	if (input.verified) {
		console.log(chalk.green("  headless gateway: verified"));
	}
	if (input.showSecret || !input.verified) {
		console.log("");
		console.log(chalk.dim("Ephemeral remote transport environment:"));
		console.log(
			`export MAESTRO_REMOTE_BASE_URL=${JSON.stringify(input.gatewayBaseUrl)}`,
		);
		console.log(
			`export MAESTRO_REMOTE_API_KEY=${JSON.stringify(input.tokenSecret)}`,
		);
		console.log(
			`export MAESTRO_REMOTE_HEADER_X_EVALOPS_RUNNER_ATTACH_TOKEN_ID=${JSON.stringify(
				input.tokenId,
			)}`,
		);
	} else {
		console.log(
			chalk.dim(
				"  token secret hidden; rerun with --show-secret or --json when handoff needs it.",
			),
		);
	}
}

async function handleStart(options: RemoteCommandOptions): Promise<void> {
	const ttlMinutes = parseRemoteDurationMinutes(getFlag(options, "ttl"), 90);
	const idleTtlMinutes = parseOptionalDurationMinutes(
		getFlag(options, "idle-ttl", "idle"),
	);
	const result = await createRunnerSession(
		{
			workspaceId: getFlag(options, "workspace"),
			userId: getFlag(options, "user"),
			agentRunId: getFlag(options, "agent-run"),
			maestroSessionId: getFlag(options, "maestro-session", "session"),
			idempotencyKey: getFlag(options, "idempotency-key"),
			runnerProfile: getFlag(options, "profile") ?? "standard",
			runnerImage: getFlag(options, "image"),
			workspaceSource: getFlag(options, "workspace-source"),
			repoUrl: getFlag(options, "repo", "repo-url"),
			branch: getFlag(options, "branch") ?? "main",
			model: getFlag(options, "model"),
			ttlMinutes,
			idleTtlMinutes,
			metadata: parseMetadata(getRepeatedFlag(options, "metadata")),
		},
		clientOptions(options),
	);
	let waitResult:
		| {
				session: RunnerSession;
				attempts: number;
				elapsedMs: number;
		  }
		| undefined;
	let attachResult:
		| {
				gatewayBaseUrl: string;
				token: { id: string; expiresAt?: string };
				tokenSecret: string;
				verified?: Record<string, unknown>;
		  }
		| undefined;
	if (shouldWaitForStart(options)) {
		waitResult = await waitForRunnerSessionReady(result.session.id, {
			...clientOptions(options),
			timeoutMs: parseWaitDurationMs(
				getFlag(options, "wait-timeout"),
				DEFAULT_REMOTE_RUNNER_WAIT_TIMEOUT_MS,
			),
			pollIntervalMs: parseWaitDurationMs(
				getFlag(options, "poll-interval"),
				DEFAULT_REMOTE_RUNNER_WAIT_POLL_INTERVAL_MS,
			),
		});
	}
	if (hasFlag(options, "verify")) {
		const minted = await mintRunnerAttachToken(
			{
				sessionId: result.session.id,
				roles: roleValues(options),
				ttlMinutes: parseRemoteDurationMinutes(
					getFlag(options, "attach-ttl"),
					30,
				),
			},
			clientOptions(options),
		);
		attachResult = {
			gatewayBaseUrl: minted.gatewayBaseUrl,
			token: minted.token,
			tokenSecret: minted.tokenSecret,
			verified: await verifyRunnerHeadlessAttach({
				gatewayBaseUrl: minted.gatewayBaseUrl,
				tokenId: minted.token.id,
				tokenSecret: minted.tokenSecret,
				sessionId: result.session.id,
				protocolVersion: headlessProtocolVersion,
				clientVersion: getPackageVersion(),
				takeControl: hasFlag(options, "take-control"),
			}),
		};
	}
	if (jsonFlag(options)) {
		printJson({
			created: result,
			wait: waitResult,
			attach: attachResult,
		});
		return;
	}
	printSession(waitResult?.session ?? result.session);
	if (waitResult) {
		console.log(
			chalk.dim(
				`  ready:     ${formatElapsedMs(waitResult.elapsedMs)} (${waitResult.attempts} checks)`,
			),
		);
	}
	if (result.replayed) {
		console.log(chalk.dim("  replayed:  existing idempotent request"));
	}
	console.log("");
	if (attachResult) {
		printAttachInstructions({
			sessionId: result.session.id,
			gatewayBaseUrl: attachResult.gatewayBaseUrl,
			tokenId: attachResult.token.id,
			tokenSecret: attachResult.tokenSecret,
			expiresAt: attachResult.token.expiresAt,
			json: false,
			showSecret: hasFlag(options, "show-secret"),
			verified: attachResult.verified,
		});
		return;
	}
	console.log(chalk.dim(`Attach: maestro remote attach ${result.session.id}`));
}

async function handleList(options: RemoteCommandOptions): Promise<void> {
	const result = await listRunnerSessions(
		{
			workspaceId: getFlag(options, "workspace"),
			state: getFlag(options, "state"),
			limit: parseIntFlag(options, "limit", 20),
			offset: parseIntFlag(options, "offset", 0),
		},
		clientOptions(options),
	);
	if (jsonFlag(options)) {
		printJson(result);
		return;
	}
	printSessionTable(result.sessions);
	if (result.nextOffset !== undefined && result.nextOffset > 0) {
		console.log(chalk.dim(`next offset: ${result.nextOffset}`));
	}
}

async function handleStatus(options: RemoteCommandOptions): Promise<void> {
	const status = await getRemoteRunnerStatus(
		getFlag(options, "workspace"),
		clientOptions(options),
	);
	if (jsonFlag(options)) {
		printJson(status);
		return;
	}
	console.log(chalk.bold(status.service ?? "remote-runner"));
	console.log(`  workspace: ${status.workspaceId ?? "-"}`);
	console.log(`  policy:    ${status.downstreamPolicy ?? "-"}`);
}

async function handleGet(options: RemoteCommandOptions): Promise<void> {
	const sessionId = options.positionals[0];
	if (!sessionId) {
		throw new Error("Usage: maestro remote get <session-id>");
	}
	const session = await getRunnerSession(sessionId, clientOptions(options));
	if (jsonFlag(options)) {
		printJson(session);
		return;
	}
	printSession(session);
}

async function handleEvents(options: RemoteCommandOptions): Promise<void> {
	const sessionId = options.positionals[0];
	if (!sessionId) {
		throw new Error("Usage: maestro remote events <session-id>");
	}
	const result = await listRunnerSessionEvents(
		{
			sessionId,
			afterSequence: parseIntFlag(options, "after"),
			limit: parseIntFlag(options, "limit", 50),
		},
		clientOptions(options),
	);
	if (jsonFlag(options)) {
		printJson(result);
		return;
	}
	for (const event of result.events) {
		console.log(
			`${String(event.sequence ?? "-").padStart(4)}  ${
				event.occurredAt ?? "-"
			}  ${event.eventType ?? "-"}`,
		);
	}
	if (!result.events.length) {
		console.log(chalk.dim("No remote runner events found."));
	}
}

async function handleStop(options: RemoteCommandOptions): Promise<void> {
	const sessionId = options.positionals[0];
	if (!sessionId) {
		throw new Error("Usage: maestro remote stop <session-id> [--reason text]");
	}
	const result = await stopRunnerSession(
		sessionId,
		getFlag(options, "reason") ?? "maestro remote stop",
		clientOptions(options),
	);
	if (jsonFlag(options)) {
		printJson(result);
		return;
	}
	printSession(result.session);
}

async function handleExtend(options: RemoteCommandOptions): Promise<void> {
	const sessionId = options.positionals[0];
	if (!sessionId) {
		throw new Error("Usage: maestro remote extend <session-id> --ttl 2h");
	}
	const ttl = getFlag(options, "ttl", "add-ttl");
	if (!ttl) {
		throw new Error("maestro remote extend requires --ttl");
	}
	const result = await extendRunnerSession(
		{
			sessionId,
			additionalMinutes: parseRemoteDurationMinutes(ttl, 0),
			additionalIdleMinutes: parseOptionalDurationMinutes(
				getFlag(options, "idle-ttl", "add-idle-ttl"),
			),
			reason: getFlag(options, "reason") ?? "maestro remote extend",
		},
		clientOptions(options),
	);
	if (jsonFlag(options)) {
		printJson(result);
		return;
	}
	printSession(result.session);
}

async function mintAttach(options: RemoteCommandOptions) {
	const sessionId = options.positionals[0];
	if (!sessionId) {
		throw new Error("Usage: maestro remote attach <session-id>");
	}
	return mintRunnerAttachToken(
		{
			sessionId,
			subjectId: getFlag(options, "subject", "user"),
			roles: roleValues(options),
			ttlMinutes: parseRemoteDurationMinutes(getFlag(options, "ttl"), 30),
		},
		clientOptions(options),
	);
}

async function handleAttach(options: RemoteCommandOptions): Promise<void> {
	const sessionId = options.positionals[0];
	const minted = await mintAttach(options);
	if (
		shouldUseInteractiveRemoteAttach({
			json: jsonFlag(options),
			printEnv: hasFlag(options, "print-env"),
			stdinIsTTY: Boolean(process.stdin.isTTY),
			stdoutIsTTY: Boolean(process.stdout.isTTY),
		})
	) {
		await attachToRemoteRunnerSession({
			sessionId: sessionId!,
			gatewayBaseUrl: minted.gatewayBaseUrl,
			tokenId: minted.token.id,
			tokenSecret: minted.tokenSecret,
			role: attachConnectionRole(options),
			protocolVersion: headlessProtocolVersion,
			clientVersion: getPackageVersion(),
			takeControl: hasFlag(options, "take-control"),
		});
		return;
	}
	let verified: Record<string, unknown> | undefined;
	if (hasFlag(options, "verify")) {
		verified = await verifyRunnerHeadlessAttach({
			gatewayBaseUrl: minted.gatewayBaseUrl,
			tokenId: minted.token.id,
			tokenSecret: minted.tokenSecret,
			sessionId: sessionId!,
			protocolVersion: headlessProtocolVersion,
			clientVersion: getPackageVersion(),
			takeControl: hasFlag(options, "take-control"),
		});
	}
	printAttachInstructions({
		sessionId: sessionId!,
		gatewayBaseUrl: minted.gatewayBaseUrl,
		tokenId: minted.token.id,
		tokenSecret: minted.tokenSecret,
		expiresAt: minted.token.expiresAt,
		json: jsonFlag(options),
		showSecret: hasFlag(options, "show-secret"),
		verified,
	});
}

async function handleAttachToken(options: RemoteCommandOptions): Promise<void> {
	const sessionId = options.positionals[0];
	const minted = await mintAttach(options);
	if (jsonFlag(options)) {
		printJson(minted);
		return;
	}
	console.log(chalk.bold(`Attach token for ${sessionId}`));
	console.log(`  gateway: ${minted.gatewayBaseUrl}`);
	console.log(`  token:   ${minted.token.id}`);
	console.log(`  secret:  ${minted.tokenSecret}`);
	console.log(`  expires: ${minted.token.expiresAt ?? "-"}`);
}

async function handleRevokeToken(options: RemoteCommandOptions): Promise<void> {
	const sessionId = options.positionals[0];
	const tokenId = options.positionals[1];
	if (!sessionId || !tokenId) {
		throw new Error(
			"Usage: maestro remote revoke-token <session-id> <token-id>",
		);
	}
	const result = await revokeRunnerAttachToken(
		{ sessionId, tokenId },
		clientOptions(options),
	);
	if (jsonFlag(options)) {
		printJson(result);
		return;
	}
	console.log(chalk.bold(`Revoked attach token ${result.token.id}`));
}

async function handleTarget(options: RemoteCommandOptions): Promise<void> {
	const sessionId = options.positionals[0];
	if (!sessionId) {
		throw new Error("Usage: maestro remote target <session-id>");
	}
	const config = await resolveRemoteRunnerConfig(clientOptions(options));
	if (!config) {
		throw new Error(
			"Remote runner target requires EvalOps organization and access token.",
		);
	}
	const gatewayBaseUrl = remoteRunnerGatewayBaseUrl(config, sessionId);
	if (jsonFlag(options)) {
		printJson({ sessionId, gatewayBaseUrl });
		return;
	}
	console.log(gatewayBaseUrl);
}

export async function handleRemoteCommand(
	subcommand: string | undefined,
	args: string[] = [],
): Promise<void> {
	const options = parseRemoteOptions(args);
	if (!subcommand || subcommand === "help" || hasFlag(options, "help")) {
		console.log(REMOTE_USAGE);
		return;
	}

	try {
		switch (subcommand) {
			case "start":
				await handleStart(options);
				return;
			case "list":
				await handleList(options);
				return;
			case "status":
				await handleStatus(options);
				return;
			case "get":
				await handleGet(options);
				return;
			case "events":
				await handleEvents(options);
				return;
			case "stop":
				await handleStop(options);
				return;
			case "extend":
				await handleExtend(options);
				return;
			case "attach":
				await handleAttach(options);
				return;
			case "attach-token":
				await handleAttachToken(options);
				return;
			case "revoke-token":
				await handleRevokeToken(options);
				return;
			case "target":
				await handleTarget(options);
				return;
			default:
				throw new Error(`Unknown remote command: ${subcommand}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(message));
		process.exitCode = 1;
	}
}
