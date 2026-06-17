import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";

const DEFAULT_PINNED_ADDRESS_TIMEOUT_MS = 30_000;
const IDEMPOTENT_HTTP_METHODS = new Set([
	"GET",
	"HEAD",
	"OPTIONS",
	"TRACE",
	"PUT",
	"DELETE",
]);

export interface PinnedFetchBinding {
	originalHost?: string;
	resolvedAddress?: string;
	resolvedAddresses?: string[];
}

function isIdempotentMethod(method: string | undefined): boolean {
	return IDEMPOTENT_HTTP_METHODS.has((method ?? "GET").trim().toUpperCase());
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

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

export async function fetchWithPinnedAddress(
	input: string,
	init: RequestInit | undefined,
	binding: PinnedFetchBinding = {},
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
	binding: Required<Pick<PinnedFetchBinding, "resolvedAddress">> &
		PinnedFetchBinding,
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
		let responseBody: Readable | undefined;
		const signal = init?.signal;
		const timeoutMessage = `Pinned network request to ${binding.resolvedAddress} timed out after ${pinnedAddressTimeoutMs}ms`;
		const cleanupTimeout = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
		};
		const cleanupAbortListener = () => {
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
			cleanupTimeout();
			resolve(response);
		};
		const finishReject = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanupTimeout();
			cleanupAbortListener();
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
				responseBody = response;
				response.once("close", cleanupAbortListener);
				response.once("end", cleanupAbortListener);
				response.once("error", cleanupAbortListener);
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
				const error = createAbortError();
				request.destroy(error);
				finishReject(error);
				return;
			}
			abortListener = () => {
				const error = createAbortError();
				responseBody?.destroy(error);
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
