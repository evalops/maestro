import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	createEvalResult,
	type EvalSuiteResult,
	type EvalSuiteSummary,
	summarizeEvalResults,
} from "../shared";

type SharedMemoryClientModule = typeof import("../../../src/shared-memory/client.js");

export interface SharedMemoryEvalCase {
	name: string;
	config?: {
		apiKey?: string;
		sessionIdOverride?: string;
	};
	updates: Array<{
		sessionId: string;
		state?: Record<string, unknown>;
		event?: {
			type: string;
			payload?: unknown;
			tags?: string[];
			id?: string;
			actor?: string;
		};
	}>;
	responses: Array<{
		status?: number;
		headers?: Record<string, string>;
		body?: unknown;
	}>;
	expected: unknown;
	judgeRubric?: string;
}

export interface SharedMemoryEvalActual {
	requests: Array<{
		method: string;
		path: string;
		authorization?: string;
		contentType?: string;
		contentEncoding?: string;
		hasRequestId: boolean;
		firstEventIdPrefixMatches?: boolean;
		body: unknown;
	}>;
}

export type SharedMemoryEvalResult = EvalSuiteResult<
	SharedMemoryEvalCase,
	SharedMemoryEvalActual
>;

const DEFAULT_CASES_PATH = "evals/tools/shared-memory-integration-cases.json";
const DEFAULT_SHARED_MEMORY_TOKEN = "shared-memory-eval-token";
const REQUEST_WAIT_TIMEOUT_MS = 3_000;
const REQUEST_SETTLE_MS = 100;
let sharedMemoryClientPromise: Promise<SharedMemoryClientModule> | null = null;

export function getSharedMemoryEvalCasesPath(): string {
	return (
		process.env.SHARED_MEMORY_INTEGRATION_EVAL_CASES?.trim() ||
		DEFAULT_CASES_PATH
	);
}

export function loadSharedMemoryEvalCases(
	casesPath = getSharedMemoryEvalCasesPath(),
): SharedMemoryEvalCase[] {
	const fixturePath = resolve(process.cwd(), casesPath);
	const parsed = JSON.parse(
		readFileSync(fixturePath, "utf8"),
	) as SharedMemoryEvalCase[];
	return Array.isArray(parsed) ? parsed : [];
}

export async function runSharedMemoryEvalCase(
	testCase: SharedMemoryEvalCase,
): Promise<SharedMemoryEvalResult> {
	const actual = await evaluateSharedMemoryCaseOutput(testCase);
	return createEvalResult(testCase, actual, testCase.expected);
}

export async function runSharedMemoryEvalSuite(
	cases: SharedMemoryEvalCase[],
): Promise<SharedMemoryEvalResult[]> {
	const results: SharedMemoryEvalResult[] = [];
	for (const testCase of cases) {
		results.push(await runSharedMemoryEvalCase(testCase));
	}
	return results;
}

export function summarizeSharedMemoryEvalResults(
	results: SharedMemoryEvalResult[],
): EvalSuiteSummary {
	return summarizeEvalResults(results);
}

