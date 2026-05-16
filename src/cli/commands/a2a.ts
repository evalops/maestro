import { randomUUID } from "node:crypto";
import chalk from "chalk";
import {
	type A2AAgentCard,
	type A2AServiceConfig,
	type A2ATask,
	buildA2AUserMessage,
	discoverA2AAgentCard,
	getA2ATask,
	sendA2AMessage,
} from "../../platform/a2a-client.js";
import {
	createA2APeerPairingPayload,
	createA2APeerPairingPayloadFromAgentCard,
	decodeA2APeerPairingCode,
	encodeA2APeerPairingCode,
	resolveA2AAgentCardUrl,
} from "../../platform/a2a-peer-pairing.js";
import {
	listA2APeers,
	resolveA2APeer,
	upsertA2APeerFromPairingPayload,
} from "../../platform/a2a-peer-registry.js";
import { getEnvValue } from "../../platform/client.js";

const DEFAULT_WAIT_MS = 300_000;
const DEFAULT_WAIT_INTERVAL_MS = 5_000;
const A2A_VALUE_FLAGS = new Set([
	"--agent-card-url",
	"--base-url",
	"--interval-ms",
	"--max-wait-ms",
	"--name",
	"--organization-id",
	"--peer-id",
	"--registry",
	"--timeout-ms",
	"--token-env",
	"--token-file",
	"--ttl-minutes",
	"--url",
	"--workspace-id",
]);
const A2A_BOOLEAN_FLAGS = new Set(["--default", "--wait"]);

export interface ParsedA2AArgs {
	positionals: string[];
	flags: Map<string, string | boolean>;
}

export async function handleA2ACommand(args: string[]): Promise<void> {
	const parsed = parseA2AArgs(args);
	const subcommand = parsed.positionals.shift()?.toLowerCase() ?? "help";
	switch (subcommand) {
		case "offer":
		case "pair":
		case "create":
			await handleA2AOffer(parsed);
			return;
		case "accept":
			await handleA2AAccept(parsed);
			return;
		case "peers":
		case "list":
			await handleA2APeers(parsed);
			return;
		case "card":
			await handleA2ACard(parsed);
			return;
		case "send":
			await handleA2ASend(parsed);
			return;
		case "wait":
			await handleA2AWait(parsed);
			return;
		default:
			printA2AHelp();
	}
}

