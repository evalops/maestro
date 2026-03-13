import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { askUserTool } from "../../../src/tools/ask-user.js";
import { backgroundTasksTool } from "../../../src/tools/background/tool-handler.js";
import { codesearchTool } from "../../../src/tools/codesearch.js";
import { extractDocumentTool } from "../../../src/tools/extract-document.js";
import { findTool } from "../../../src/tools/find.js";
import { handleTools } from "../../../src/server/handlers/tools.js";
import { notebookEditTool } from "../../../src/tools/notebook.js";
import { parallelRipgrepTool } from "../../../src/tools/parallel-ripgrep.js";
import { statusTool } from "../../../src/tools/status.js";
import { codingTools, toolRegistry } from "../../../src/tools/index.js";
import { webfetchTool } from "../../../src/tools/webfetch.js";
import { websearchTool } from "../../../src/tools/websearch.js";
import {
	createEvalResult,
	type EvalSuiteResult,
	type EvalSuiteSummary,
	summarizeEvalResults,
} from "../shared";

export type ToolSurfaceEvalKind =
	| "registry"
	| "apiTools"
	| "find"
	| "extractDocument"
	| "parallelRipgrep"
	| "backgroundTasks"
	| "notebookEdit"
	| "askUser"
	| "status"
	| "websearchMissingKey"
	| "codesearchMissingKey"
	| "webfetchMissingKey";

export interface ToolSurfaceEvalCase {
	name: string;
	kind: ToolSurfaceEvalKind;
	judgeRubric?: string;
	expected: unknown;
}

export type ToolSurfaceEvalResult = EvalSuiteResult<ToolSurfaceEvalCase>;

const DEFAULT_CASES_PATH = "evals/tools/surface-smoke-cases.json";
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

export function getToolSurfaceEvalCasesPath(): string {
	return process.env.TOOL_SURFACE_EVAL_CASES?.trim() || DEFAULT_CASES_PATH;
}

export function loadToolSurfaceEvalCases(
	casesPath = getToolSurfaceEvalCasesPath(),
): ToolSurfaceEvalCase[] {
	const fixturePath = resolve(process.cwd(), casesPath);
	const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as ToolSurfaceEvalCase[];
	return Array.isArray(parsed) ? parsed : [];
}

export async function runToolSurfaceEvalCase(
	testCase: ToolSurfaceEvalCase,
): Promise<ToolSurfaceEvalResult> {
	const actual = await evaluateToolSurfaceCaseOutput(testCase);
	return createEvalResult(testCase, actual, testCase.expected);
}

export async function runToolSurfaceEvalSuite(
	cases: ToolSurfaceEvalCase[],
): Promise<ToolSurfaceEvalResult[]> {
	const results: ToolSurfaceEvalResult[] = [];
	for (const testCase of cases) {
		results.push(await runToolSurfaceEvalCase(testCase));
	}
	return results;
}

export function summarizeToolSurfaceEvalResults(
	results: ToolSurfaceEvalResult[],
): EvalSuiteSummary {
	return summarizeEvalResults(results);
}

export async function evaluateToolSurfaceCaseOutput(
	testCase: ToolSurfaceEvalCase,
): Promise<unknown> {
	switch (testCase.kind) {
		case "registry":
			return {
				codingToolNames: codingTools.map((tool) => tool.name),
				registryNames: Object.keys(toolRegistry).sort(),
			};

		case "apiTools":
			return await evaluateApiToolsCase();

		case "find":
			return await evaluateFindCase();

		case "extractDocument":
			return await evaluateExtractDocumentCase();

		case "parallelRipgrep":
			return await evaluateParallelRipgrepCase();

		case "backgroundTasks":
			return await evaluateBackgroundTasksCase();

		case "notebookEdit":
			return await evaluateNotebookEditCase();

		case "askUser":
			return await evaluateAskUserCase();

		case "status":
			return await evaluateStatusCase();

		case "websearchMissingKey":
			return await evaluateMissingExaKeyCase("websearch");

		case "codesearchMissingKey":
			return await evaluateMissingExaKeyCase("codesearch");

		case "webfetchMissingKey":
			return await evaluateMissingExaKeyCase("webfetch");

		default: {
			const neverKind: never = testCase.kind;
			throw new Error(`Unsupported tool surface eval kind: ${neverKind}`);
		}
	}
}

