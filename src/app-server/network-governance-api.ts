import { randomUUID } from "node:crypto";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";
import type {
	MaestroAppServerNetworkAuditListResult,
	MaestroAppServerNetworkAuditRecord,
	MaestroAppServerNetworkFetchResult,
	MaestroAppServerNetworkGovernanceStatus,
} from "@evalops/contracts";
import { type EnterprisePolicy, loadPolicy } from "../safety/policy.js";
import { checkNetworkRestrictionsDetailed } from "../safety/validators/network-policy-validator.js";

type UnknownRecord = Record<string, unknown>;
interface NetworkFetchBinding {
	originalHost?: string;
	resolvedAddress?: string;
	resolvedAddresses?: string[];
}
type FetchLike = (
	input: string,
	init?: RequestInit,
	binding?: NetworkFetchBinding,
) => Promise<Response>;

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_AUDIT_RECORDS = 100;
const DEFAULT_PINNED_ADDRESS_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const IDEMPOTENT_HTTP_METHODS = new Set([
	"GET",
	"HEAD",
	"OPTIONS",
	"TRACE",
	"PUT",
	"DELETE",
]);

export class MaestroAppServerNetworkGovernanceError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerNetworkGovernanceError";
	}
}

export interface MaestroAppServerNetworkGovernanceOptions {
	fetchImpl?: FetchLike;
	maxResponseBytes?: number;
	maxAuditRecords?: number;
	pinnedAddressTimeoutMs?: number;
}

export interface MaestroAppServerNetworkGovernance {
	fetch(params?: UnknownRecord): Promise<MaestroAppServerNetworkFetchResult>;
	listAudit(
		params?: UnknownRecord,
	): Promise<MaestroAppServerNetworkAuditListResult>;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_PAGE_LIMIT;
	}
	return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(value)));
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.trunc(value));
}

function readOptionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new MaestroAppServerNetworkGovernanceError(
			-32602,
			`Invalid ${field}`,
		);
	}
	return value;
}

function requireUrl(params: UnknownRecord): URL {
	const rawUrl = readOptionalString(params.url, "url");
	if (!rawUrl) {
		throw new MaestroAppServerNetworkGovernanceError(-32602, "Missing url");
	}
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new MaestroAppServerNetworkGovernanceError(-32602, "Invalid url");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new MaestroAppServerNetworkGovernanceError(
			-32602,
			"Only http and https URLs are supported",
		);
	}
	return parsed;
}

function normalizeMethod(value: unknown): string {
	const method = readOptionalString(value, "method") ?? "GET";
	const normalized = method.trim().toUpperCase();
	if (!/^[A-Z]+$/.test(normalized)) {
		throw new MaestroAppServerNetworkGovernanceError(-32602, "Invalid method");
	}
	return normalized;
}

function isIdempotentMethod(method: string | undefined): boolean {
	return IDEMPOTENT_HTTP_METHODS.has((method ?? "GET").trim().toUpperCase());
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new MaestroAppServerNetworkGovernanceError(-32602, "Invalid headers");
	}
	const headers: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value)) {
		if (typeof headerValue !== "string") {
			throw new MaestroAppServerNetworkGovernanceError(
				-32602,
				"Invalid headers",
			);
		}
		headers[key] = headerValue;
	}
	return headers;
}

function normalizeBody(value: unknown): Uint8Array | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new MaestroAppServerNetworkGovernanceError(
			-32602,
			"Invalid bodyBase64",
		);
	}
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	) {
		throw new MaestroAppServerNetworkGovernanceError(
			-32602,
			"bodyBase64 must be valid base64",
		);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) {
		throw new MaestroAppServerNetworkGovernanceError(
			-32602,
			"bodyBase64 must be canonical base64",
		);
	}
	return decoded;
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		const normalizedKey = key.toLowerCase();
		const existing = record[normalizedKey];
		record[normalizedKey] =
			existing === undefined ? value : `${existing}\n${value}`;
	}
	return record;
}

function nowIso(): string {
	return new Date().toISOString();
}

function redactAuditUrl(url: URL): string {
	const redacted = new URL(url.toString());
	redacted.username = "";
	redacted.password = "";
	return redacted.toString();
}

function urlWithoutCredentials(url: URL): URL {
	const credentialless = new URL(url.toString());
	credentialless.username = "";
	credentialless.password = "";
	return credentialless;
}

