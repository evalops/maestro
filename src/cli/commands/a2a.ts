import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { selectA2ACapabilityPeer } from "../../platform/a2a-capability-market.js";
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
	buildMaestroA2APeerProjection,
	defaultMaestroA2ACapabilities,
} from "../../platform/a2a-maestro-peer.js";
import {
	createA2APeerPairingPayload,
	createA2APeerPairingPayloadFromAgentCard,
	decodeA2APeerPairingCode,
	encodeA2APeerPairingCode,
	resolveA2AAgentCardUrl,
} from "../../platform/a2a-peer-pairing.js";
import {
	type A2APeerRegistryEntry,
	listA2APeers,
	loadA2APeerRegistry,
	normalizePeerName,
	resolveA2APeer,
	saveA2APeerRegistry,
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
import {
	PlatformA2ADelegationTaskControlModeValue,
	type PlatformAgentRegistryA2APeerCandidate,
	type PlatformAgentRegistryAgent,
	PlatformAgentStatusValue,
	controlA2ADelegationTaskWithPlatform,
	getA2ADelegationGraphWithPlatform,
	heartbeatAgentWithPlatform,
	isAgentAlreadyExistsError,
	listA2APeerCandidatesWithPlatform,
	registerAgentWithPlatform,
	updateAgentWithPlatform,
} from "../../platform/agent-registry-client.js";
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
		"--interval-ms",
		"--limit",
		"--max-wait-ms",
		"--offset",
		"--registry",
		"--role",
		"--skill",
		"--status",
		"--surface",
		"--tasks",
		"--timeout-ms",
		"--workspace-id",
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
	delegate: ["--discover", "--prefer-internal", "--wait", "--work-graph"],
	discover: ["--default", "--import", "--json", "--prefer-internal"],
	fleet: ["--json"],
	graph: ["--json"],
	register: ["--heartbeat-only", "--json", "--no-heartbeat", "--update-only"],
	reply: ["--wait", "--work-graph"],
	send: ["--wait", "--work-graph"],
	tasks: ["--json", "--refresh", "--work-graph"],
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

export async function handleA2ACommand(args: string[]): Promise<void> {
	const parsed = parseA2AArgs(args);
	const subcommand = canonicalA2ASubcommand(parsed.positionals.shift());
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
		case "discover":
			await handleA2ADiscover(parsed);
			return;
		case "register":
			await handleA2ARegister(parsed);
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
		case "control":
			await handleA2AControl(parsed);
			return;
		case "graph":
			await handleA2AGraph(parsed);
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
		case "publish":
			return "register";
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

async function handleA2ADiscover(parsed: ParsedA2AArgs): Promise<void> {
	const candidates = await listA2APeerCandidatesWithPlatform({
		workspaceId: stringFlag(parsed, "--workspace-id"),
		capability: stringFlag(parsed, "--capability"),
		surface: stringFlag(parsed, "--surface"),
		status: stringFlag(parsed, "--status"),
		limit: numberFlag(parsed, "--limit"),
		offset: nonNegativeNumberFlag(parsed, "--offset"),
		skillId: stringFlag(parsed, "--skill"),
		preferInternalEndpoint: booleanFlag(parsed, "--prefer-internal"),
	});
	if (!candidates) {
		fail(
			"Agent Registry service is not configured. Set AGENT_REGISTRY_SERVICE_URL, AGENT_REGISTRY_SERVICE_TOKEN, AGENT_REGISTRY_ORGANIZATION_ID, and AGENT_REGISTRY_WORKSPACE_ID.",
		);
	}
	const imported = booleanFlag(parsed, "--import")
		? await importDiscoveredA2APeers(parsed, candidates)
		: [];
	if (booleanFlag(parsed, "--json")) {
		console.log(
			JSON.stringify(
				{
					peers: candidates.map(discoveredPeerJson),
					imported,
				},
				null,
				2,
			),
		);
		return;
	}
	console.log("Platform A2A peers");
	if (candidates.length === 0) {
		console.log(chalk.dim("  No Platform agents expose A2A peer endpoints."));
		return;
	}
	for (const candidate of candidates) {
		const label =
			candidate.agent.name ?? candidate.agent.id ?? candidate.endpointUrl;
		const skillSummary = candidate.skills.map((skill) => skill.id).join(", ");
		console.log(
			`${chalk.bold(label)} ${chalk.dim(candidate.endpointUrl)}${
				candidate.agent.status ? chalk.dim(` ${candidate.agent.status}`) : ""
			}`,
		);
		if (candidate.agent.id || candidate.protocolBinding) {
			console.log(
				chalk.dim(
					`  ${[
						candidate.agent.id ? `agent=${candidate.agent.id}` : undefined,
						candidate.protocolBinding
							? `binding=${candidate.protocolBinding}`
							: undefined,
						candidate.protocolVersion
							? `version=${candidate.protocolVersion}`
							: undefined,
					]
						.filter(Boolean)
						.join(" ")}`,
				),
			);
		}
		if (skillSummary) {
			console.log(chalk.dim(`  skills=${skillSummary}`));
		}
	}
	if (imported.length > 0) {
		console.log(chalk.dim(`Imported ${imported.length} peer(s).`));
		console.log(chalk.dim(`Registry: ${imported[0]?.path}`));
	}
}

async function handleA2ARegister(parsed: ParsedA2AArgs): Promise<void> {
	const heartbeatOnly = booleanFlag(parsed, "--heartbeat-only");
	const agentId =
		stringFlag(parsed, "--agent-id") ??
		getEnvValue([
			"MAESTRO_A2A_AGENT_ID",
			"MAESTRO_AGENT_ID",
			"EVALOPS_AGENT_ID",
		]);
	const name =
		stringFlag(parsed, "--name") ??
		getEnvValue(["MAESTRO_A2A_AGENT_NAME", "MAESTRO_AGENT_NAME"]) ??
		"Maestro A2A Peer";
	const description =
		stringFlag(parsed, "--description") ??
		getEnvValue([
			"MAESTRO_A2A_AGENT_DESCRIPTION",
			"MAESTRO_AGENT_DESCRIPTION",
		]) ??
		"Maestro peer exposing governed Codex subagent lanes through A2A.";
	const workspaceId = stringFlag(parsed, "--workspace-id");
	const capabilities = stringListFlag(
		parsed,
		"--capabilities",
		defaultMaestroA2ACapabilities(),
	);
	const surfaces = stringListFlag(parsed, "--surface", ["a2a", "maestro"]);
	const surfaceTypes = stringListFlag(parsed, "--surface-types", [
		"SURFACE_MAESTRO",
	]);
	const publicEndpointUrl = heartbeatOnly
		? undefined
		: (stringFlag(parsed, "--public-url") ??
			stringFlag(parsed, "--url") ??
			getEnvValue([
				"MAESTRO_A2A_PUBLIC_URL",
				"MAESTRO_CONTROL_PUBLIC_URL",
				"MAESTRO_A2A_URL",
				"MAESTRO_CONTROL_URL",
			]) ??
			fail("Provide --url or set MAESTRO_A2A_PUBLIC_URL."));
	const a2a = publicEndpointUrl
		? buildMaestroA2APeerProjection({
				publicEndpointUrl,
				internalEndpointUrl:
					stringFlag(parsed, "--internal-url") ??
					getEnvValue([
						"MAESTRO_A2A_INTERNAL_URL",
						"MAESTRO_CONTROL_INTERNAL_URL",
					]),
				agentCardUrl: stringFlag(parsed, "--agent-card-url"),
				protocolVersion: stringFlag(parsed, "--protocol-version"),
				agentCardETag: stringFlag(parsed, "--agent-card-etag"),
				agentCardHash: stringFlag(parsed, "--agent-card-hash"),
				securitySchemes: stringListFlag(parsed, "--security-schemes", [
					"evalops-agent-token",
				]),
				attributes: {
					publishedBy: "maestro a2a register",
				},
			})
		: undefined;
	const updateOnly = booleanFlag(parsed, "--update-only");
	const shouldHeartbeat = !booleanFlag(parsed, "--no-heartbeat");
	if (heartbeatOnly && !shouldHeartbeat) {
		fail("--heartbeat-only cannot be combined with --no-heartbeat.");
	}
	let operation: "registered" | "updated" | "heartbeat" = "registered";
	let agent: PlatformAgentRegistryAgent | undefined;

	if (heartbeatOnly) {
		if (!agentId) {
			fail("Usage: maestro a2a register --heartbeat-only --agent-id <id>");
		}
		operation = "heartbeat";
	} else if (updateOnly) {
		if (!agentId) {
			fail(
				"Usage: maestro a2a register --update-only --agent-id <id> --url <base-url>",
			);
		}
		const updated = await updateAgentWithPlatform({
			workspaceId,
			id: agentId,
			name,
			description,
			capabilities,
			surfaces,
			surfaceTypes,
			a2a,
		});
		if (!updated) {
			fail(agentRegistryNotConfiguredMessage());
		}
		operation = "updated";
		agent = updated.agent;
	} else {
		try {
			const registered = await registerAgentWithPlatform({
				workspaceId,
				id: agentId,
				name,
				description,
				agentType: stringFlag(parsed, "--type") ?? "maestro",
				capabilities,
				surfaces,
				surfaceTypes,
				ownerId: stringFlag(parsed, "--owner-id"),
				a2a,
			});
			if (!registered) {
				fail(agentRegistryNotConfiguredMessage());
			}
			agent = registered.agent;
		} catch (error) {
			if (!agentId || !isAgentAlreadyExistsError(error)) {
				throw error;
			}
			const updated = await updateAgentWithPlatform({
				workspaceId,
				id: agentId,
				name,
				description,
				capabilities,
				surfaces,
				surfaceTypes,
				a2a,
			});
			if (!updated) {
				fail(agentRegistryNotConfiguredMessage());
			}
			operation = "updated";
			agent = updated.agent;
		}
	}

	const resolvedAgentId =
		agent?.id ?? agentId ?? fail("Agent Registry did not return an agent id.");
	const heartbeat = shouldHeartbeat
		? await heartbeatAgentWithPlatform({
				workspaceId,
				agentId: resolvedAgentId,
				status: stringFlag(parsed, "--status") ?? PlatformAgentStatusValue.Idle,
				surface: surfaces[0],
				surfaceType: surfaceTypes[0],
				a2a,
			})
		: null;
	if (shouldHeartbeat && !heartbeat) {
		fail(agentRegistryNotConfiguredMessage());
	}

	if (booleanFlag(parsed, "--json")) {
		console.log(
			JSON.stringify(
				{
					operation,
					agentId: resolvedAgentId,
					agent,
					heartbeat,
					a2a,
				},
				null,
				2,
			),
		);
		return;
	}

	const verb = operation === "registered" ? "Registered" : "Updated";
	console.log(
		operation === "heartbeat"
			? `Sent Platform A2A heartbeat for ${chalk.bold(resolvedAgentId)}${a2a ? ` at ${a2a.publicEndpointUrl}` : ""}`
			: `${verb} Platform A2A peer ${chalk.bold(resolvedAgentId)} at ${
					a2a?.publicEndpointUrl ?? publicEndpointUrl
				}`,
	);
	console.log(
		chalk.dim(
			`Skills: ${a2a?.skills?.map((skill) => skill.id).join(", ") ?? "none"}`,
		),
	);
	if (heartbeat?.nextHeartbeatBy) {
		console.log(chalk.dim(`Next heartbeat by: ${heartbeat.nextHeartbeatBy}`));
	}
}

async function importDiscoveredA2APeers(
	parsed: ParsedA2AArgs,
	candidates: PlatformAgentRegistryA2APeerCandidate[],
): Promise<
	Array<{
		name: string;
		path: string;
		url: string;
		agentId?: string;
	}>
> {
	const registryPath = stringFlag(parsed, "--registry");
	const registry = await loadA2APeerRegistry({ path: registryPath });
	const now = new Date().toISOString();
	const makeDefault = booleanFlag(parsed, "--default");
	let defaultAssigned = false;
	const importedNames = new Set<string>();
	const imported: Array<{
		name: string;
		path: string;
		url: string;
		agentId?: string;
	}> = [];
	candidates.forEach((candidate, index) => {
		const name = uniqueDiscoveredPeerName({
			baseName: discoveredPeerName(candidate, index),
			candidate,
			importedNames,
			peers: registry.peers,
		});
		const previous = registry.peers[name];
		const entry: A2APeerRegistryEntry = {
			...previous,
			url: candidate.endpointUrl,
			displayName: candidate.agent.name ?? previous?.displayName,
			agentCardUrl: candidate.agentCardUrl ?? previous?.agentCardUrl,
			protocolBinding: candidate.protocolBinding ?? previous?.protocolBinding,
			protocolVersion: candidate.protocolVersion ?? previous?.protocolVersion,
			workspaceId: candidate.agent.workspaceId ?? previous?.workspaceId,
			agentId: candidate.agent.id ?? previous?.agentId,
			capabilities: {
				...previous?.capabilities,
				...(candidate.pushNotifications === undefined
					? {}
					: { pushNotifications: candidate.pushNotifications }),
			},
			skills:
				candidate.skills.length > 0
					? candidate.skills.map((skill) => ({
							id: skill.id,
							name: skill.name ?? skill.id,
							...(skill.description ? { description: skill.description } : {}),
							...(skill.tags ? { tags: skill.tags } : {}),
							...(skill.inputModes ? { inputModes: skill.inputModes } : {}),
							...(skill.outputModes ? { outputModes: skill.outputModes } : {}),
							...(skill.requiredContextGrants
								? { requiredContextGrants: skill.requiredContextGrants }
								: {}),
							...(skill.approvalPolicyRef
								? { approvalPolicyRef: skill.approvalPolicyRef }
								: {}),
							...(skill.maxAutonomy ? { maxAutonomy: skill.maxAutonomy } : {}),
							...(skill.requiredArtifactKinds
								? { requiredArtifactKinds: skill.requiredArtifactKinds }
								: {}),
							...(skill.optionalArtifactKinds
								? { optionalArtifactKinds: skill.optionalArtifactKinds }
								: {}),
							...(skill.allowedTaskClasses
								? { allowedTaskClasses: skill.allowedTaskClasses }
								: {}),
							...(skill.deniedTaskClasses
								? { deniedTaskClasses: skill.deniedTaskClasses }
								: {}),
							...(skill.attributes ? { attributes: skill.attributes } : {}),
							...(skill.metadata ? { metadata: skill.metadata } : {}),
						}))
					: previous?.skills,
			metadata: compactA2APeerMetadata({
				...previous?.metadata,
				source: "platform-agent-registry",
				platformAgentId: candidate.agent.id,
				platformAgentType: candidate.agent.agentType,
				platformAgentStatus: candidate.agent.status,
				selectedEndpoint: candidate.endpointKind,
				a2aPushNotifications: candidate.pushNotifications,
			}),
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
		};
		registry.peers[name] = entry;
		if ((makeDefault || !registry.defaultPeer) && !defaultAssigned) {
			registry.defaultPeer = name;
			defaultAssigned = true;
		}
		imported.push({
			name,
			path: "",
			url: entry.url,
			...(entry.agentId ? { agentId: entry.agentId } : {}),
		});
	});
	return saveA2APeerRegistry(registry, { path: registryPath }).then((path) =>
		imported.map((entry) => ({ ...entry, path })),
	);
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
	const discover = booleanFlag(parsed, "--discover");
	const peerName = discover
		? undefined
		: (parsed.positionals.shift() ??
			fail("Usage: maestro a2a delegate <peer> <text>"));
	const text = parsed.positionals.join(" ").trim();
	if (!text) {
		fail(
			discover
				? "Usage: maestro a2a delegate --discover --skill <skill-id> <text>"
				: "Usage: maestro a2a delegate <peer> <text>",
		);
	}
	const peer = discover
		? await resolveDiscoveredA2ADelegatePeer(parsed)
		: await resolveA2APeer(peerName, {
				path: stringFlag(parsed, "--registry"),
				timeoutMs: numberFlag(parsed, "--timeout-ms"),
			});
	const wait = booleanFlag(parsed, "--wait");
	const role = stringFlag(parsed, "--role");
	const cwd = stringFlag(parsed, "--cwd") ?? process.cwd();
	const messageId = `maestro-a2a-message-${randomUUID()}`;
	const contextId = `maestro-a2a-context-${randomUUID()}`;
	const skillId = stringFlag(parsed, "--skill");
	const skill = selectA2APeerSkill(peer.entry.skills, skillId);
	const delegationMetadata = buildA2ADelegationMetadata({
		peerName: peer.name,
		role,
		cwd,
		skillId,
		skill,
		discoverySource: discover ? "platform-agent-registry" : undefined,
	});
	const ledgerMetadata = buildA2ADelegationLedgerMetadata({
		peerName: peer.name,
		role,
		cwd,
		skillId,
		discoverySource: discover ? "platform-agent-registry" : undefined,
	});
	const sent = await sendA2AMessage(peer.config, {
		message: buildA2AUserMessage({
			messageId,
			contextId,
			text,
			metadata: delegationMetadata,
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
			metadata: ledgerMetadata,
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

async function handleA2AControl(parsed: ParsedA2AArgs): Promise<void> {
	const delegationId =
		stringFlag(parsed, "--delegation-id") ??
		parsed.positionals.shift() ??
		fail("Usage: maestro a2a control <delegation-id> --mode <mode> [message]");
	const mode = normalizeA2AControlMode(
		stringFlag(parsed, "--mode") ??
			parsed.positionals.shift() ??
			fail("Provide --mode steer|followup|collect|interrupt|cancel"),
	);
	const message =
		stringFlag(parsed, "--message") ?? parsed.positionals.join(" ").trim();
	const result = await controlA2ADelegationTaskWithPlatform({
		delegationId,
		mode,
		message: message || undefined,
		idempotencyKey: stringFlag(parsed, "--idempotency-key"),
		targetRunId: stringFlag(parsed, "--target-run-id"),
		childRunId: stringFlag(parsed, "--child-run-id"),
		subagentLaneId: stringFlag(parsed, "--subagent-lane-id"),
		workItemId: stringFlag(parsed, "--work-item-id"),
		workspaceId: stringFlag(parsed, "--workspace-id"),
		metadata: {
			source: "maestro-cli",
			requestedAt: new Date().toISOString(),
		},
	});
	if (!result) {
		fail(agentRegistryNotConfiguredMessage());
	}
	console.log(
		`Control ${chalk.bold(result.remoteTask?.controlId ?? "(queued)")}: ${
			result.remoteTask?.state ?? "submitted"
		}`,
	);
	if (result.remoteTask?.taskId) {
		console.log(chalk.dim(`Task: ${result.remoteTask.taskId}`));
	}
	if (result.delegation?.id) {
		console.log(chalk.dim(`Delegation: ${result.delegation.id}`));
	}
}

async function handleA2AGraph(parsed: ParsedA2AArgs): Promise<void> {
	const delegationId =
		stringFlag(parsed, "--delegation-id") ?? parsed.positionals.shift();
	const rootDelegationId =
		stringFlag(parsed, "--root-delegation-id") ?? stringFlag(parsed, "--root");
	if (!delegationId && !rootDelegationId) {
		fail(
			"Usage: maestro a2a graph <delegation-id> [--root <root-delegation-id>] [--json]",
		);
	}
	const result = await getA2ADelegationGraphWithPlatform({
		workspaceId: stringFlag(parsed, "--workspace-id"),
		delegationId,
		rootDelegationId,
		maxDepth: nonNegativeNumberFlag(parsed, "--max-depth"),
		limit: nonNegativeNumberFlag(parsed, "--limit"),
	});
	if (!result) {
		fail(agentRegistryNotConfiguredMessage());
	}
	if (booleanFlag(parsed, "--json")) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(
		`Platform A2A delegation graph ${
			result.rootDelegationId ? chalk.dim(result.rootDelegationId) : ""
		}`.trim(),
	);
	const summary = [
		result.total !== undefined ? `total=${result.total}` : undefined,
		result.truncated !== undefined
			? `truncated=${result.truncated}`
			: undefined,
		result.missingParentDelegationIds?.length
			? `missing_parents=${result.missingParentDelegationIds.length}`
			: undefined,
	]
		.filter(Boolean)
		.join(" ");
	if (summary) {
		console.log(chalk.dim(`  ${summary}`));
	}
	if (result.nodes.length === 0) {
		console.log(chalk.dim("  No delegation graph nodes returned."));
		return;
	}
	for (const node of result.nodes) {
		const delegation = node.delegation;
		const label =
			delegation?.id ??
			(node.depth !== undefined ? `depth-${node.depth}` : "delegation");
		console.log(
			`${chalk.bold(label)} ${chalk.dim(
				[
					node.depth !== undefined ? `depth=${node.depth}` : undefined,
					delegation?.status,
					node.terminal ? "terminal" : undefined,
					node.childCount !== undefined
						? `children=${node.childCount}`
						: undefined,
				]
					.filter(Boolean)
					.join(" "),
			)}`,
		);
		const lineage = delegation?.a2aDelegationChain?.join(" -> ");
		const taskId = delegation?.a2aTaskId;
		if (taskId || lineage) {
			console.log(
				chalk.dim(
					`  ${[
						taskId ? `task=${taskId}` : undefined,
						lineage ? `lineage=${lineage}` : undefined,
					]
						.filter(Boolean)
						.join(" ")}`,
				),
			);
		}
	}
	if (result.edges.length > 0) {
		console.log(chalk.dim(`  edges=${result.edges.length}`));
	}
}

async function resolveDiscoveredA2ADelegatePeer(
	parsed: ParsedA2AArgs,
): Promise<Awaited<ReturnType<typeof resolveA2APeer>>> {
	const skillId = stringFlag(parsed, "--skill");
	if (!skillId) {
		fail("Usage: maestro a2a delegate --discover --skill <skill-id> <text>");
	}
	const candidates = await listA2APeerCandidatesWithPlatform({
		workspaceId: stringFlag(parsed, "--workspace-id"),
		capability: stringFlag(parsed, "--capability"),
		surface: stringFlag(parsed, "--surface") ?? "a2a",
		status: stringFlag(parsed, "--status") ?? PlatformAgentStatusValue.Idle,
		limit: numberFlag(parsed, "--limit") ?? 10,
		offset: nonNegativeNumberFlag(parsed, "--offset"),
		skillId,
		preferInternalEndpoint: booleanFlag(parsed, "--prefer-internal"),
	});
	if (!candidates) {
		fail(
			"Agent Registry service is not configured. Set AGENT_REGISTRY_SERVICE_URL, AGENT_REGISTRY_SERVICE_TOKEN, AGENT_REGISTRY_ORGANIZATION_ID, and AGENT_REGISTRY_WORKSPACE_ID.",
		);
	}
	if (candidates.length === 0) {
		fail(`No Platform A2A peers advertise skill ${skillId}.`);
	}
	const selected = selectA2ACapabilityPeer(candidates, {
		skillId,
		preferInternalEndpoint: booleanFlag(parsed, "--prefer-internal"),
	});
	const candidate = selected?.candidate;
	if (!candidate || !selected) {
		fail(`No Platform A2A peers advertise skill ${skillId}.`);
	}
	const imported = await importDiscoveredA2APeers(parsed, [candidate]);
	const importedPeer = imported[0];
	if (!importedPeer) {
		fail(`Could not import Platform A2A peer for skill ${skillId}.`);
	}
	console.log(
		chalk.dim(
			`Selected Platform A2A peer ${importedPeer.name} (${importedPeer.url}) for ${skillId}`,
		),
	);
	console.log(
		chalk.dim(
			`Capability score: ${selected.score} (${selected.reasons.join(", ")})`,
		),
	);
	return resolveA2APeer(importedPeer.name, {
		path: stringFlag(parsed, "--registry"),
		timeoutMs: numberFlag(parsed, "--timeout-ms"),
	});
}

function selectA2APeerSkill(
	skills: A2APeerRegistryEntry["skills"] | undefined,
	skillId: string | undefined,
): NonNullable<A2APeerRegistryEntry["skills"]>[number] | undefined {
	if (!skillId) {
		return undefined;
	}
	return skills?.find((skill) => skill.id === skillId);
}

function buildA2ADelegationMetadata(input: {
	peerName: string;
	role?: string;
	cwd?: string;
	skillId?: string;
	skill?: NonNullable<A2APeerRegistryEntry["skills"]>[number];
	discoverySource?: string;
}): Record<string, unknown> {
	const skill = input.skill;
	const subagentRequestMetadataPath = a2ASkillRequestMetadataPath(skill);
	const subagentRequest = input.skillId
		? {
				skillId: input.skillId,
				...(skill?.name ? { skillName: skill.name } : {}),
				...(skill?.description ? { description: skill.description } : {}),
				...(input.role ? { role: input.role } : {}),
				...(input.cwd ? { cwd: input.cwd } : {}),
				...(skill?.requiredContextGrants
					? { requiredContextGrants: skill.requiredContextGrants }
					: {}),
				...(skill?.approvalPolicyRef
					? { approvalPolicyRef: skill.approvalPolicyRef }
					: {}),
				...(skill?.maxAutonomy ? { maxAutonomy: skill.maxAutonomy } : {}),
				...(skill?.requiredArtifactKinds
					? { requiredArtifactKinds: skill.requiredArtifactKinds }
					: {}),
				...(skill?.optionalArtifactKinds
					? { optionalArtifactKinds: skill.optionalArtifactKinds }
					: {}),
				...(skill?.allowedTaskClasses
					? { allowedTaskClasses: skill.allowedTaskClasses }
					: {}),
				...(skill?.deniedTaskClasses
					? { deniedTaskClasses: skill.deniedTaskClasses }
					: {}),
				...(skill?.attributes ? { attributes: skill.attributes } : {}),
				...(skill?.metadata ? { metadata: skill.metadata } : {}),
			}
		: undefined;
	return {
		requestKind: "maestro-peer-delegation",
		relayPeer: input.peerName,
		...(input.role ? { delegationRole: input.role } : {}),
		...(input.cwd ? { delegationCwd: input.cwd } : {}),
		...(input.discoverySource
			? { discoverySource: input.discoverySource }
			: {}),
		...(input.skillId ? { a2aSkillId: input.skillId } : {}),
		...(subagentRequest
			? { [subagentRequestMetadataPath]: subagentRequest }
			: {}),
	};
}

function a2ASkillRequestMetadataPath(
	skill: NonNullable<A2APeerRegistryEntry["skills"]>[number] | undefined,
): string {
	return (
		stringMetadataValue(skill?.metadata, "requestMetadataPath") ??
		stringMetadataValue(skill?.metadata, "request_metadata_path") ??
		stringMetadataValue(skill?.attributes, "requestMetadataPath") ??
		stringMetadataValue(skill?.attributes, "request_metadata_path") ??
		"evalops.subagentRequest"
	);
}

function stringMetadataValue(
	record: Record<string, string | number | boolean> | undefined,
	key: string,
): string | undefined {
	const value = record?.[key];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function buildA2ADelegationLedgerMetadata(input: {
	peerName: string;
	role?: string;
	cwd?: string;
	skillId?: string;
	discoverySource?: string;
}): Record<string, string | number | boolean> | undefined {
	return compactA2APeerMetadata({
		requestKind: "maestro-peer-delegation",
		relayPeer: input.peerName,
		delegationRole: input.role,
		delegationCwd: input.cwd,
		discoverySource: input.discoverySource,
		a2aSkillId: input.skillId,
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

function discoveredPeerJson(candidate: PlatformAgentRegistryA2APeerCandidate): {
	agentId?: string;
	name?: string;
	status?: string;
	endpointUrl: string;
	endpointKind?: "public" | "internal";
	agentCardUrl?: string;
	protocolBinding?: string;
	protocolVersion?: string;
	skills: PlatformAgentRegistryA2APeerCandidate["skills"];
	supportedExtensions?: string[];
	pushNotifications?: boolean;
} {
	return {
		...(candidate.agent.id ? { agentId: candidate.agent.id } : {}),
		...(candidate.agent.name ? { name: candidate.agent.name } : {}),
		...(candidate.agent.status ? { status: candidate.agent.status } : {}),
		endpointUrl: candidate.endpointUrl,
		...(candidate.endpointKind ? { endpointKind: candidate.endpointKind } : {}),
		...(candidate.agentCardUrl ? { agentCardUrl: candidate.agentCardUrl } : {}),
		...(candidate.protocolBinding
			? { protocolBinding: candidate.protocolBinding }
			: {}),
		...(candidate.protocolVersion
			? { protocolVersion: candidate.protocolVersion }
			: {}),
		skills: candidate.skills,
		...(candidate.supportedExtensions
			? { supportedExtensions: candidate.supportedExtensions }
			: {}),
		...(candidate.pushNotifications === undefined
			? {}
			: { pushNotifications: candidate.pushNotifications }),
	};
}

function discoveredPeerName(
	candidate: PlatformAgentRegistryA2APeerCandidate,
	index: number,
): string {
	const raw =
		candidate.agent.id ??
		candidate.agent.name ??
		`platform-a2a-peer-${index + 1}`;
	const sanitized =
		raw
			.trim()
			.replace(/[^A-Za-z0-9_.-]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 80) || `platform-a2a-peer-${index + 1}`;
	return normalizePeerName(sanitized);
}

function uniqueDiscoveredPeerName(input: {
	baseName: string;
	candidate: PlatformAgentRegistryA2APeerCandidate;
	importedNames: Set<string>;
	peers: Record<string, A2APeerRegistryEntry>;
}): string {
	for (let suffix = 1; suffix <= 100; suffix++) {
		const name =
			suffix === 1 ? input.baseName : suffixedPeerName(input.baseName, suffix);
		const existing = input.peers[name];
		const hasSameAgentId = Boolean(
			existing?.agentId &&
				input.candidate.agent.id &&
				existing.agentId === input.candidate.agent.id,
		);
		const hasSameEndpoint = existing?.url === input.candidate.endpointUrl;
		if (
			!input.importedNames.has(name) &&
			(!existing || hasSameAgentId || hasSameEndpoint)
		) {
			input.importedNames.add(name);
			return name;
		}
	}
	throw new Error(
		`Could not derive a unique A2A peer name for ${input.baseName}`,
	);
}

function suffixedPeerName(baseName: string, suffix: number): string {
	const suffixText = `-${suffix}`;
	return normalizePeerName(
		`${baseName.slice(0, 80 - suffixText.length)}${suffixText}`,
	);
}

function compactA2APeerMetadata(
	record: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> | undefined {
	const entries = Object.entries(record).filter(
		(entry): entry is [string, string | number | boolean] =>
			entry[1] !== undefined,
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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

function stringListFlag(
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

function nonNegativeNumberFlag(
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

function agentRegistryNotConfiguredMessage(): string {
	return "Agent Registry service is not configured. Set AGENT_REGISTRY_SERVICE_URL, AGENT_REGISTRY_SERVICE_TOKEN, AGENT_REGISTRY_ORGANIZATION_ID, and AGENT_REGISTRY_WORKSPACE_ID, or pass --workspace-id with shared EvalOps credentials.";
}

function normalizeA2AControlMode(
	value: string,
): PlatformA2ADelegationTaskControlModeValue {
	switch (value.toLowerCase()) {
		case "steer":
			return PlatformA2ADelegationTaskControlModeValue.Steer;
		case "followup":
		case "follow-up":
			return PlatformA2ADelegationTaskControlModeValue.Followup;
		case "collect":
			return PlatformA2ADelegationTaskControlModeValue.Collect;
		case "interrupt":
			return PlatformA2ADelegationTaskControlModeValue.Interrupt;
		case "cancel":
			return PlatformA2ADelegationTaskControlModeValue.Cancel;
		default:
			throw new Error(`Unsupported A2A control mode: ${value}`);
	}
}

function printA2AHelp(): void {
	console.log(`Usage:
  maestro a2a offer --url <base-url> [--name <display-name>] [--peer-id <id>]
  maestro a2a accept <pairing-code> [--name <peer>] [--default] [--token-env ENV]
  maestro a2a peers
  maestro a2a discover [--capability <capability>] [--skill <skill-id>] [--import]
  maestro a2a register --url <base-url> [--agent-id <id>] [--workspace-id <id>] [--json]
  maestro a2a fleet [--json]
  maestro a2a card <peer>
  maestro a2a coordinate [peer] [--reply <text>] [--wait] [--json] [--work-graph]
  maestro a2a delegate <peer> <text> [--role <role>] [--cwd <path>] [--wait] [--work-graph]
  maestro a2a delegate --discover --skill <skill-id> <text> [--capability <capability>] [--prefer-internal]
  maestro a2a control <delegation-id> --mode steer|followup|collect|interrupt|cancel [--workspace-id <id>] [message]
  maestro a2a graph <delegation-id> [--workspace-id <id>] [--json]
  maestro a2a reply <peer> <task-id> <text> [--wait] [--work-graph]
  maestro a2a send <peer> <text> [--wait] [--work-graph]
  maestro a2a tasks [peer] [--json] [--refresh] [--work-graph]
  maestro a2a wait <peer> <task-id> [--work-graph]

Pairing codes carry Agent Card and transport coordinates only. Configure auth with
--token-env or --token-file when accepting a peer; bearer tokens are never embedded.`);
}
