import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type A2AServiceConfig, normalizeA2ABaseUrl } from "./a2a-client.js";
import {
	type A2APeerConnection,
	type A2APeerPairingPayload,
	a2aPeerConnectionFromPairingPayload,
} from "./a2a-peer-pairing.js";
import { getEnvValue, trimString } from "./client.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_ATTEMPTS = 1;

export interface A2APeerRegistryEntry {
	url: string;
	displayName?: string;
	agentCardUrl?: string;
	protocolBinding?: string;
	protocolVersion?: string;
	tokenEnv?: string;
	tokenFile?: string;
	organizationId?: string;
	workspaceId?: string;
	agentId?: string;
	sessionId?: string;
	actorId?: string;
	timeoutMs?: number;
	maxAttempts?: number;
	capabilities?: A2APeerConnection["capabilities"];
	skills?: A2APeerConnection["skills"];
	keyFingerprint?: string;
	metadata?: Record<string, string | number | boolean>;
	createdAt?: string;
	updatedAt?: string;
}

export interface A2APeerRegistryFile {
	defaultPeer?: string;
	timeoutMs?: number;
	maxAttempts?: number;
	peers: Record<string, A2APeerRegistryEntry>;
}

export interface A2APeerRegistryOptions {
	path?: string;
	now?: Date;
}

export interface UpsertA2APeerOptions extends A2APeerRegistryOptions {
	name?: string;
	makeDefault?: boolean;
	tokenEnv?: string;
	tokenFile?: string;
	workspaceId?: string;
	organizationId?: string;
}

export interface ResolveA2APeerOptions extends A2APeerRegistryOptions {
	token?: string;
	timeoutMs?: number;
	maxAttempts?: number;
}

export interface ResolvedA2APeer {
	name: string;
	entry: A2APeerRegistryEntry;
	config: A2AServiceConfig;
}

export function getA2APeerRegistryPath(path?: string): string {
	const configured =
		trimString(path) ??
		getEnvValue(["MAESTRO_A2A_PEERS_FILE", "CODEX_A2A_PEERS_FILE"]);
	if (configured) {
		return expandHome(configured);
	}
	return join(homedir(), ".maestro", "a2a", "peers.json");
}

export async function loadA2APeerRegistry(
	options: A2APeerRegistryOptions = {},
): Promise<A2APeerRegistryFile> {
	const path = getA2APeerRegistryPath(options.path);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (hasNodeCode(error, "ENOENT")) {
			return { peers: {} };
		}
		throw error;
	}
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`A2A peer registry at ${path} must be a JSON object`);
	}
	const peers = isRecord(parsed.peers) ? parsed.peers : {};
	const registry: A2APeerRegistryFile = {
		peers: Object.fromEntries(
			Object.entries(peers).map(([name, value]) => [
				name,
				normalizeRegistryEntry(value, `peers.${name}`),
			]),
		),
	};
	if (typeof parsed.defaultPeer === "string" && parsed.defaultPeer.trim()) {
		registry.defaultPeer = parsed.defaultPeer.trim();
	}
	if (typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0) {
		registry.timeoutMs = parsed.timeoutMs;
	}
	if (typeof parsed.maxAttempts === "number" && parsed.maxAttempts > 0) {
		registry.maxAttempts = parsed.maxAttempts;
	}
	return registry;
}