function decodeUrlCredential(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function applyUrlCredentials(url: URL, headers: Headers): void {
	if ((!url.username && !url.password) || headers.has("authorization")) {
		return;
	}
	const credentials = `${decodeUrlCredential(url.username)}:${decodeUrlCredential(
		url.password,
	)}`;
	headers.set(
		"authorization",
		`Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
	);
}

function createAuditRecord(input: {
	method: string;
	url: URL;
	allowed: boolean;
	status: MaestroAppServerNetworkGovernanceStatus;
	startedAt: string;
	reason?: string;
	statusCode?: number;
}): MaestroAppServerNetworkAuditRecord {
	return {
		id: randomUUID(),
		method: input.method,
		url: redactAuditUrl(input.url),
		host: input.url.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
		allowed: input.allowed,
		status: input.status,
		...(input.reason ? { reason: input.reason } : {}),
		...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
		startedAt: input.startedAt,
		completedAt: nowIso(),
	};
}

function cloneAuditRecord(
	record: MaestroAppServerNetworkAuditRecord,
): MaestroAppServerNetworkAuditRecord {
	return { ...record };
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		record[key] = value;
	}
	return record;
}

function responseHeadersFromNode(
	headers: Record<string, string | string[] | undefined>,
): Headers {
	const responseHeaders = new Headers();
	for (const [key, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) {
				responseHeaders.append(key, entry);
			}
		} else if (value !== undefined) {
			responseHeaders.set(key, value);
		}
	}
	return responseHeaders;
}

export async function fetchWithPinnedAddress(
	input: string,
	init: RequestInit | undefined,
	binding: NetworkFetchBinding = {},
	pinnedAddressTimeoutMs = DEFAULT_PINNED_ADDRESS_TIMEOUT_MS,
): Promise<Response> {
	const resolvedAddresses =
		binding.resolvedAddresses && binding.resolvedAddresses.length > 0
			? binding.resolvedAddresses
			: binding.resolvedAddress
				? [binding.resolvedAddress]
				: [];
	if (resolvedAddresses.length === 0) {
		const url = new URL(input);
		if (!url.username && !url.password) {
			return globalThis.fetch(input, init);
		}
		const requestHeaders = new Headers(init?.headers);
		applyUrlCredentials(url, requestHeaders);
		return globalThis.fetch(urlWithoutCredentials(url).toString(), {
			...init,
			headers: requestHeaders,
		});
	}
	const addressesToTry = isIdempotentMethod(init?.method)
		? resolvedAddresses
		: resolvedAddresses.slice(0, 1);
	let lastError: unknown;
	for (const resolvedAddress of addressesToTry) {
		try {
			return await fetchWithSinglePinnedAddress(
				input,
				init,
				{
					...binding,
					resolvedAddress,
				},
				pinnedAddressTimeoutMs,
			);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Network request failed");
}

async function fetchWithSinglePinnedAddress(
	input: string,
	init: RequestInit | undefined,
	binding: Required<Pick<NetworkFetchBinding, "resolvedAddress">> &
		NetworkFetchBinding,
	pinnedAddressTimeoutMs: number,
): Promise<Response> {
	const url = new URL(input);
	const requestHeaders = new Headers(init?.headers);
	applyUrlCredentials(url, requestHeaders);
	requestHeaders.set("host", url.host);
	const transport = url.protocol === "https:" ? requestHttps : requestHttp;
	const method = init?.method ?? "GET";

	return new Promise<Response>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const signal = init?.signal;
		const timeoutMessage = `Pinned network request to ${binding.resolvedAddress} timed out after ${pinnedAddressTimeoutMs}ms`;
		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			if (signal && abortListener) {
				signal.removeEventListener("abort", abortListener);
				abortListener = undefined;
			}
		};
		const finishResolve = (response: Response) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(response);
		};
		const finishReject = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(error);
		};
		const request = transport(
			{
				hostname: binding.resolvedAddress,
				method,
				path: `${url.pathname}${url.search}`,
				port: url.port ? Number(url.port) : undefined,
				headers: headersToRecord(requestHeaders),
				...(url.protocol === "https:"
					? { servername: binding.originalHost ?? url.hostname }
					: {}),
			},
			(response) => {
				finishResolve(
					new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
						status: response.statusCode ?? 500,
						statusText: response.statusMessage,
						headers: responseHeadersFromNode(response.headers),
					}),
				);
			},
		);
		request.on("error", finishReject);
		request.setTimeout(pinnedAddressTimeoutMs, () => {
			request.destroy(new Error(timeoutMessage));
		});
		timeout = setTimeout(() => {
			request.destroy(new Error(timeoutMessage));
		}, pinnedAddressTimeoutMs);
		timeout.unref?.();
		if (signal) {
			if (signal.aborted) {
				const error = new Error("Request aborted");
				request.destroy(error);
				finishReject(error);
				return;
			}
			abortListener = () => {
				const error = new Error("Request aborted");
				request.destroy(error);
				finishReject(error);
			};
			signal.addEventListener("abort", abortListener, { once: true });
		}
		const body = init?.body;
		if (body !== undefined && body !== null) {
			if (
				typeof body === "string" ||
				body instanceof Uint8Array ||
				body instanceof ArrayBuffer
			) {
				request.write(body instanceof ArrayBuffer ? Buffer.from(body) : body);
			} else {
				const error = new Error("Unsupported request body");
				request.destroy(error);
				finishReject(error);
				return;
			}
		}
		request.end();
	});
}

async function readResponseBytes(
	response: Response,
	maxResponseBytes: number,
): Promise<Buffer> {
	if (!response.body) {
		return Buffer.from(await response.arrayBuffer());
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maxResponseBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error(
					`Response body exceeds ${maxResponseBytes} byte network proxy limit`,
				);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, totalBytes);
}

async function evaluateNetworkPolicy(url: URL): Promise<{
	allowed: boolean;
	reason?: string;
	originalHost?: string;
	resolvedAddress?: string;
	resolvedAddresses?: string[];
}> {
	let policy: EnterprisePolicy | null;
	try {
		policy = loadPolicy();
	} catch (error) {
		return {
			allowed: false,
			reason: `Failed to load managed policy: ${error instanceof Error ? error.message : "unknown error"}`,
		};
	}
	if (!policy?.network) {
		return { allowed: true };
	}
	const check = await checkNetworkRestrictionsDetailed(
		url.toString(),
		policy.network,
	);
	return {
		allowed: check.allowed,
		...(check.reason ? { reason: check.reason } : {}),
		...(check.normalizedHost ? { originalHost: check.normalizedHost } : {}),
		...(check.resolvedIPs[0] ? { resolvedAddress: check.resolvedIPs[0] } : {}),
		...(check.resolvedIPs.length > 0
			? { resolvedAddresses: [...check.resolvedIPs] }
			: {}),
	};
}

export function createMaestroAppServerNetworkGovernance(
	options: MaestroAppServerNetworkGovernanceOptions = {},
): MaestroAppServerNetworkGovernance {
	const pinnedAddressTimeoutMs = normalizePositiveInteger(
		options.pinnedAddressTimeoutMs,
		DEFAULT_PINNED_ADDRESS_TIMEOUT_MS,
	);
	const fetchImpl =
		options.fetchImpl ??
		((input, init, binding) =>
			fetchWithPinnedAddress(input, init, binding, pinnedAddressTimeoutMs));
	const maxResponseBytes = normalizePositiveInteger(
		options.maxResponseBytes,
		DEFAULT_MAX_RESPONSE_BYTES,
	);
	const maxAuditRecords = normalizePositiveInteger(
		options.maxAuditRecords,
		DEFAULT_MAX_AUDIT_RECORDS,
	);
	const audit: MaestroAppServerNetworkAuditRecord[] = [];

	function recordAudit(record: MaestroAppServerNetworkAuditRecord): void {
		audit.push(record);
		if (audit.length > maxAuditRecords) {
			audit.splice(0, audit.length - maxAuditRecords);
		}
	}

	return {
		async fetch(params = {}) {
			if (!isRecord(params)) {
				throw new MaestroAppServerNetworkGovernanceError(
					-32602,
					"Invalid params",
				);
			}
			const url = requireUrl(params);
			const method = normalizeMethod(params.method);
			const headers = normalizeHeaders(params.headers);
			const body = normalizeBody(params.bodyBase64);
			const startedAt = nowIso();

			const policyCheck = await evaluateNetworkPolicy(url);
			if (!policyCheck.allowed) {
				const auditRecord = createAuditRecord({
					method,
					url,
					allowed: false,
					status: "blocked",
					reason: policyCheck.reason,
					startedAt,
				});
				recordAudit(auditRecord);
				return {
					allowed: false,
					status: "blocked",
					...(policyCheck.reason ? { reason: policyCheck.reason } : {}),
					audit: cloneAuditRecord(auditRecord),
				};
			}

			try {
				const response = await fetchImpl(
					url.toString(),
					{
						method,
						redirect: "manual",
						...(headers ? { headers } : {}),
						...(body ? { body } : {}),
					},
					{
						originalHost: policyCheck.originalHost,
						resolvedAddress: policyCheck.resolvedAddress,
						resolvedAddresses: policyCheck.resolvedAddresses,
					},
				);
				const bytes = await readResponseBytes(response, maxResponseBytes);
				const auditRecord = createAuditRecord({
					method,
					url,
					allowed: true,
					status: "allowed",
					statusCode: response.status,
					startedAt,
				});
				recordAudit(auditRecord);
				return {
					allowed: true,
					status: "allowed",
					statusCode: response.status,
					headers: responseHeadersToRecord(response.headers),
					bodyBase64: bytes.toString("base64"),
					audit: cloneAuditRecord(auditRecord),
				};
			} catch (error) {
				const reason =
					error instanceof Error ? error.message : "Network request failed";
				const auditRecord = createAuditRecord({
					method,
					url,
					allowed: true,
					status: "failed",
					reason,
					startedAt,
				});
				recordAudit(auditRecord);
				return {
					allowed: true,
					status: "failed",
					reason,
					audit: cloneAuditRecord(auditRecord),
				};
			}
		},

		async listAudit(params = {}) {
			if (!isRecord(params)) {
				throw new MaestroAppServerNetworkGovernanceError(
					-32602,
					"Invalid params",
				);
			}
			const limit = normalizeLimit(params.limit);
			return {
				audit: audit.slice(-limit).map(cloneAuditRecord),
				nextCursor: null,
			};
		},
	};
}
