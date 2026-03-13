import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ApprovalMode } from "../../../src/agent/action-approval.js";
import type { WebServerContext } from "../../../src/server/app-context.js";
import {
	resetApprovalModeStore,
	resolveApprovalModeForRequest,
	setApprovalModeForSession,
} from "../../../src/server/approval-mode-store.js";
import { handleApprovals } from "../../../src/server/handlers/approvals.js";
import {
	createEvalResult,
	type EvalSuiteResult,
	type EvalSuiteSummary,
	summarizeEvalResults,
} from "../shared";

export type ApprovalFlowEvalKind = "status" | "update" | "resolve";

export interface ApprovalFlowEvalCase {
	name: string;
	kind: ApprovalFlowEvalKind;
	judgeRubric?: string;
	defaultApprovalMode: ApprovalMode;
	sessionId?: string;
	querySessionId?: string;
	storedMode?: ApprovalMode;
	headerApprovalMode?: ApprovalMode;
	body?: {
		mode: ApprovalMode;
		sessionId?: string;
	};
	expected: unknown;
}

export type ApprovalFlowEvalResult = EvalSuiteResult<ApprovalFlowEvalCase>;

const DEFAULT_CASES_PATH = "evals/approvals/flow-cases.json";
const corsHeaders = { "Access-Control-Allow-Origin": "*" };

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writableEnded: boolean;
	on: () => void;
	off: () => void;
	writeHead(status: number, headers?: Record<string, string>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

export function getApprovalFlowEvalCasesPath(): string {
	return process.env.APPROVAL_FLOW_EVAL_CASES?.trim() || DEFAULT_CASES_PATH;
}

export function loadApprovalFlowEvalCases(
	casesPath = getApprovalFlowEvalCasesPath(),
): ApprovalFlowEvalCase[] {
	const fixturePath = resolve(process.cwd(), casesPath);
	const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as ApprovalFlowEvalCase[];
	return Array.isArray(parsed) ? parsed : [];
}

export async function runApprovalFlowEvalCase(
	testCase: ApprovalFlowEvalCase,
): Promise<ApprovalFlowEvalResult> {
	const actual = await evaluateApprovalFlowCaseOutput(testCase);
	return createEvalResult(testCase, actual, testCase.expected);
}

export async function runApprovalFlowEvalSuite(
	cases: ApprovalFlowEvalCase[],
): Promise<ApprovalFlowEvalResult[]> {
	return await Promise.all(cases.map((testCase) => runApprovalFlowEvalCase(testCase)));
}

export function summarizeApprovalFlowEvalResults(
	results: ApprovalFlowEvalResult[],
): EvalSuiteSummary {
	return summarizeEvalResults(results);
}

export async function evaluateApprovalFlowCaseOutput(
	testCase: ApprovalFlowEvalCase,
): Promise<unknown> {
	resetApprovalModeStore();

	const seededSessionId =
		testCase.sessionId ?? testCase.querySessionId ?? testCase.body?.sessionId;
	if (testCase.storedMode && seededSessionId) {
		setApprovalModeForSession(seededSessionId, testCase.storedMode);
	}

	switch (testCase.kind) {
		case "status":
			return await runStatusCase(testCase);

		case "update":
			return await runUpdateCase(testCase);

		case "resolve":
			return {
				effectiveApproval: resolveApprovalModeForRequest({
					sessionId: testCase.sessionId,
					headerApprovalMode: testCase.headerApprovalMode,
					defaultApprovalMode: testCase.defaultApprovalMode,
				}),
			};

		default: {
			const neverKind: never = testCase.kind;
			throw new Error(`Unsupported approval flow eval kind: ${neverKind}`);
		}
	}
}

async function runStatusCase(testCase: ApprovalFlowEvalCase): Promise<unknown> {
	const req = makeReq(
		"GET",
		`/api/approvals?sessionId=${encodeURIComponent(testCase.sessionId ?? "default")}`,
	);
	const res = makeRes();

	await handleApprovals(
		req as unknown as IncomingMessage,
		res as unknown as ServerResponse,
		createContext(testCase.defaultApprovalMode),
	);

	return JSON.parse(res.body);
}

async function runUpdateCase(testCase: ApprovalFlowEvalCase): Promise<unknown> {
	if (!testCase.body) {
		throw new Error(`Update eval case is missing a body: ${testCase.name}`);
	}

	const query = testCase.querySessionId
		? `?sessionId=${encodeURIComponent(testCase.querySessionId)}`
		: "";
	const req = makeReq("POST", `/api/approvals${query}`, testCase.body);
	const res = makeRes();

	await handleApprovals(
		req as unknown as IncomingMessage,
		res as unknown as ServerResponse,
		createContext(testCase.defaultApprovalMode),
	);

	const targetSessionId =
		testCase.body.sessionId ?? testCase.querySessionId ?? "default";
	const targetStatus = await fetchApprovalStatus(
		targetSessionId,
		testCase.defaultApprovalMode,
	);
	const defaultStatus = await fetchApprovalStatus(
		"default",
		testCase.defaultApprovalMode,
	);

	return {
		response: JSON.parse(res.body),
		targetStatus,
		defaultStatus,
	};
}

async function fetchApprovalStatus(
	sessionId: string,
	defaultApprovalMode: ApprovalMode,
): Promise<unknown> {
	const req = makeReq(
		"GET",
		`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`,
	);
	const res = makeRes();

	await handleApprovals(
		req as unknown as IncomingMessage,
		res as unknown as ServerResponse,
		createContext(defaultApprovalMode),
	);

	return JSON.parse(res.body);
}

function createContext(
	defaultApprovalMode: ApprovalMode,
): Pick<WebServerContext, "corsHeaders" | "defaultApprovalMode"> {
	return {
		corsHeaders,
		defaultApprovalMode,
	};
}

function makeReq(method: string, url: string, body?: unknown): MockPassThrough {
	const req = new PassThrough() as MockPassThrough;
	req.method = method;
	req.url = url;
	req.headers = { host: "localhost" };
	if (body !== undefined) {
		req.end(JSON.stringify(body));
	}
	return req;
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		on: () => {},
		off: () => {},
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers || {};
		},
		write(chunk: string | Buffer) {
			this.body += chunk.toString();
		},
		end(chunk?: string | Buffer) {
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
}
