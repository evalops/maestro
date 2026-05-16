import { createHash, timingSafeEqual } from "node:crypto";
import {
	type A2AAgentCard,
	type A2AAgentInterface,
	normalizeA2ABaseUrl,
} from "./a2a-client.js";

export const A2A_PEER_PAIRING_CODE_PREFIX = "maestro-pair-v1";

const PAIRING_CODE_VERSION = 1;
const PAIRING_CODE_CHECKSUM_LENGTH = 16;
const MAX_PAIRING_CODE_LENGTH = 8192;
const DEFAULT_PAIRING_TTL_MS = 30 * 60 * 1000;
const MAX_SKILLS_IN_PAIRING_CODE = 8;
const MAX_SKILL_TAGS_IN_PAIRING_CODE = 8;

export interface A2APeerPairingCapabilities {
	streaming?: boolean;
	pushNotifications?: boolean;
	extendedAgentCard?: boolean;
}

export interface A2APeerPairingSkillSummary {
	id: string;
	name: string;
	tags?: string[];
}

export interface A2APeerPairingProvider {
	organization?: string;
	url?: string;
}

export interface A2APeerPairingRelayHints {
	host?: string;
	port?: number;
	tailscaleName?: string;
	path?: string;
}

export interface A2APeerPairingPayload {
	version: 1;
	displayName: string;
	agentCardUrl: string;
	transportUrl: string;
	protocolBinding: string;
	protocolVersion: string;
	issuedAt: string;
	expiresAt: string;
	peerId?: string;
	provider?: A2APeerPairingProvider;
	capabilities?: A2APeerPairingCapabilities;
	skills?: A2APeerPairingSkillSummary[];
	keyFingerprint?: string;
	relayHints?: A2APeerPairingRelayHints;
	metadata?: Record<string, string | number | boolean>;
}

export interface CreateA2APeerPairingPayloadInput {
	displayName: string;
	agentCardUrl: string;
	transportUrl: string;
	protocolBinding?: string;
	protocolVersion?: string;
	issuedAt?: Date | string;
	expiresAt?: Date | string;
	ttlMs?: number;
	peerId?: string;
	provider?: A2APeerPairingProvider;
	capabilities?: A2APeerPairingCapabilities;
	skills?: A2APeerPairingSkillSummary[];
	keyFingerprint?: string;
	relayHints?: A2APeerPairingRelayHints;
	metadata?: Record<string, string | number | boolean>;
	now?: Date;
}

export interface CreateA2APeerPairingPayloadFromAgentCardInput {
	agentCard: A2AAgentCard;
	agentCardUrl: string;
	displayName?: string;
	issuedAt?: Date | string;
	expiresAt?: Date | string;
	ttlMs?: number;
	peerId?: string;
	keyFingerprint?: string;
	relayHints?: A2APeerPairingRelayHints;
	metadata?: Record<string, string | number | boolean>;
	now?: Date;
}

export interface DecodeA2APeerPairingCodeOptions {
	now?: Date;
	allowExpired?: boolean;
}

export interface A2APeerConnection {
	peerId: string;
	displayName: string;
	baseUrl: string;
	agentCardUrl: string;
	protocolBinding: string;
	protocolVersion: string;
	capabilities?: A2APeerPairingCapabilities;
	skills?: A2APeerPairingSkillSummary[];
	keyFingerprint?: string;
	metadata?: Record<string, string | number | boolean>;
}