export function parseA2AArgs(args: string[]): ParsedA2AArgs {
	const flags = new Map<string, string | boolean>();
	const positionals: string[] = [];
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
			if (!A2A_VALUE_FLAGS.has(flag) && !A2A_BOOLEAN_FLAGS.has(flag)) {
				positionals.push(arg);
				continue;
			}
			if (inlineValue !== undefined) {
				flags.set(flag, inlineValue);
				continue;
			}
			if (A2A_BOOLEAN_FLAGS.has(flag)) {
				flags.set(flag, true);
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

async function handleA2AOffer(parsed: ParsedA2AArgs): Promise<void> {
	const baseUrl =
		stringFlag(parsed, "--url") ?? stringFlag(parsed, "--base-url");
	const agentCardUrl = resolveA2AAgentCardUrl(
		stringFlag(parsed, "--agent-card-url") ??
			baseUrl ??
			getEnvValue([
				"MAESTRO_A2A_PUBLIC_URL",
				"MAESTRO_CONTROL_PUBLIC_URL",
				"MAESTRO_A2A_URL",
				"MAESTRO_CONTROL_URL",
			]) ??
			fail("Provide --url or set MAESTRO_A2A_PUBLIC_URL."),
	);
	const transportUrl = baseUrlFromAgentCardUrl(agentCardUrl);
	const ttlMs = minutesFlag(parsed, "--ttl-minutes") ?? 30 * 60 * 1000;
	const peerId = stringFlag(parsed, "--peer-id");
	const displayName = stringFlag(parsed, "--name");
	let agentCard: A2AAgentCard | null = null;
	try {
		agentCard = await discoverA2AAgentCard({
			baseUrl: transportUrl,
			timeoutMs: 2_500,
			maxAttempts: 1,
		});
	} catch (error) {
		if (!displayName) {
			throw new Error(
				`Could not fetch Agent Card at ${agentCardUrl}: ${errorMessage(error)}. Pass --name to create an offline pairing code.`,
			);
		}
	}
	const payload = agentCard
		? createA2APeerPairingPayloadFromAgentCard({
				agentCard,
				agentCardUrl,
				displayName,
				peerId,
				ttlMs,
			})
		: createA2APeerPairingPayload({
				displayName: displayName ?? "Maestro A2A Peer",
				agentCardUrl,
				transportUrl,
				peerId,
				ttlMs,
			});
	const code = encodeA2APeerPairingCode(payload);
	console.log(code);
	console.error(
		chalk.dim(
			`Pairing code for ${payload.displayName}; expires ${payload.expiresAt}. No token or bearer secret is embedded.`,
		),
	);
}

async function handleA2AAccept(parsed: ParsedA2AArgs): Promise<void> {
	const code =
		parsed.positionals.shift() ?? fail("Usage: maestro a2a accept <code>");
	const payload = decodeA2APeerPairingCode(code);
	const result = await upsertA2APeerFromPairingPayload(payload, {
		name: stringFlag(parsed, "--name"),
		makeDefault: booleanFlag(parsed, "--default"),
		tokenEnv: stringFlag(parsed, "--token-env"),
		tokenFile: stringFlag(parsed, "--token-file"),
		workspaceId: stringFlag(parsed, "--workspace-id"),
		organizationId: stringFlag(parsed, "--organization-id"),
		path: stringFlag(parsed, "--registry"),
	});
	console.log(
		`Registered A2A peer ${chalk.bold(result.name)} at ${result.entry.url}`,
	);
	console.log(chalk.dim(`Registry: ${result.path}`));
	if (!result.entry.tokenEnv && !result.entry.tokenFile) {
		console.log(
			chalk.dim(
				"No token source configured; add --token-env or --token-file if the peer requires Authorization.",
			),
		);
	}
}

async function handleA2APeers(parsed: ParsedA2AArgs): Promise<void> {
	const { path, registry } = await listA2APeers({
		path: stringFlag(parsed, "--registry"),
	});
	console.log(`A2A peers (${path})`);
	const entries = Object.entries(registry.peers).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	if (entries.length === 0) {
		console.log(
			chalk.dim("  No peers registered. Run maestro a2a accept <code>."),
		);
		return;
	}
	for (const [name, peer] of entries) {
		const marker = registry.defaultPeer === name ? "*" : " ";
		const tokenSource = peer.tokenEnv
			? ` token=env:${peer.tokenEnv}`
			: peer.tokenFile
				? " token=file"
				: "";
		console.log(
			`${marker} ${name} ${chalk.dim(peer.url)}${tokenSource}${
				peer.displayName ? chalk.dim(` (${peer.displayName})`) : ""
			}`,
		);
	}
}

async function handleA2ACard(parsed: ParsedA2AArgs): Promise<void> {
	const peerName = parsed.positionals.shift();
	const peer = await resolveA2APeer(peerName, {
		path: stringFlag(parsed, "--registry"),
	});
	const card = await discoverA2AAgentCard(peer.config);
	console.log(JSON.stringify(card, null, 2));
}

async function handleA2ASend(parsed: ParsedA2AArgs): Promise<void> {
	const peerName =
		parsed.positionals.shift() ?? fail("Usage: maestro a2a send <peer> <text>");
	const text = parsed.positionals.join(" ").trim();
	if (!text) {
		fail("Usage: maestro a2a send <peer> <text>");
	}
	const peer = await resolveA2APeer(peerName, {
		path: stringFlag(parsed, "--registry"),
		timeoutMs: numberFlag(parsed, "--timeout-ms"),
	});
	const wait = booleanFlag(parsed, "--wait");
	const sent = await sendA2AMessage(peer.config, {
		message: buildA2AUserMessage({
			messageId: `maestro-a2a-message-${randomUUID()}`,
			contextId: `maestro-a2a-context-${randomUUID()}`,
			text,
			metadata: {
				requestKind: "maestro-peer-message",
				relayPeer: peer.name,
			},
		}),
		...(wait ? { configuration: { returnImmediately: true } } : {}),
	});
	const task = wait
		? await waitForA2ATask(peer.config, sent.task.id, parsed)
		: sent.task;
	printTask(task);
}

async function handleA2AWait(parsed: ParsedA2AArgs): Promise<void> {
	const peerName =
		parsed.positionals.shift() ??
		fail("Usage: maestro a2a wait <peer> <task-id>");
	const taskId =
		parsed.positionals.shift() ??
		fail("Usage: maestro a2a wait <peer> <task-id>");
	const peer = await resolveA2APeer(peerName, {
		path: stringFlag(parsed, "--registry"),
		timeoutMs: numberFlag(parsed, "--timeout-ms"),
	});
	printTask(await waitForA2ATask(peer.config, taskId, parsed));
}

async function waitForA2ATask(
	config: A2AServiceConfig,
	taskId: string,
	parsed: ParsedA2AArgs,
): Promise<A2ATask> {
	const maxWaitMs = numberFlag(parsed, "--max-wait-ms") ?? DEFAULT_WAIT_MS;
	const intervalMs =
		numberFlag(parsed, "--interval-ms") ?? DEFAULT_WAIT_INTERVAL_MS;
	const deadline = Date.now() + maxWaitMs;
	let lastTask = await getA2ATask(config, taskId);
	while (
		!isA2AWaitCompletionState(lastTask.status.state) &&
		Date.now() < deadline
	) {
		await sleep(intervalMs);
		lastTask = await getA2ATask(config, taskId);
	}
	if (!isA2AWaitCompletionState(lastTask.status.state)) {
		throw new Error(
			`Timed out waiting for A2A task ${taskId}; last state ${lastTask.status.state}`,
		);
	}
	return lastTask;
}

function printTask(task: A2ATask): void {
	console.log(`Task ${task.id}: ${task.status.state}`);
	const text = a2aTaskText(task);
	if (text) {
		console.log(text);
	}
}

function a2aTaskText(task: A2ATask): string | undefined {
	const statusText = task.status.message?.parts
		.map((part) => part.text)
		.find(
			(text): text is string =>
				typeof text === "string" && text.trim().length > 0,
		);
	if (statusText) {
		return statusText;
	}
	return task.artifacts
		?.flatMap((artifact) => artifact.parts)
		.map((part) => part.text)
		.find(
			(text): text is string =>
				typeof text === "string" && text.trim().length > 0,
		);
}

export function isA2AWaitCompletionState(state: string): boolean {
	const normalized = state.toUpperCase().replace(/[\s-]+/gu, "_");
	return (
		normalized.includes("COMPLETED") ||
		normalized.includes("FAILED") ||
		normalized.includes("CANCELED") ||
		normalized.includes("CANCELLED") ||
		normalized.includes("REJECTED") ||
		normalized.includes("INPUT_REQUIRED") ||
		normalized.includes("AUTH_REQUIRED")
	);
}

function baseUrlFromAgentCardUrl(agentCardUrl: string): string {
	const parsed = new URL(agentCardUrl);
	parsed.pathname = parsed.pathname.replace(
		/\/\.well-known\/agent-card\.json$/u,
		"",
	);
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/u, "");
}

function stringFlag(parsed: ParsedA2AArgs, name: string): string | undefined {
	const value = parsed.flags.get(name);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFlag(parsed: ParsedA2AArgs, name: string): number | undefined {
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

function minutesFlag(parsed: ParsedA2AArgs, name: string): number | undefined {
	const value = numberFlag(parsed, name);
	return value === undefined ? undefined : value * 60 * 1000;
}

function booleanFlag(parsed: ParsedA2AArgs, name: string): boolean {
	return parsed.flags.get(name) === true;
}

function fail(message: string): never {
	throw new Error(message);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function printA2AHelp(): void {
	console.log(`Usage:
  maestro a2a offer --url <base-url> [--name <display-name>] [--peer-id <id>]
  maestro a2a accept <pairing-code> [--name <peer>] [--default] [--token-env ENV]
  maestro a2a peers
  maestro a2a card <peer>
  maestro a2a send <peer> <text> [--wait]
  maestro a2a wait <peer> <task-id>

Pairing codes carry Agent Card and transport coordinates only. Configure auth with
--token-env or --token-file when accepting a peer; bearer tokens are never embedded.`);
}
