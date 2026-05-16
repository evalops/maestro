import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleA2ACommand } from "../../../src/cli/commands/a2a.js";

const ANSI_ESCAPE_PATTERN = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*m`,
	"gu",
);

interface RequestRecord {
	method: string | undefined;
	url: string | undefined;
	body: unknown;
}

describe("A2A fleet delegation CLI", () => {
	let server: Server;
	let baseUrl: string;
	let requests: RequestRecord[];
	let logs: string[];
	let errors: string[];

	beforeEach(async () => {
		requests = [];
		logs = [];
		errors = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.join(" "));
		});
		server = createServer(async (request, response) => {
			if (request.method === "GET" && request.url === "/healthz") {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ ok: true }));
				return;
			}
			if (
				request.method === "GET" &&
				request.url === "/.well-known/agent-card.json"
			) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						name: "Mac mini Maestro",
						description: "Always-on local build and smoke peer",
						version: "0.10.18",
						provider: {
							organization: "EvalOps",
							url: "https://evalops.dev",
						},
						capabilities: { streaming: true },
						defaultInputModes: ["text/plain"],
						defaultOutputModes: ["text/plain"],
						supportedInterfaces: [
							{
								url: `${baseUrl}/message:send`,
								protocolBinding: "HTTP+JSON",
								protocolVersion: "1.0",
							},
						],
						skills: [
							{
								id: "repo-smoke",
								name: "Repo smoke",
								description: "Run focused repository smoke tests",
								tags: ["repo", "smoke"],
							},
						],
					}),
				);
				return;
			}
			if (request.method === "POST" && request.url === "/message:send") {
				const body = await readJson(request);
				requests.push({ method: request.method, url: request.url, body });
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						task: {
							id: "task-mac-mini-1",
							contextId:
								recordValue(body, "message.contextId") ??
								"maestro-a2a-context-test",
							status: {
								state: "TASK_STATE_SUBMITTED",
							},
							history: [recordValue(body, "message")].filter(Boolean),
							metadata: {
								worker: "mac-mini",
							},
						},
					}),
				);
				return;
			}
			if (
				request.method === "GET" &&
				request.url === "/tasks/task-mac-mini-1"
			) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						id: "task-mac-mini-1",
						contextId: "maestro-a2a-context-test",
						status: {
							state: "TASK_STATE_COMPLETED",
							message: {
								messageId: "agent-message-1",
								role: "ROLE_AGENT",
								parts: [
									{
										text: "mac mini finished the smoke plan",
										mediaType: "text/plain",
									},
								],
							},
						},
						artifacts: [
							{
								artifactId: "result",
								parts: [
									{
										text: "mac mini finished the smoke plan",
										mediaType: "text/plain",
									},
								],
							},
						],
					}),
				);
				return;
			}
			response.writeHead(404, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "not found" }));
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("delegates work, records a transcript, and reports fleet health", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-fleet-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks.json");
		await writeRegistry(registryPath, baseUrl);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await handleA2ACommand([
			"delegate",
			"mac-mini",
			"run",
			"the",
			"tmux",
			"smoke",
			"--role",
			"background-worker",
			"--cwd",
			"/Users/jonathanhaas/Documents/Projects/maestro-internal",
			"--wait",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			"1000",
			"--interval-ms",
			"10",
			"--timeout-ms",
			"1000",
		]);

		expect(requests).toHaveLength(1);
		expect(recordValue(requests[0]!.body, "message.metadata")).toMatchObject({
			requestKind: "maestro-peer-delegation",
			delegationRole: "background-worker",
			delegationCwd: "/Users/jonathanhaas/Documents/Projects/maestro-internal",
			relayPeer: "mac-mini",
		});
		expect(plainLogs(logs)).toContain("Delegated to mac-mini");
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");

		const ledgerRaw = await readFile(tasksPath, "utf8");
		expect(ledgerRaw).toContain("task-mac-mini-1");
		expect(ledgerRaw).toContain("run the tmux smoke");
		expect(ledgerRaw).toContain("mac mini finished the smoke plan");
		expect(ledgerRaw).not.toContain("super-secret-token");

		logs = [];
		await handleA2ACommand([
			"fleet",
			"--json",
			"--registry",
			registryPath,
			"--tasks",
			tasksPath,
			"--timeout-ms",
			"1000",
		]);
		const fleet = JSON.parse(logs.join("\n")) as {
			peers: Array<{
				name: string;
				status: string;
				displayName?: string;
				capabilities?: { streaming?: boolean };
				lastTask?: { id: string; state: string };
			}>;
		};
		expect(fleet.peers).toEqual([
			expect.objectContaining({
				name: "mac-mini",
				status: "online",
				displayName: "Mac mini Maestro",
				capabilities: expect.objectContaining({ streaming: true }),
				lastTask: expect.objectContaining({
					id: "task-mac-mini-1",
					state: "TASK_STATE_COMPLETED",
				}),
			}),
		]);
		expect(JSON.stringify(fleet)).not.toContain("super-secret-token");

		logs = [];
		await handleA2ACommand(["tasks", "--json", "--tasks", tasksPath]);
		const taskView = JSON.parse(logs.join("\n")) as {
			tasks: Array<{ peer: string; taskId: string; state: string }>;
		};
		expect(taskView.tasks).toEqual([
			expect.objectContaining({
				peer: "mac-mini",
				taskId: "task-mac-mini-1",
				state: "TASK_STATE_COMPLETED",
			}),
		]);
		expect(errors.join("\n")).toBe("");
	});

	it("reports delegation success when local ledger persistence fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-fail-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks-as-dir");
		await writeRegistry(registryPath, baseUrl);
		await mkdir(tasksPath);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await expect(
			handleA2ACommand([
				"delegate",
				"mac-mini",
				"run",
				"the",
				"tmux",
				"smoke",
				"--wait",
				"--registry",
				registryPath,
				"--tasks",
				tasksPath,
				"--max-wait-ms",
				"1000",
				"--interval-ms",
				"10",
				"--timeout-ms",
				"1000",
			]),
		).resolves.toBeUndefined();

		expect(requests).toHaveLength(1);
		expect(plainLogs(logs)).toContain("Delegated to mac-mini");
		expect(plainLogs(logs)).toContain(
			"Task task-mac-mini-1: TASK_STATE_COMPLETED",
		);
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");
		expect(plainLogs(errors)).toContain("A2A task ledger warning");
		expect(plainLogs(errors)).not.toContain("super-secret-token");
	});

	it("reports wait completion when local ledger update fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-a2a-wait-ledger-fail-"));
		const registryPath = join(dir, "peers.json");
		const tasksPath = join(dir, "tasks-as-dir");
		await writeRegistry(registryPath, baseUrl);
		await mkdir(tasksPath);
		vi.stubEnv("MAC_MINI_A2A_TOKEN", "super-secret-token");

		await expect(
			handleA2ACommand([
				"wait",
				"mac-mini",
				"task-mac-mini-1",
				"--registry",
				registryPath,
				"--tasks",
				tasksPath,
				"--max-wait-ms",
				"1000",
				"--interval-ms",
				"10",
				"--timeout-ms",
				"1000",
			]),
		).resolves.toBeUndefined();

		expect(plainLogs(logs)).toContain(
			"Task task-mac-mini-1: TASK_STATE_COMPLETED",
		);
		expect(plainLogs(logs)).toContain("mac mini finished the smoke plan");
		expect(plainLogs(errors)).toContain("A2A task ledger warning");
		expect(plainLogs(errors)).not.toContain("super-secret-token");
	});
});

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function recordValue(input: unknown, path: string): unknown {
	let current = input;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function plainLogs(entries: string[]): string {
	return entries.join("\n").replace(ANSI_ESCAPE_PATTERN, "");
}

async function writeRegistry(path: string, baseUrl: string): Promise<void> {
	await writeFile(
		path,
		JSON.stringify({
			defaultPeer: "mac-mini",
			peers: {
				"mac-mini": {
					url: baseUrl,
					displayName: "Mac mini Maestro",
					agentCardUrl: `${baseUrl}/.well-known/agent-card.json`,
					tokenEnv: "MAC_MINI_A2A_TOKEN",
					metadata: {
						model: "opus",
						cwd: "/Users/jonathanhaas/Documents/Projects/maestro-internal",
					},
				},
			},
		}),
	);
}
