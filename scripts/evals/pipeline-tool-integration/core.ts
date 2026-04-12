import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import {
	pipelineCreateSignalTool,
	pipelineLogActivityTool,
	pipelineSearchContactsTool,
	pipelineSearchDealsTool,
} from "../../../src/tools/pipeline.js";
import type { AgentToolResult } from "../../../src/agent/types.js";
import {
	createEvalResult,
	type EvalSuiteResult,
	type EvalSuiteSummary,
	summarizeEvalResults,
} from "../shared";

export type PipelineToolEvalKind =
	| "searchContacts"
	| "searchDeals"
	| "createSignal"
	| "logActivity";

export interface PipelineToolEvalCase {
	name: string;
	kind: PipelineToolEvalKind;
	params: Record<string, unknown>;
	response: {
		status?: number;
		body: unknown;
	};
	expected: unknown;
	judgeRubric?: string;
}

export interface PipelineToolEvalActual {
	request: {
		method: string;
		path: string;
		authorization?: string;
		contentType?: string;
		hasIdempotencyKey: boolean;
		body: unknown;
	};
	result: {
		text: string;
		details: unknown;
	};
}

export type PipelineToolEvalResult = EvalSuiteResult<
	PipelineToolEvalCase,
	PipelineToolEvalActual
>;

const DEFAULT_CASES_PATH = "evals/tools/pipeline-integration-cases.json";
const DEFAULT_PIPELINE_TOKEN = "pipeline-eval-token";

export function getPipelineToolEvalCasesPath(): string {
	return process.env.PIPELINE_TOOL_EVAL_CASES?.trim() || DEFAULT_CASES_PATH;
}

export function loadPipelineToolEvalCases(
	casesPath = getPipelineToolEvalCasesPath(),
): PipelineToolEvalCase[] {
	const fixturePath = resolve(process.cwd(), casesPath);
	const parsed = JSON.parse(
		readFileSync(fixturePath, "utf8"),
	) as PipelineToolEvalCase[];
	return Array.isArray(parsed) ? parsed : [];
}

export async function runPipelineToolEvalCase(
	testCase: PipelineToolEvalCase,
): Promise<PipelineToolEvalResult> {
	const actual = await evaluatePipelineToolCaseOutput(testCase);
	return createEvalResult(testCase, actual, testCase.expected);
}

export async function runPipelineToolEvalSuite(
	cases: PipelineToolEvalCase[],
): Promise<PipelineToolEvalResult[]> {
	const results: PipelineToolEvalResult[] = [];
	for (const testCase of cases) {
		results.push(await runPipelineToolEvalCase(testCase));
	}
	return results;
}

export function summarizePipelineToolEvalResults(
	results: PipelineToolEvalResult[],
): EvalSuiteSummary {
	return summarizeEvalResults(results);
}

export async function evaluatePipelineToolCaseOutput(
	testCase: PipelineToolEvalCase,
): Promise<PipelineToolEvalActual> {
	const originalEnv = process.env;
	const requestCapture: {
		method: string;
		path: string;
		authorization?: string;
		contentType?: string;
		hasIdempotencyKey: boolean;
		body: unknown;
	} = {
		method: "",
		path: "",
		authorization: undefined,
		contentType: undefined,
		hasIdempotencyKey: false,
		body: null,
	};

	const server = createServer(async (req, res) => {
		requestCapture.method = req.method ?? "";
		requestCapture.path = req.url ?? "";
		requestCapture.authorization = req.headers.authorization;
		requestCapture.contentType = req.headers["content-type"];
		requestCapture.hasIdempotencyKey = Boolean(req.headers["idempotency-key"]);
		requestCapture.body = await readJsonBody(req);

		res.statusCode = testCase.response.status ?? 200;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.end(JSON.stringify(testCase.response.body));
	});

	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});

	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Failed to resolve Pipeline integration eval server address");
		}

		process.env = {
			...originalEnv,
			PIPELINE_API_URL: `http://127.0.0.1:${address.port}`,
			PIPELINE_SERVICE_TOKEN: DEFAULT_PIPELINE_TOKEN,
		};

		const result = await executePipelineTool(testCase);
		return {
			request: requestCapture,
			result: {
				text: getToolTextOutput(result),
				details: result.details,
			},
		};
	} finally {
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
	}
}

async function executePipelineTool(
	testCase: PipelineToolEvalCase,
): Promise<AgentToolResult<unknown>> {
	switch (testCase.kind) {
		case "searchContacts":
			return pipelineSearchContactsTool.execute(
				"pipeline-tool-eval",
				testCase.params,
			);
		case "searchDeals":
			return pipelineSearchDealsTool.execute(
				"pipeline-tool-eval",
				testCase.params,
			);
		case "createSignal":
			return pipelineCreateSignalTool.execute(
				"pipeline-tool-eval",
				testCase.params,
			);
		case "logActivity":
			return pipelineLogActivityTool.execute(
				"pipeline-tool-eval",
				testCase.params,
			);
		default: {
			const neverKind: never = testCase.kind;
			throw new Error(`Unsupported pipeline tool eval kind: ${neverKind}`);
		}
	}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	return text ? JSON.parse(text) : null;
}

function getToolTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter(
				(
					content,
				): content is {
					type: "text";
					text: string;
				} => content?.type === "text",
			)
			.map((content) => content.text)
			.join("\n") || ""
	);
}
