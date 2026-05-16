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
import { inspectA2AFleet } from "../../platform/a2a-fleet.js";
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
import {
	type A2ATaskLedgerEntry,
	extractA2ATaskText,
	getA2ATaskLedgerPath,
	isActionRequiredA2AState,
	isFinalA2AState,
	isTerminalA2AState,
	listA2ATaskEntries,
	loadA2ATaskLedger,
	recordA2ATaskReply,
	recordA2ATaskStart,
	updateA2ATaskInLedger,
} from "../../platform/a2a-task-ledger.js";
import {
	extractA2AWorkGraphMetadata,
	formatA2AWorkGraphCodexSubagents,
	formatA2AWorkGraphSummary,
} from "../../platform/a2a-work-graph.js";
import { getEnvValue } from "../../platform/client.js";
import { isAbortError } from "../../utils/abort-error.js";

const DEFAULT_WAIT_MS = 300_000;
const DEFAULT_WAIT_INTERVAL_MS = 5_000;
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
	delegate: [
		"--cwd",
		"--interval-ms",
		"--max-wait-ms",
		"--registry",
		"--role",
		"--tasks",
		"--timeout-ms",
	],
	coordinate: [
		"--interval-ms",
		"--max-wait-ms",
		"--registry",
		"--reply",
		"--tasks",
		"--timeout-ms",
	],
	fleet: ["--registry", "--tasks", "--timeout-ms"],
	offer: [
		"--agent-card-url",
		"--base-url",
		"--name",
		"--peer-id",
		"--ttl-minutes",
		"--url",
	],
	peers: ["--registry"],
	reply: [
		"--interval-ms",
		"--max-wait-ms",
		"--registry",
		"--tasks",
		"--timeout-ms",
	],
	send: ["--interval-ms", "--max-wait-ms", "--registry", "--timeout-ms"],
	tasks: ["--registry", "--tasks", "--timeout-ms"],
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
	coordinate: ["--json", "--refresh", "--wait", "--work-graph"],
	delegate: ["--wait", "--work-graph"],
	fleet: ["--json"],
	reply: ["--wait", "--work-graph"],
	send: ["--wait", "--work-graph"],
	tasks: ["--json", "--refresh", "--work-graph"],
	wait: ["--work-graph"],
};
const A2A_COLLECT_VALUE_FLAGS_BY_SUBCOMMAND: Record<string, readonly string[]> =
	{
		coordinate: ["--reply"],
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
		case "fleet":
			await handleA2AFleet(parsed);
			return;
		case "card":
			await handleA2ACard(parsed);
			return;
		case "send":
			await handleA2ASend(parsed);
			return;
		case "delegate":
		case "delegation":
			await handleA2ADelegate(parsed);
			return;
		case "reply":
		case "continue":
			await handleA2AReply(parsed);
			return;
		case "coordinate":
			await handleA2ACoordinate(parsed);
			return;
		case "tasks":
			await handleA2ATasks(parsed);
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
	const subcommandIndex = findA2ASubcommandIndex(args);
	const subcommand =
		subcommandIndex >= 0
			? canonicalA2ASubcommand(args[subcommandIndex])
			: "help";
	const valueFlags = new Set(A2A_VALUE_FLAGS_BY_SUBCOMMAND[subcommand] ?? []);
	const booleanFlags = new Set(
		A2A_BOOLEAN_FLAGS_BY_SUBCOMMAND[subcommand] ?? [],
	);
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

function canonicalA2ASubcommand(input: string | undefined): string {
	switch (input?.toLowerCase()) {
		case "pair":
		case "create":
			return "offer";
		case "list":
			return "peers";
		case "delegation":
			return "delegate";
		case "continue":
			return "reply";
		default:
			return input?.toLowerCase() ?? "help";
	}
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

async function handleA2AFleet(parsed: ParsedA2AArgs): Promise<void> {
	const fleet = await inspectA2AFleet({
		registryPath: stringFlag(parsed, "--registry"),
		tasksPath: stringFlag(parsed, "--tasks"),
		timeoutMs: numberFlag(parsed, "--timeout-ms"),
	});
	if (booleanFlag(parsed, "--json")) {
		console.log(JSON.stringify(fleet, null, 2));
		return;
	}
	console.log(`A2A fleet (${fleet.registryPath})`);
	if (fleet.peers.length === 0) {
		console.log(
			chalk.dim("  No peers registered. Run maestro a2a accept <code>."),
		);
		return;
	}
	for (const peer of fleet.peers) {
		const status =
			peer.status === "online" ? chalk.green("online") : chalk.yellow("down");
		const label = peer.displayName
			? `${peer.name} (${peer.displayName})`
			: peer.name;
		console.log(`${status} ${chalk.bold(label)} ${chalk.dim(peer.url)}`);
		if (peer.model || peer.cwd || peer.auth) {
			console.log(
				chalk.dim(
					`  ${[
						peer.model ? `model=${peer.model}` : undefined,
						peer.cwd ? `cwd=${peer.cwd}` : undefined,
						peer.auth ? `auth=${peer.auth}` : undefined,
					]
						.filter(Boolean)
						.join(" ")}`,
				),
			);
		}
		if (peer.lastTask) {
			console.log(
				chalk.dim(
					`  last=${peer.lastTask.id} ${peer.lastTask.state} ${peer.lastTask.text}`,
				),
			);
		}
		if (peer.error) {
			console.log(chalk.dim(`  error=${peer.error}`));
		}
	}
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
	printTask(task, {
		includeWorkGraphDetails: booleanFlag(parsed, "--work-graph"),
	});
}

async function handleA2ADelegate(parsed: ParsedA2AArgs): Promise<void> {
	const peerName =
		parsed.positionals.shift() ??
		fail("Usage: maestro a2a delegate <peer> <text>");
	const text = parsed.positionals.join(" ").trim();
	if (!text) {
		fail("Usage: maestro a2a delegate <peer> <text>");
	}
	const peer = await resolveA2APeer(peerName, {
		path: stringFlag(parsed, "--registry"),
		timeoutMs: numberFlag(parsed, "--timeout-ms"),
	});
	const wait = booleanFlag(parsed, "--wait");
	const role = stringFlag(parsed, "--role");
	const cwd = stringFlag(parsed, "--cwd") ?? process.cwd();
	const messageId = `maestro-a2a-message-${randomUUID()}`;
	const contextId = `maestro-a2a-context-${randomUUID()}`;
	const sent = await sendA2AMessage(peer.config, {
		message: buildA2AUserMessage({
			messageId,
			contextId,
			text,
			metadata: {
				requestKind: "maestro-peer-delegation",
				relayPeer: peer.name,
				...(role ? { delegationRole: role } : {}),
				...(cwd ? { delegationCwd: cwd } : {}),
			},
		}),
		configuration: { returnImmediately: true },
	});
	console.log(`Delegated to ${chalk.bold(peer.name)} as task ${sent.task.id}`);
	await persistA2ALedgerBestEffort("record delegated task locally", () =>
		recordA2ATaskStart({
			path: stringFlag(parsed, "--tasks"),
			peer: peer.name,
			peerDisplayName: peer.entry.displayName,
			task: sent.task,
			text,
			messageId,
			contextId,
			kind: "delegation",
			role,
			cwd,
			metadata: {
				requestKind: "maestro-peer-delegation",
				relayPeer: peer.name,
				delegationRole: role,
				delegationCwd: cwd,
			},
		}),
	);
	const task = wait
		? await waitForA2ATask(peer.config, sent.task.id, parsed)
		: sent.task;
	if (wait) {
		await persistA2ALedgerBestEffort("sync delegated task result locally", () =>
			updateA2ATaskInLedger({
				path: stringFlag(parsed, "--tasks"),
				peer: peer.name,
				task,
			}),
		);
	}
	printTask(task, {
		includeWorkGraphDetails: booleanFlag(parsed, "--work-graph"),
	});
}

async function handleA2AReply(parsed: ParsedA2AArgs): Promise<void> {
	const peerName =
		parsed.positionals.shift() ??
		fail("Usage: maestro a2a reply <peer> <task-id> <text>");
	const taskId =
		parsed.positionals.shift() ??
		fail("Usage: maestro a2a reply <peer> <task-id> <text>");
	const text = parsed.positionals.join(" ").trim();
	if (!text) {
		fail("Usage: maestro a2a reply <peer> <task-id> <text>");
	}
	const peer = await resolveA2APeer(peerName, {
		path: stringFlag(parsed, "--registry"),
		timeoutMs: numberFlag(parsed, "--timeout-ms"),
	});
	const existing = await loadA2AReplyLedgerEntry(parsed, peer.name, taskId);
	const wait = booleanFlag(parsed, "--wait");
	const messageId = `maestro-a2a-message-${randomUUID()}`;
	const sent = await sendA2AMessage(peer.config, {
		message: buildA2AUserMessage({
			messageId,
			contextId: existing?.contextId,
			taskId,
			text,
			metadata: {
				requestKind: "maestro-peer-task-reply",
				relayPeer: peer.name,
				referencedTaskId: taskId,
			},
		}),
		configuration: { returnImmediately: true },
	});
	console.log(`Replied to ${chalk.bold(peer.name)} task ${sent.task.id}`);
	await persistA2ALedgerBestEffort("record task reply locally", () =>
		recordA2ATaskReply({
			path: stringFlag(parsed, "--tasks"),
			peer: peer.name,
			peerDisplayName: peer.entry.displayName,
			task: sent.task,
			text,
			messageId,
			metadata: {
				requestKind: "maestro-peer-task-reply",
				relayPeer: peer.name,
				referencedTaskId: taskId,
			},
		}),
	);
	const task = wait
		? await waitForA2ATask(peer.config, sent.task.id, parsed)
		: sent.task;
	if (wait) {
		await persistA2ALedgerBestEffort("sync replied task result locally", () =>
			updateA2ATaskInLedger({
				path: stringFlag(parsed, "--tasks"),
				peer: peer.name,
				task,
			}),
		);
	}
	printTask(task, {
		includeWorkGraphDetails: booleanFlag(parsed, "--work-graph"),
	});
}

async function handleA2ACoordinate(parsed: ParsedA2AArgs): Promise<void> {
	const peerName = parsed.positionals.shift();
	if (parsed.positionals.length > 0) {
		fail("Usage: maestro a2a coordinate [peer] [--reply <text>] [--wait]");
	}
	const replyText = stringFlag(parsed, "--reply");
	if (parsed.flags.has("--reply") && !replyText) {
		fail("Usage: maestro a2a coordinate [peer] --reply <text> [--wait]");
	}
	if (replyText) {
		await handleA2ACoordinateReply(parsed, peerName, replyText);
		return;
	}
	await refreshA2ANonFinalTaskLedger(parsed, peerName);
	const ledger = await loadA2ATaskLedger({
		path: stringFlag(parsed, "--tasks"),
	});
	const tasks = actionableA2ATaskEntries(ledger, peerName);
	if (booleanFlag(parsed, "--json")) {
		console.log(
			JSON.stringify(
				{
					path: getA2ATaskLedgerPath(stringFlag(parsed, "--tasks")),
					tasks: tasks.map((entry) => ({
						id: entry.id,
						kind: entry.kind,
						peer: entry.peer,
						taskId: entry.taskId,
						contextId: entry.contextId,
						state: entry.state,
						text: entry.text,
						responseText: entry.responseText,
						workGraph: entry.workGraph,
						updatedAt: entry.updatedAt,
					})),
				},
				null,
				2,
			),
		);
		return;
	}
	console.log(
		`A2A coordinate (${getA2ATaskLedgerPath(stringFlag(parsed, "--tasks"))})`,
	);
	if (tasks.length === 0) {
		console.log(chalk.dim("  No actionable A2A tasks require coordination."));
		return;
	}
	for (const task of tasks) {
		console.log(
			`${task.peer} ${chalk.bold(task.taskId)} ${task.state} ${chalk.dim(task.updatedAt)}`,
		);
		console.log(chalk.dim(`  ${task.text}`));
		if (task.responseText) {
			console.log(`  ${task.responseText}`);
		}
		printLedgerWorkGraph(task, booleanFlag(parsed, "--work-graph"));
	}
}

async function handleA2ACoordinateReply(
	parsed: ParsedA2AArgs,
	peerName: string | undefined,
	text: string,
): Promise<void> {
	await refreshA2ANonFinalTaskLedger(parsed, peerName);
	const ledger = await loadA2ATaskLedger({
		path: stringFlag(parsed, "--tasks"),
	});
	const entry = selectCoordinateReplyTask(ledger, peerName);
	if (!entry) {
		fail("No actionable A2A task is waiting for coordinator input.");
	}
	const peer = await resolveA2APeer(entry.peer, {
		path: stringFlag(parsed, "--registry"),
		timeoutMs: numberFlag(parsed, "--timeout-ms"),
	});
	const messageId = `maestro-a2a-message-${randomUUID()}`;
	const sent = await sendA2AMessage(peer.config, {
		message: buildA2AUserMessage({
			messageId,
			contextId: entry.contextId,
			taskId: entry.taskId,
			text,
			metadata: {
				requestKind: "maestro-peer-coordinate-reply",
				relayPeer: peer.name,
				referencedTaskId: entry.taskId,
			},
		}),
		configuration: { returnImmediately: true },
	});
	const replyTask: A2ATask = {
		...sent.task,
		id: entry.taskId,
		contextId: sent.task.contextId ?? entry.contextId,
	};
	const json = booleanFlag(parsed, "--json");
	if (!json) {
		console.log(`Coordinated ${chalk.bold(peer.name)} task ${entry.taskId}`);
	}
	await persistA2ALedgerBestEffort("record coordinate reply locally", () =>
		recordA2ATaskReply({
			path: stringFlag(parsed, "--tasks"),
			peer: peer.name,
			peerDisplayName: peer.entry.displayName,
			task: replyTask,
			text,
			messageId,
			metadata: {
				requestKind: "maestro-peer-coordinate-reply",
				relayPeer: peer.name,
				referencedTaskId: entry.taskId,
			},
		}),
	);
	const task = booleanFlag(parsed, "--wait")
		? await waitForA2ATask(peer.config, entry.taskId, parsed)
		: replyTask;
	if (booleanFlag(parsed, "--wait")) {
		await persistA2ALedgerBestEffort(
			"sync coordinate task result locally",
			() =>
				updateA2ATaskInLedger({
					path: stringFlag(parsed, "--tasks"),
					peer: peer.name,
					task,
				}),
		);
	}
	if (json) {
		console.log(JSON.stringify({ peer: peer.name, task }, null, 2));
		return;
	}
	printTask(task, {
		includeWorkGraphDetails: booleanFlag(parsed, "--work-graph"),
	});
}

function actionableA2ATaskEntries(
	ledger: { tasks: A2ATaskLedgerEntry[] },
	peerName: string | undefined,
): A2ATaskLedgerEntry[] {
	return listA2ATaskEntries(ledger, { peer: peerName }).filter((entry) =>
		isActionRequiredA2AState(entry.state),
	);
}

function selectCoordinateReplyTask(
	ledger: { tasks: A2ATaskLedgerEntry[] },
	peerName: string | undefined,
): A2ATaskLedgerEntry | undefined {
	const tasks = actionableA2ATaskEntries(ledger, peerName);
	if (tasks.length > 1) {
		fail(
			"Multiple actionable A2A tasks found; use `maestro a2a reply <peer> <task-id> <text>`.",
		);
	}
	return tasks[0];
}

async function loadA2AReplyLedgerEntry(
	parsed: ParsedA2AArgs,
	peerName: string,
	taskId: string,
): Promise<A2ATaskLedgerEntry | undefined> {
	try {
		const ledger = await loadA2ATaskLedger({
			path: stringFlag(parsed, "--tasks"),
		});
		return listA2ATaskEntries(ledger, { peer: peerName }).find(
			(entry) => entry.taskId === taskId,
		);
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		console.error(
			chalk.yellow(
				`A2A task ledger warning: could not load task reply context: ${errorMessage(error)}`,
			),
		);
		return undefined;
	}
}

async function handleA2ATasks(parsed: ParsedA2AArgs): Promise<void> {
	const peerName = parsed.positionals.shift();
	if (booleanFlag(parsed, "--refresh")) {
		await refreshA2ATaskLedger(parsed, peerName);
	}
	const ledger = await loadA2ATaskLedger({
		path: stringFlag(parsed, "--tasks"),
	});
	const tasks = listA2ATaskEntries(ledger, { peer: peerName });
	if (booleanFlag(parsed, "--json")) {
		console.log(
			JSON.stringify(
				{
					path: getA2ATaskLedgerPath(stringFlag(parsed, "--tasks")),
					tasks: tasks.map((entry) => ({
						id: entry.id,
						kind: entry.kind,
						peer: entry.peer,
						taskId: entry.taskId,
						state: entry.state,
						text: entry.text,
						responseText: entry.responseText,
						workGraph: entry.workGraph,
						updatedAt: entry.updatedAt,
					})),
				},
				null,
				2,
			),
		);
		return;
	}
	console.log(
		`A2A tasks (${getA2ATaskLedgerPath(stringFlag(parsed, "--tasks"))})`,
	);
	if (tasks.length === 0) {
		console.log(chalk.dim("  No delegated tasks recorded yet."));
		return;
	}
	for (const task of tasks) {
		console.log(
			`${task.peer} ${chalk.bold(task.taskId)} ${task.state} ${chalk.dim(task.updatedAt)}`,
		);
		console.log(chalk.dim(`  ${task.text}`));
		if (task.responseText) {
			console.log(`  ${task.responseText}`);
		}
		printLedgerWorkGraph(task, booleanFlag(parsed, "--work-graph"));
	}
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
	const task = await waitForA2ATask(peer.config, taskId, parsed);
	await persistA2ALedgerBestEffort("sync task result locally", () =>
		updateA2ATaskInLedger({
			path: stringFlag(parsed, "--tasks"),
			peer: peer.name,
			task,
		}),
	);
	printTask(task, {
		includeWorkGraphDetails: booleanFlag(parsed, "--work-graph"),
	});
}

async function refreshA2ATaskLedger(
	parsed: ParsedA2AArgs,
	peerFilter: string | undefined,
): Promise<void> {
	const ledger = await loadA2ATaskLedger({
		path: stringFlag(parsed, "--tasks"),
	});
	for (const entry of listA2ATaskEntries(ledger, { peer: peerFilter })) {
		if (isTerminalA2AState(entry.state)) {
			continue;
		}
		const peer = await resolveA2APeer(entry.peer, {
			path: stringFlag(parsed, "--registry"),
			timeoutMs: numberFlag(parsed, "--timeout-ms"),
		});
		const task = await getA2ATask(peer.config, entry.taskId);
		await updateA2ATaskInLedger({
			path: stringFlag(parsed, "--tasks"),
			peer: entry.peer,
			task,
		});
	}
}

async function refreshA2ANonFinalTaskLedger(
	parsed: ParsedA2AArgs,
	peerFilter: string | undefined,
): Promise<void> {
	const ledger = await loadA2ATaskLedger({
		path: stringFlag(parsed, "--tasks"),
	});
	for (const entry of listA2ATaskEntries(ledger, { peer: peerFilter })) {
		if (isFinalA2AState(entry.state)) {
			continue;
		}
		try {
			const peer = await resolveA2APeer(entry.peer, {
				path: stringFlag(parsed, "--registry"),
				timeoutMs: numberFlag(parsed, "--timeout-ms"),
			});
			const task = await getA2ATask(peer.config, entry.taskId);
			await updateA2ATaskInLedger({
				path: stringFlag(parsed, "--tasks"),
				peer: entry.peer,
				task,
			});
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			console.error(
				chalk.yellow(
					`A2A coordinate warning: could not refresh ${entry.peer} task ${entry.taskId}: ${errorMessage(error)}`,
				),
			);
		}
	}
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
	while (!isTerminalA2AState(lastTask.status.state) && Date.now() < deadline) {
		await sleep(intervalMs);
		lastTask = await getA2ATask(config, taskId);
	}
	if (!isTerminalA2AState(lastTask.status.state)) {
		throw new Error(
			`Timed out waiting for A2A task ${taskId}; last state ${lastTask.status.state}`,
		);
	}
	return lastTask;
}

function printTask(
	task: A2ATask,
	options: { includeWorkGraphDetails?: boolean } = {},
): void {
	console.log(`Task ${task.id}: ${task.status.state}`);
	const text = a2aTaskText(task);
	if (text) {
		console.log(text);
	}
	printTaskWorkGraph(task, Boolean(options.includeWorkGraphDetails));
}

function a2aTaskText(task: A2ATask): string | undefined {
	return extractA2ATaskText(task);
}

function printTaskWorkGraph(task: A2ATask, includeDetails: boolean): void {
	printWorkGraphLines(extractA2AWorkGraphMetadata(task), includeDetails);
}

function printLedgerWorkGraph(
	entry: A2ATaskLedgerEntry,
	includeDetails: boolean,
): void {
	printWorkGraphLines(entry.workGraph, includeDetails);
}

function printWorkGraphLines(
	workGraph: A2ATaskLedgerEntry["workGraph"],
	includeDetails: boolean,
): void {
	const summary = formatA2AWorkGraphSummary(workGraph);
	if (summary) {
		console.log(chalk.dim(`  ${summary}`));
	}
	if (!includeDetails) {
		return;
	}
	const codexSubagents = formatA2AWorkGraphCodexSubagents(workGraph);
	if (codexSubagents) {
		console.log(chalk.dim(`  ${codexSubagents}`));
	}
	if (workGraph?.correlationPath) {
		console.log(chalk.dim(`  Correlation: ${workGraph.correlationPath}`));
	}
}

export const isA2AWaitCompletionState = isTerminalA2AState;

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

async function persistA2ALedgerBestEffort(
	description: string,
	action: () => Promise<unknown>,
): Promise<void> {
	try {
		await action();
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		console.error(
			chalk.yellow(
				`A2A task ledger warning: could not ${description}: ${errorMessage(error)}`,
			),
		);
	}
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
  maestro a2a fleet [--json]
  maestro a2a card <peer>
  maestro a2a coordinate [peer] [--reply <text>] [--wait] [--json] [--work-graph]
  maestro a2a delegate <peer> <text> [--role <role>] [--cwd <path>] [--wait] [--work-graph]
  maestro a2a reply <peer> <task-id> <text> [--wait] [--work-graph]
  maestro a2a send <peer> <text> [--wait] [--work-graph]
  maestro a2a tasks [peer] [--json] [--refresh] [--work-graph]
  maestro a2a wait <peer> <task-id> [--work-graph]

Pairing codes carry Agent Card and transport coordinates only. Configure auth with
--token-env or --token-file when accepting a peer; bearer tokens are never embedded.`);
}