export async function evaluateSharedMemoryCaseOutput(
	testCase: SharedMemoryEvalCase,
): Promise<SharedMemoryEvalActual> {
	const originalEnv = process.env;
	const requests: SharedMemoryEvalActual["requests"] = [];
	const expectedRequestCount = testCase.responses.length;
	const tempHome = mkdtempSync(join(tmpdir(), "maestro-shared-memory-eval-"));
	const effectiveSessionId =
		testCase.config?.sessionIdOverride?.trim() ||
		testCase.updates[0]?.sessionId ||
		"shared-memory-eval";

	let resolveRequests!: () => void;
	const requestsSeen = new Promise<void>((resolve) => {
		resolveRequests = resolve;
	});

	const server = createServer(async (req, res) => {
		const responsePlan = testCase.responses[requests.length];
		const body = await readRequestBody(req);
		const firstEventId = extractFirstEventId(body);

		requests.push({
			method: req.method ?? "",
			path: req.url ?? "",
			authorization: normalizeHeaderValue(req.headers.authorization),
			contentType: normalizeHeaderValue(req.headers["content-type"]),
			contentEncoding: normalizeHeaderValue(req.headers["content-encoding"]),
			hasRequestId: Boolean(req.headers["x-request-id"]),
			firstEventIdPrefixMatches:
				firstEventId === undefined
					? undefined
					: firstEventId.startsWith(`maestro-${effectiveSessionId}-`),
			body,
		});

		if (requests.length >= expectedRequestCount) {
			resolveRequests();
		}

		if (!responsePlan) {
			res.statusCode = 500;
			res.setHeader("content-type", "application/json; charset=utf-8");
			res.end(JSON.stringify({ error: "unexpected request" }));
			return;
		}

		res.statusCode = responsePlan.status ?? 200;
		for (const [key, value] of Object.entries(responsePlan.headers ?? {})) {
			res.setHeader(key, value);
		}
		if (responsePlan.body !== undefined) {
			res.setHeader("content-type", "application/json; charset=utf-8");
			res.end(JSON.stringify(responsePlan.body));
			return;
		}
		res.end();
	});

	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});

	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error(
				"Failed to resolve shared-memory integration eval server address",
			);
		}

		process.env = {
			...originalEnv,
			MAESTRO_HOME: tempHome,
			MAESTRO_SHARED_MEMORY_BASE: `http://127.0.0.1:${address.port}`,
			MAESTRO_SHARED_MEMORY_API_KEY:
				testCase.config?.apiKey ?? DEFAULT_SHARED_MEMORY_TOKEN,
			MAESTRO_SHARED_MEMORY_SESSION_ID:
				testCase.config?.sessionIdOverride ?? "",
		};

		const client = await loadSharedMemoryClientModule();
		client.invalidateSharedMemoryCapabilities();

		for (const update of testCase.updates) {
			client.queueSharedMemoryUpdate(resolveUpdateTemplates(update));
		}

		await waitForRequests(requestsSeen, expectedRequestCount);
		await sleep(REQUEST_SETTLE_MS);

		return { requests };
	} finally {
		if (sharedMemoryClientPromise) {
			const client = await sharedMemoryClientPromise;
			client.invalidateSharedMemoryCapabilities();
		}
		process.env = originalEnv;
		await new Promise<void>((resolvePromise, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolvePromise();
			});
		});
		rmSync(tempHome, { recursive: true, force: true });
	}
}

async function loadSharedMemoryClientModule(): Promise<SharedMemoryClientModule> {
	if (!sharedMemoryClientPromise) {
		sharedMemoryClientPromise = import("../../../src/shared-memory/client.js");
	}
	return sharedMemoryClientPromise;
}

async function waitForRequests(
	requestsSeen: Promise<void>,
	expectedRequestCount: number,
): Promise<void> {
	if (expectedRequestCount === 0) {
		return;
	}

	await Promise.race([
		requestsSeen,
		new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(
					new Error(
						`Timed out waiting for ${expectedRequestCount} shared-memory request(s)`,
					),
				);
			}, REQUEST_WAIT_TIMEOUT_MS);
		}),
	]);
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	const bodyBuffer = Buffer.concat(chunks);
	if (!bodyBuffer.length) return null;

	const contentEncoding = normalizeHeaderValue(req.headers["content-encoding"]);
	const text =
		contentEncoding === "gzip"
			? gunzipSync(bodyBuffer).toString("utf8").trim()
			: bodyBuffer.toString("utf8").trim();
	return text ? JSON.parse(text) : null;
}

function extractFirstEventId(body: unknown): string | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return undefined;
	}
	const events = (body as { events?: unknown }).events;
	if (!Array.isArray(events) || events.length === 0) {
		return undefined;
	}
	const firstEvent = events[0];
	if (!firstEvent || typeof firstEvent !== "object" || Array.isArray(firstEvent)) {
		return undefined;
	}
	const id = (firstEvent as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}

function normalizeHeaderValue(
	value: string | string[] | undefined,
): string | undefined {
	if (Array.isArray(value)) {
		return value[0];
	}
	return typeof value === "string" ? value : undefined;
}

function resolveUpdateTemplates(
	update: SharedMemoryEvalCase["updates"][number],
): SharedMemoryEvalCase["updates"][number] {
	return {
		...update,
		state: resolveTemplateValue(update.state) as
			| Record<string, unknown>
			| undefined,
		event: update.event
			? {
					...update.event,
					payload: resolveTemplateValue(update.event.payload),
				}
			: undefined,
	};
}

function resolveTemplateValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(resolveTemplateValue);
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	if (
		"$repeat" in value &&
		typeof (value as { $repeat?: unknown }).$repeat === "string" &&
		typeof (value as { count?: unknown }).count === "number"
	) {
		const template = value as { $repeat: string; count: number };
		return template.$repeat.repeat(template.count);
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			resolveTemplateValue(entry),
		]),
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