export async function saveA2APeerRegistry(
	registry: A2APeerRegistryFile,
	options: A2APeerRegistryOptions = {},
): Promise<string> {
	const path = getA2APeerRegistryPath(options.path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(`${path}.tmp`, `${JSON.stringify(registry, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(`${path}.tmp`, path);
	return path;
}

export async function upsertA2APeerFromPairingPayload(
	payload: A2APeerPairingPayload,
	options: UpsertA2APeerOptions = {},
): Promise<{
	name: string;
	entry: A2APeerRegistryEntry;
	path: string;
}> {
	const registry = await loadA2APeerRegistry(options);
	const connection = a2aPeerConnectionFromPairingPayload(payload);
	const name = normalizePeerName(options.name ?? connection.peerId);
	const now = (options.now ?? new Date()).toISOString();
	const previous = registry.peers[name];
	const {
		tokenEnv: previousTokenEnv,
		tokenFile: previousTokenFile,
		...previousFields
	} = previous ?? {};
	const entry: A2APeerRegistryEntry = {
		...previousFields,
		url: connection.baseUrl,
		displayName: connection.displayName,
		agentCardUrl: connection.agentCardUrl,
		protocolBinding: connection.protocolBinding,
		protocolVersion: connection.protocolVersion,
		...resolveUpsertTokenFields({
			previousTokenEnv,
			previousTokenFile,
			tokenEnv: options.tokenEnv,
			tokenFile: options.tokenFile,
		}),
		...(options.organizationId
			? { organizationId: options.organizationId }
			: {}),
		...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
		...(connection.capabilities
			? { capabilities: connection.capabilities }
			: {}),
		...(connection.skills ? { skills: connection.skills } : {}),
		...(connection.keyFingerprint
			? { keyFingerprint: connection.keyFingerprint }
			: {}),
		...(connection.metadata ? { metadata: connection.metadata } : {}),
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
	};
	registry.peers[name] = entry;
	if (options.makeDefault || !registry.defaultPeer) {
		registry.defaultPeer = name;
	}
	const path = await saveA2APeerRegistry(registry, options);
	return { name, entry, path };
}

export async function listA2APeers(
	options: A2APeerRegistryOptions = {},
): Promise<{
	path: string;
	registry: A2APeerRegistryFile;
}> {
	return {
		path: getA2APeerRegistryPath(options.path),
		registry: await loadA2APeerRegistry(options),
	};
}

export async function resolveA2APeer(
	name: string | undefined,
	options: ResolveA2APeerOptions = {},
): Promise<ResolvedA2APeer> {
	const registry = await loadA2APeerRegistry(options);
	const resolvedName = normalizePeerName(name ?? registry.defaultPeer);
	const entry = registry.peers[resolvedName];
	if (!entry) {
		throw new Error(
			`Unknown A2A peer "${resolvedName}". Run "maestro a2a peers" to list registered peers.`,
		);
	}
	const token = options.token ?? (await resolvePeerToken(entry));
	const config: A2AServiceConfig = {
		baseUrl: normalizeA2ABaseUrl(entry.url),
		...(token ? { token } : {}),
		...(entry.organizationId ? { organizationId: entry.organizationId } : {}),
		...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
		...(entry.agentId ? { agentId: entry.agentId } : { agentId: "maestro" }),
		...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
		...(entry.actorId ? { actorId: entry.actorId } : {}),
		timeoutMs:
			options.timeoutMs ??
			entry.timeoutMs ??
			registry.timeoutMs ??
			DEFAULT_TIMEOUT_MS,
		maxAttempts:
			options.maxAttempts ??
			entry.maxAttempts ??
			registry.maxAttempts ??
			DEFAULT_MAX_ATTEMPTS,
	};
	return { name: resolvedName, entry, config };
}

export async function resolvePeerToken(
	entry: Pick<A2APeerRegistryEntry, "tokenEnv" | "tokenFile">,
): Promise<string | undefined> {
	if (entry.tokenEnv) {
		const envToken = trimString(process.env[entry.tokenEnv]);
		if (envToken) {
			return envToken;
		}
	}
	if (entry.tokenFile) {
		return trimString(await readFile(expandHome(entry.tokenFile), "utf8"));
	}
	return undefined;
}

export function normalizePeerName(name: string | undefined): string {
	const normalized = name?.trim();
	if (!normalized) {
		throw new Error("A2A peer name is required");
	}
	if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(normalized)) {
		throw new Error(
			"A2A peer names may only contain letters, numbers, dots, underscores, and dashes",
		);
	}
	return normalized;
}

function resolveUpsertTokenFields(input: {
	previousTokenEnv?: string;
	previousTokenFile?: string;
	tokenEnv?: string;
	tokenFile?: string;
}): Pick<A2APeerRegistryEntry, "tokenEnv" | "tokenFile"> {
	const tokenEnv = trimString(input.tokenEnv);
	const tokenFile = trimString(input.tokenFile);
	if (tokenEnv && tokenFile) {
		return { tokenEnv, tokenFile: expandHome(tokenFile) };
	}
	if (tokenEnv) {
		return { tokenEnv };
	}
	if (tokenFile) {
		return { tokenFile: expandHome(tokenFile) };
	}
	return {
		...(input.previousTokenEnv ? { tokenEnv: input.previousTokenEnv } : {}),
		...(input.previousTokenFile ? { tokenFile: input.previousTokenFile } : {}),
	};
}

function normalizeRegistryEntry(
	input: unknown,
	label: string,
): A2APeerRegistryEntry {
	if (!isRecord(input)) {
		throw new Error(`${label} must be an object`);
	}
	const url = typeof input.url === "string" ? input.url.trim() : "";
	if (!url) {
		throw new Error(`${label}.url is required`);
	}
	return {
		url,
		...copyString(input, "displayName"),
		...copyString(input, "agentCardUrl"),
		...copyString(input, "protocolBinding"),
		...copyString(input, "protocolVersion"),
		...copyString(input, "tokenEnv"),
		...copyString(input, "tokenFile"),
		...copyString(input, "organizationId"),
		...copyString(input, "workspaceId"),
		...copyString(input, "agentId"),
		...copyString(input, "sessionId"),
		...copyString(input, "actorId"),
		...(typeof input.timeoutMs === "number" && input.timeoutMs > 0
			? { timeoutMs: input.timeoutMs }
			: {}),
		...(typeof input.maxAttempts === "number" && input.maxAttempts > 0
			? { maxAttempts: input.maxAttempts }
			: {}),
		...(isRecord(input.capabilities)
			? {
					capabilities: {
						...(typeof input.capabilities.streaming === "boolean"
							? { streaming: input.capabilities.streaming }
							: {}),
						...(typeof input.capabilities.pushNotifications === "boolean"
							? { pushNotifications: input.capabilities.pushNotifications }
							: {}),
						...(typeof input.capabilities.extendedAgentCard === "boolean"
							? { extendedAgentCard: input.capabilities.extendedAgentCard }
							: {}),
					},
				}
			: {}),
		...(Array.isArray(input.skills)
			? { skills: normalizeRegistrySkills(input.skills) }
			: {}),
		...copyString(input, "keyFingerprint"),
		...(isRecord(input.metadata)
			? {
					metadata: input.metadata as Record<string, string | number | boolean>,
				}
			: {}),
		...copyString(input, "createdAt"),
		...copyString(input, "updatedAt"),
	};
}

function normalizeRegistrySkills(
	input: readonly unknown[],
): A2APeerConnection["skills"] {
	return input
		.filter(isRecord)
		.map((skill) => ({
			id: typeof skill.id === "string" ? skill.id : "",
			name: typeof skill.name === "string" ? skill.name : "",
			...(Array.isArray(skill.tags)
				? {
						tags: skill.tags.filter(
							(tag): tag is string => typeof tag === "string",
						),
					}
				: {}),
		}))
		.filter((skill) => skill.id.trim() && skill.name.trim());
}

function copyString(
	input: Record<string, unknown>,
	key: string,
): Record<string, string> {
	const value = input[key];
	return typeof value === "string" && value.trim()
		? { [key]: value.trim() }
		: {};
}

function expandHome(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return resolve(homedir(), path.slice(2));
	}
	return resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNodeCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}