export function createA2APeerPairingPayload(
	input: CreateA2APeerPairingPayloadInput,
): A2APeerPairingPayload {
	const issuedAt = toDate(
		input.issuedAt ?? input.now ?? new Date(),
		"issuedAt",
	);
	const expiresAt = toDate(
		input.expiresAt ??
			new Date(issuedAt.getTime() + (input.ttlMs ?? DEFAULT_PAIRING_TTL_MS)),
		"expiresAt",
	);
	const payload: A2APeerPairingPayload = {
		version: PAIRING_CODE_VERSION,
		displayName: requireNonEmptyString(input.displayName, "displayName"),
		agentCardUrl: normalizePairingUrl(input.agentCardUrl, "agentCardUrl"),
		transportUrl: normalizePairingUrl(input.transportUrl, "transportUrl"),
		protocolBinding: normalizeProtocolBinding(input.protocolBinding),
		protocolVersion: requireNonEmptyString(
			input.protocolVersion ?? "1.0",
			"protocolVersion",
		),
		issuedAt: issuedAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		...(input.peerId
			? { peerId: requireNonEmptyString(input.peerId, "peerId") }
			: {}),
		...(input.provider ? { provider: normalizeProvider(input.provider) } : {}),
		...(input.capabilities
			? { capabilities: normalizeCapabilities(input.capabilities) }
			: {}),
		...(input.skills ? { skills: normalizeSkills(input.skills) } : {}),
		...(input.keyFingerprint
			? {
					keyFingerprint: requireNonEmptyString(
						input.keyFingerprint,
						"keyFingerprint",
					),
				}
			: {}),
		...(input.relayHints
			? { relayHints: normalizeRelayHints(input.relayHints) }
			: {}),
		...(input.metadata ? { metadata: normalizeMetadata(input.metadata) } : {}),
	};
	validateA2APeerPairingPayload(payload, { now: input.now });
	return payload;
}

export function createA2APeerPairingPayloadFromAgentCard(
	input: CreateA2APeerPairingPayloadFromAgentCardInput,
): A2APeerPairingPayload {
	const selectedInterface = selectA2AAgentInterface(input.agentCard);
	return createA2APeerPairingPayload({
		displayName: input.displayName ?? input.agentCard.name,
		agentCardUrl: input.agentCardUrl,
		transportUrl: selectedInterface.url,
		protocolBinding: selectedInterface.protocolBinding,
		protocolVersion: selectedInterface.protocolVersion,
		issuedAt: input.issuedAt,
		expiresAt: input.expiresAt,
		ttlMs: input.ttlMs,
		peerId: input.peerId,
		provider: input.agentCard.provider,
		capabilities: input.agentCard.capabilities,
		skills: input.agentCard.skills.map((skill) => ({
			id: skill.id,
			name: skill.name,
			tags: skill.tags,
		})),
		keyFingerprint: input.keyFingerprint,
		relayHints: input.relayHints,
		metadata: input.metadata,
		now: input.now,
	});
}

export function encodeA2APeerPairingCode(
	payload: A2APeerPairingPayload,
): string {
	const normalized = normalizeDecodedPayload(payload, { allowExpired: true });
	rejectSecretBearingFields(normalized);
	const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString(
		"base64url",
	);
	const checksum = pairingChecksum(encoded);
	return `${A2A_PEER_PAIRING_CODE_PREFIX}.${encoded}.${checksum}`;
}