async function evaluateApiToolsCase(): Promise<unknown> {
	const req = new PassThrough() as MockPassThrough;
	req.method = "GET";
	req.url = "/api/tools?action=list";
	req.headers = { host: "localhost" };

	const res = makeRes();
	await handleTools(
		req as unknown as IncomingMessage,
		res as unknown as ServerResponse,
		corsHeaders,
	);

	const payload = JSON.parse(res.body) as {
		tools: Array<{ name: string; category: string }>;
		byCategory: { coding: number };
		total: number;
	};

	return {
		codingCount: payload.byCategory.coding,
		codingNames: payload.tools
			.filter((tool) => tool.category === "coding")
			.map((tool) => tool.name)
			.sort(),
		total: payload.total,
	};
}

async function evaluateFindCase(): Promise<unknown> {
	const dir = await mkdtemp(join(tmpdir(), "composer-tool-find-"));
	try {
		await writeFile(join(dir, "alpha.ts"), "export const alpha = 1;\n", "utf8");
		await mkdir(join(dir, "nested"), { recursive: true });
		await writeFile(join(dir, "nested", "beta.ts"), "export const beta = 2;\n", "utf8");

		const result = await findTool.execute("tool-surface-find", {
			pattern: "**/*.ts",
			path: dir,
			limit: 10,
		});

		return {
			matches: getToolTextOutput(result)
				.split(/\r?\n/)
				.filter(Boolean)
				.sort(),
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function evaluateExtractDocumentCase(): Promise<unknown> {
	const server = createServer((_, res) => {
		res.statusCode = 200;
		res.setHeader("content-type", "text/plain; charset=utf-8");
		res.setHeader("content-disposition", 'attachment; filename="fixture.txt"');
		res.end("Composer extract document smoke test\n");
	});

	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});

	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Failed to resolve extract document smoke server address");
		}

		const result = await extractDocumentTool.execute(
			"tool-surface-extract-document",
			{
				url: `http://127.0.0.1:${address.port}/fixture.txt`,
			},
		);

		return {
			text: getToolTextOutput(result).trim(),
			format: (result.details as { format?: string } | undefined)?.format,
			fileName: (result.details as { fileName?: string } | undefined)?.fileName,
		};
	} finally {
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

async function evaluateParallelRipgrepCase(): Promise<unknown> {
	const dir = await mkdtemp(join(tmpdir(), "composer-tool-rg-"));
	try {
		await writeFile(join(dir, "alpha.ts"), "const alpha = 1;\nconst beta = 2;\n", "utf8");
		await writeFile(join(dir, "gamma.ts"), "const gamma = alpha + beta;\n", "utf8");

		const result = await parallelRipgrepTool.execute(
			"tool-surface-parallel-rg",
			{
				patterns: ["alpha", "beta"],
				cwd: dir,
				paths: ["."],
				headLimit: 10,
			},
		);

		const details = (result.details as {
			rangeCount?: number;
			ranges?: Array<{ file: string; patterns: string[] }>;
		}) ?? { ranges: [] };

		return {
			rangeCount: details.rangeCount ?? 0,
			files: (details.ranges ?? [])
				.map((range) => range.file.replace(/^\.\//, ""))
				.sort(),
			patterns: Array.from(
				new Set((details.ranges ?? []).flatMap((range) => range.patterns)),
			).sort(),
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function evaluateBackgroundTasksCase(): Promise<unknown> {
	let taskId: string | undefined;
	try {
		const start = await backgroundTasksTool.execute(
			"tool-surface-background-start",
			{
				action: "start",
				command:
					"node -e \"console.log('ready'); setInterval(() => console.log('keepalive'), 50)\"",
				shell: true,
			},
		);
		const startDetails = start.details as { id?: string } | undefined;
		taskId = startDetails?.id;
		if (!taskId) {
			throw new Error("Background task smoke eval did not return a task id");
		}

		const { listed, logsText } = await waitForBackgroundTaskReady(taskId);
		const stop = await backgroundTasksTool.execute(
			"tool-surface-background-stop",
			{ action: "stop", taskId },
		);

		return {
			started: !start.isError,
			listed,
			logsContainReady:
				logsText.includes("ready") || logsText.includes("keepalive"),
			stopped: getToolTextOutput(stop).includes(taskId),
		};
	} finally {
		if (taskId) {
			try {
				await backgroundTasksTool.execute("tool-surface-background-cleanup", {
					action: "stop",
					taskId,
				});
			} catch {
				// Ignore cleanup failures for already-stopped tasks.
			}
		}
	}
}

async function waitForBackgroundTaskReady(
	taskId: string,
	timeoutMs = 2000,
): Promise<{ listed: boolean; logsText: string }> {
	const deadline = Date.now() + timeoutMs;
	let listed = false;
	let logsText = "";

	while (Date.now() < deadline) {
		const list = await backgroundTasksTool.execute(
			"tool-surface-background-list",
			{ action: "list" },
		);
		listed ||= getToolTextOutput(list).includes(taskId);

		const logs = await backgroundTasksTool.execute(
			"tool-surface-background-logs",
			{ action: "logs", taskId, lines: 20 },
		);
		logsText = getToolTextOutput(logs);
		if (listed && (logsText.includes("ready") || logsText.includes("keepalive"))) {
			return { listed, logsText };
		}

		await sleep(100);
	}

	return { listed, logsText };
}

async function evaluateNotebookEditCase(): Promise<unknown> {
	const dir = await mkdtemp(join(tmpdir(), "composer-tool-notebook-"));
	const notebookPath = join(dir, "fixture.ipynb");
	try {
		await notebookEditTool.execute("tool-surface-notebook-create", {
			path: notebookPath,
			new_source: "print('hello')",
			cell_type: "code",
			edit_mode: "insert",
		});

		await notebookEditTool.execute("tool-surface-notebook-replace", {
			path: notebookPath,
			cell_index: 0,
			new_source: "## Updated",
			cell_type: "markdown",
			edit_mode: "replace",
		});

		const notebook = JSON.parse(await readFile(notebookPath, "utf8")) as {
			cells: Array<{ cell_type: string; source: string[] }>;
		};

		return {
			totalCells: notebook.cells.length,
			cellType: notebook.cells[0]?.cell_type,
			source: notebook.cells[0]?.source?.join("").trim(),
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function evaluateAskUserCase(): Promise<unknown> {
	const result = await askUserTool.execute("tool-surface-ask-user", {
		questions: [
			{
				header: "Mode",
				question: "Which mode should we use?",
				options: [
					{ label: "Prompt", description: "Ask before running risky actions" },
					{ label: "Auto", description: "Approve everything automatically" },
				],
			},
		],
	});

	const details = result.details as {
		questions?: Array<unknown>;
		status?: string;
	} | undefined;

	return {
		status: details?.status,
		questionCount: details?.questions?.length ?? 0,
		textIncludesQuestion: getToolTextOutput(result).includes(
			"Which mode should we use?",
		),
	};
}

async function evaluateStatusCase(): Promise<unknown> {
	const dir = await mkdtemp(join(tmpdir(), "composer-tool-status-"));
	try {
		const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
		if (init.status !== 0) {
			throw new Error(init.stderr || init.stdout || "git init failed");
		}
		await writeFile(join(dir, "status.txt"), "status smoke\n", "utf8");

		const originalCwd = process.cwd();
		try {
			process.chdir(dir);
			const result = await statusTool.execute("tool-surface-status", {
				branchSummary: true,
			});
			const details = result.details as {
				status?: { files?: unknown[]; branch?: { head?: string | null } };
			} | undefined;

			return {
				fileCount: details?.status?.files?.length ?? 0,
				branchPresent: Boolean(details?.status?.branch?.head),
				textIncludesFiles: getToolTextOutput(result).includes("Files: 1"),
			};
		} finally {
			process.chdir(originalCwd);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function evaluateMissingExaKeyCase(
	kind: "websearch" | "codesearch" | "webfetch",
): Promise<unknown> {
	return await withExaKeyUnset(async () => {
		try {
			if (kind === "websearch") {
				await websearchTool.execute("tool-surface-websearch-missing-key", {
					query: "Composer tooling",
				});
			} else if (kind === "codesearch") {
				await codesearchTool.execute("tool-surface-codesearch-missing-key", {
					query: "Composer api client",
				});
			} else {
				await webfetchTool.execute("tool-surface-webfetch-missing-key", {
					urls: "https://example.com",
				});
			}

			return { error: null };
		} catch (error) {
			return {
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
}

function getToolTextOutput(result: {
	content?: Array<{ type: string; text?: string }>;
}): string {
	return (result.content ?? [])
		.filter((block): block is { type: string; text: string } => {
			return block.type === "text" && typeof block.text === "string";
		})
		.map((block) => block.text)
		.join("\n");
}

async function withExaKeyUnset<T>(callback: () => Promise<T>): Promise<T> {
	const previous = process.env.EXA_API_KEY;
	delete process.env.EXA_API_KEY;
	try {
		return await callback();
	} finally {
		if (previous === undefined) {
			delete process.env.EXA_API_KEY;
		} else {
			process.env.EXA_API_KEY = previous;
		}
	}
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

async function sleep(ms: number): Promise<void> {
	await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
