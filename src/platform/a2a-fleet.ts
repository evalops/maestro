import { type A2AAgentCard, discoverA2AAgentCard } from "./a2a-client.js";
import {
	type A2APeerRegistryEntry,
	listA2APeers,
	resolveA2APeer,
} from "./a2a-peer-registry.js";
import {
	type A2ATaskLedgerEntry,
	getA2ATaskLedgerPath,
	latestA2ATaskForPeer,
	loadA2ATaskLedger,
} from "./a2a-task-ledger.js";

export interface A2AFleetOptions {
	registryPath?: string;
	tasksPath?: string;
	timeoutMs?: number;
}

export interface A2AFleetSummary {
	generatedAt: string;
	registryPath: string;
	tasksPath: string;
	peers: A2AFleetPeerSummary[];
}

export interface A2AFleetPeerSummary {
	name: string;
	displayName?: string;
	url: string;
	agentCardUrl?: string;
	status: "online" | "unreachable";
	error?: string;
	auth?: string;
	protocolBinding?: string;
	protocolVersion?: string;
	provider?: A2AAgentCard["provider"];
	capabilities?: A2AAgentCard["capabilities"];
	skills?: A2AAgentCard["skills"];
	model?: string;
	cwd?: string;
	lastTask?: A2AFleetTaskSummary;
}

export interface A2AFleetTaskSummary {
	id: string;
	ledgerId: string;
	state: string;
	text: string;
	responseText?: string;
	updatedAt: string;
}

export async function inspectA2AFleet(
	options: A2AFleetOptions = {},
): Promise<A2AFleetSummary> {
	const [{ path: registryPath, registry }, ledger] = await Promise.all([
		listA2APeers({ path: options.registryPath }),
		loadA2ATaskLedger({ path: options.tasksPath }),
	]);
	const peers = await Promise.all(
		Object.entries(registry.peers)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(async ([name, entry]) =>
				inspectPeer(name, entry, latestA2ATaskForPeer(ledger, name), options),
			),
	);
	return {
		generatedAt: new Date().toISOString(),
		registryPath,
		tasksPath: getA2ATaskLedgerPath(options.tasksPath),
		peers,
	};
}

function fleetTaskSummary(
	entry: A2ATaskLedgerEntry | undefined,
): A2AFleetTaskSummary | undefined {
	if (!entry) {
		return undefined;
	}
	return {
		id: entry.taskId,
		ledgerId: entry.id,
		state: entry.state,
		text: entry.text,
		...(entry.responseText ? { responseText: entry.responseText } : {}),
		updatedAt: entry.updatedAt,
	};
}

async function inspectPeer(
	name: string,
	entry: A2APeerRegistryEntry,
	lastTask: A2ATaskLedgerEntry | undefined,
	options: A2AFleetOptions,
): Promise<A2AFleetPeerSummary> {
	const base = basePeerSummary(name, entry, lastTask);
	try {
		const peer = await resolveA2APeer(name, {
			path: options.registryPath,
			timeoutMs: options.timeoutMs,
		});
		const card = await discoverA2AAgentCard(peer.config);
		return {
			...base,
			status: "online",
			displayName: card.name || base.displayName,
			provider: card.provider,
			capabilities: card.capabilities,
			skills: card.skills,
			protocolBinding:
				card.supportedInterfaces[0]?.protocolBinding ?? base.protocolBinding,
			protocolVersion:
				card.supportedInterfaces[0]?.protocolVersion ?? base.protocolVersion,
		};
	} catch (error) {
		return {
			...base,
			status: "unreachable",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function basePeerSummary(
	name: string,
	entry: A2APeerRegistryEntry,
	lastTask: A2ATaskLedgerEntry | undefined,
): A2AFleetPeerSummary {
	return {
		name,
		...(entry.displayName ? { displayName: entry.displayName } : {}),
		url: entry.url,
		...(entry.agentCardUrl ? { agentCardUrl: entry.agentCardUrl } : {}),
		status: "unreachable",
		...(entry.tokenEnv
			? { auth: `env:${entry.tokenEnv}` }
			: entry.tokenFile
				? { auth: "file" }
				: {}),
		...(entry.protocolBinding
			? { protocolBinding: entry.protocolBinding }
			: {}),
		...(entry.protocolVersion
			? { protocolVersion: entry.protocolVersion }
			: {}),
		...(stringMetadata(entry, "model")
			? { model: stringMetadata(entry, "model") }
			: {}),
		...(stringMetadata(entry, "cwd")
			? { cwd: stringMetadata(entry, "cwd") }
			: {}),
		...(lastTask ? { lastTask: fleetTaskSummary(lastTask) } : {}),
	};
}

function stringMetadata(
	entry: A2APeerRegistryEntry,
	key: string,
): string | undefined {
	const value = entry.metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