export function decodeA2APeerPairingCode(
	code: string,
	options: DecodeA2APeerPairingCodeOptions = {},
): A2APeerPairingPayload {
	const compact = code.trim();
	if (!compact) {
		throw new Error("A2A pairing code is required");
	}
	if (compact.length > MAX_PAIRING_CODE_LENGTH) {
		throw new Error("A2A pairing code is too large");
	}
	const parts = compact.split(".");
	if (
		parts.length !== 3 ||
		parts[0] !== A2A_PEER_PAIRING_CODE_PREFIX ||
		!parts[1] ||
		!parts[2]
	) {
		throw new Error(
			`A2A pairing code must use the ${A2A_PEER_PAIRING_CODE_PREFIX} format`,
		);
	}
	const [, encoded, checksum] = parts;
	assertPairingChecksum(encoded, checksum);
	let rawPayload: unknown;
	try {
		rawPayload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch (error) {
		throw new Error(
			`A2A pairing code payload is not valid JSON: ${errorMessage(error)}`,
		);
	}
	return normalizeDecodedPayload(rawPayload, options);
}

export function a2aPeerConnectionFromPairingPayload(
	payload: A2APeerPairingPayload,
): A2APeerConnection {
	validateA2APeerPairingPayload(payload, { allowExpired: true });
	return {
		peerId: payload.peerId ?? stablePeerId(payload),
		displayName: payload.displayName,
		baseUrl: payload.transportUrl.replace(/\/+$/u, ""),
		agentCardUrl: payload.agentCardUrl,
		protocolBinding: payload.protocolBinding,
		protocolVersion: payload.protocolVersion,
		...(payload.capabilities ? { capabilities: payload.capabilities } : {}),
		...(payload.skills ? { skills: payload.skills } : {}),
		...(payload.keyFingerprint
			? { keyFingerprint: payload.keyFingerprint }
			: {}),
		...(payload.metadata ? { metadata: payload.metadata } : {}),
	};
}

export function selectA2AAgentInterface(
	agentCard: A2AAgentCard,
): A2AAgentInterface {
	if (!Array.isArray(agentCard.supportedInterfaces)) {
		throw new Error("A2A Agent Card must include supportedInterfaces");
	}
	const preferred = agentCard.supportedInterfaces.find(
		(candidate) =>
			candidate.protocolBinding.trim().toUpperCase() === "HTTP+JSON",
	);
	if (!preferred) {
		throw new Error(
			"A2A Agent Card does not advertise a supported HTTP+JSON interface",
		);
	}
	return {
		url: normalizePairingUrl(preferred.url, "supportedInterfaces[].url"),
		protocolBinding: normalizeProtocolBinding(preferred.protocolBinding),
		protocolVersion: requireNonEmptyString(
			preferred.protocolVersion,
			"supportedInterfaces[].protocolVersion",
		),
		...(preferred.tenant ? { tenant: preferred.tenant } : {}),
	};
}

export function resolveA2AAgentCardUrl(input: string): string {
	const baseUrl = normalizeA2ABaseUrl(
		normalizePairingUrl(input, "agentCardUrl"),
	);
	const parsed = new URL(baseUrl);
	parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/.well-known/agent-card.json`;
	parsed.search = "";
	parsed.hash = "";
	return normalizePairingUrl(parsed.toString(), "agentCardUrl");
}

function normalizeDecodedPayload(
	input: unknown,
	options: DecodeA2APeerPairingCodeOptions = {},
): A2APeerPairingPayload {
	if (!isRecord(input)) {
		throw new Error("A2A pairing code payload must be an object");
	}
	if (input.version !== PAIRING_CODE_VERSION) {
		throw new Error(
			`Unsupported A2A pairing code version: ${String(input.version)}`,
		);
	}
	const payload: A2APeerPairingPayload = {
		version: PAIRING_CODE_VERSION,
		displayName: requireNonEmptyString(input.displayName, "displayName"),
		agentCardUrl: normalizePairingUrl(input.agentCardUrl, "agentCardUrl"),
		transportUrl: normalizePairingUrl(input.transportUrl, "transportUrl"),
		protocolBinding: normalizeProtocolBinding(input.protocolBinding),
		protocolVersion: requireNonEmptyString(
			input.protocolVersion,
			"protocolVersion",
		),
		issuedAt: toDate(input.issuedAt, "issuedAt").toISOString(),
		expiresAt: toDate(input.expiresAt, "expiresAt").toISOString(),
		...(typeof input.peerId === "string"
			? { peerId: requireNonEmptyString(input.peerId, "peerId") }
			: {}),
		...(isRecord(input.provider)
			? { provider: normalizeProvider(input.provider) }
			: {}),
		...(isRecord(input.capabilities)
			? { capabilities: normalizeCapabilities(input.capabilities) }
			: {}),
		...(Array.isArray(input.skills)
			? { skills: normalizeSkills(input.skills) }
			: {}),
		...(typeof input.keyFingerprint === "string"
			? {
					keyFingerprint: requireNonEmptyString(
						input.keyFingerprint,
						"keyFingerprint",
					),
				}
			: {}),
		...(isRecord(input.relayHints)
			? { relayHints: normalizeRelayHints(input.relayHints) }
			: {}),
		...(isRecord(input.metadata)
			? { metadata: normalizeMetadata(input.metadata) }
			: {}),
	};
	validateA2APeerPairingPayload(payload, options);
	return payload;
}

function validateA2APeerPairingPayload(
	payload: A2APeerPairingPayload,
	options: DecodeA2APeerPairingCodeOptions = {},
): void {
	rejectSecretBearingFields(payload);
	const issuedAt = toDate(payload.issuedAt, "issuedAt");
	const expiresAt = toDate(payload.expiresAt, "expiresAt");
	if (expiresAt.getTime() <= issuedAt.getTime()) {
		throw new Error("A2A pairing code expiresAt must be after issuedAt");
	}
	if (!options.allowExpired) {
		const now = options.now ?? new Date();
		if (expiresAt.getTime() <= now.getTime()) {
			throw new Error("A2A pairing code has expired");
		}
	}
}

function normalizePairingUrl(input: unknown, label: string): string {
	const raw = requireNonEmptyString(input, label);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch (error) {
		throw new Error(`${label} must be an absolute URL: ${errorMessage(error)}`);
	}
	parsed.username = "";
	parsed.password = "";
	parsed.search = "";
	parsed.hash = "";
	if (parsed.protocol === "https:") {
		return parsed.toString();
	}
	if (parsed.protocol !== "http:") {
		throw new Error(`${label} must use http or https`);
	}
	if (!isLocalPairingHost(parsed.hostname)) {
		throw new Error(
			`${label} must use https unless it targets localhost, private LAN, or Tailscale`,
		);
	}
	return parsed.toString();
}

function isLocalPairingHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
	if (
		host === "localhost" ||
		host === "::1" ||
		host.endsWith(".local") ||
		host.endsWith(".ts.net") ||
		!host.includes(".")
	) {
		return true;
	}
	const ipv4Parts = host.split(".").map((part) => Number(part));
	if (
		ipv4Parts.length === 4 &&
		ipv4Parts.every((part) => Number.isInteger(part))
	) {
		const first = ipv4Parts[0] ?? -1;
		const second = ipv4Parts[1] ?? -1;
		return (
			first === 10 ||
			first === 127 ||
			(first === 192 && second === 168) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 100 && second >= 64 && second <= 127)
		);
	}
	return (
		host.includes(":") &&
		(/^f[cd][0-9a-f]*:/u.test(host) || host.startsWith("fe80:"))
	);
}

function normalizeProtocolBinding(input: unknown): string {
	return requireNonEmptyString(input ?? "HTTP+JSON", "protocolBinding");
}

function normalizeProvider(
	input: A2APeerPairingProvider | Record<string, unknown>,
): A2APeerPairingProvider {
	return {
		...(typeof input.organization === "string" && input.organization.trim()
			? { organization: input.organization.trim() }
			: {}),
		...(typeof input.url === "string" && input.url.trim()
			? { url: normalizePairingUrl(input.url, "provider.url") }
			: {}),
	};
}

function normalizeCapabilities(
	input: A2APeerPairingCapabilities | Record<string, unknown>,
): A2APeerPairingCapabilities {
	return {
		...(typeof input.streaming === "boolean"
			? { streaming: input.streaming }
			: {}),
		...(typeof input.pushNotifications === "boolean"
			? { pushNotifications: input.pushNotifications }
			: {}),
		...(typeof input.extendedAgentCard === "boolean"
			? { extendedAgentCard: input.extendedAgentCard }
			: {}),
	};
}

function normalizeSkills(
	input: readonly unknown[],
): A2APeerPairingSkillSummary[] {
	return input.slice(0, MAX_SKILLS_IN_PAIRING_CODE).map((skill, index) => {
		if (!isRecord(skill)) {
			throw new Error(`skills[${index}] must be an object`);
		}
		const tags = Array.isArray(skill.tags)
			? skill.tags
					.filter((tag): tag is string => typeof tag === "string")
					.map((tag) => tag.trim())
					.filter(Boolean)
					.slice(0, MAX_SKILL_TAGS_IN_PAIRING_CODE)
			: undefined;
		return {
			id: requireNonEmptyString(skill.id, `skills[${index}].id`),
			name: requireNonEmptyString(skill.name, `skills[${index}].name`),
			...(tags && tags.length > 0 ? { tags } : {}),
		};
	});
}

function normalizeRelayHints(
	input: A2APeerPairingRelayHints | Record<string, unknown>,
): A2APeerPairingRelayHints {
	return {
		...(typeof input.host === "string" && input.host.trim()
			? { host: input.host.trim() }
			: {}),
		...(typeof input.port === "number" &&
		Number.isInteger(input.port) &&
		input.port > 0 &&
		input.port <= 65535
			? { port: input.port }
			: {}),
		...(typeof input.tailscaleName === "string" && input.tailscaleName.trim()
			? { tailscaleName: input.tailscaleName.trim() }
			: {}),
		...(typeof input.path === "string" && input.path.trim()
			? { path: input.path.trim() }
			: {}),
	};
}

function normalizeMetadata(
	input: Record<string, unknown>,
): Record<string, string | number | boolean> {
	const output: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(input)) {
		if (!key.trim()) {
			throw new Error("A2A pairing metadata keys must be non-empty");
		}
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			output[key.trim()] = value;
		}
	}
	return output;
}

function rejectSecretBearingFields(value: unknown, path = "$"): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			rejectSecretBearingFields(item, `${path}[${index}]`);
		}
		return;
	}
	if (!isRecord(value)) {
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		if (isSecretLikeKey(key)) {
			throw new Error(
				`A2A pairing codes must not include secret field ${path}.${key}`,
			);
		}
		rejectSecretBearingFields(child, `${path}.${key}`);
	}
}

function isSecretLikeKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[-_]/gu, "");
	return (
		normalized === "authorization" ||
		normalized === "token" ||
		normalized.endsWith("token") ||
		normalized === "secret" ||
		normalized.endsWith("secret") ||
		normalized === "password" ||
		normalized.endsWith("password") ||
		normalized === "apikey" ||
		normalized.endsWith("apikey") ||
		normalized === "credentials" ||
		normalized.endsWith("credentials") ||
		normalized === "bearer"
	);
}

function requireNonEmptyString(input: unknown, label: string): string {
	if (typeof input !== "string" || !input.trim()) {
		throw new Error(`${label} is required`);
	}
	return input.trim();
}

function toDate(input: Date | string | unknown, label: string): Date {
	const date =
		input instanceof Date
			? input
			: new Date(requireNonEmptyString(input, label));
	if (Number.isNaN(date.getTime())) {
		throw new Error(`${label} must be an ISO timestamp`);
	}
	return date;
}

function pairingChecksum(encoded: string): string {
	return createHash("sha256")
		.update(`${A2A_PEER_PAIRING_CODE_PREFIX}.${encoded}`)
		.digest("hex")
		.slice(0, PAIRING_CODE_CHECKSUM_LENGTH);
}

function assertPairingChecksum(encoded: string, checksum: string): void {
	const expected = pairingChecksum(encoded);
	if (checksum.length !== expected.length) {
		throw new Error("A2A pairing code checksum does not match");
	}
	const expectedBytes = Buffer.from(expected, "utf8");
	const actualBytes = Buffer.from(checksum, "utf8");
	if (!timingSafeEqual(expectedBytes, actualBytes)) {
		throw new Error("A2A pairing code checksum does not match");
	}
}

function stablePeerId(payload: A2APeerPairingPayload): string {
	const hash = createHash("sha256")
		.update(
			`${payload.displayName}\n${payload.agentCardUrl}\n${payload.transportUrl}`,
		)
		.digest("base64url")
		.slice(0, 16);
	return `a2a-peer-${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
