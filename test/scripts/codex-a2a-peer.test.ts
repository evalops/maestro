import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type CapturedRequest = {
	body: string;
	headers: IncomingMessage["headers"];
	method?: string;
	url?: string;
};

const scriptPath = resolve(process.cwd(), "scripts/codex-a2a-peer.py");
const execFileAsync = promisify(execFile);

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolveBody(body));
		request.on("error", reject);
	});
}

async function runPeer(
	configPath: string,
	args: string[],
	env: NodeJS.ProcessEnv = {},
) {
	const { stdout } = await execFileAsync(
		"python3",
		[scriptPath, "--config", configPath, ...args],
		{
			encoding: "utf8",
			env: { ...process.env, ...env },
		},
	);
	return stdout;
}

describe("codex-a2a-peer", () => {
	let server: Server;
	let baseUrl: string;
	let configPath: string;
	let requests: CapturedRequest[];

	beforeEach(async () => {
		requests = [];
		server = createServer(async (request, response) => {
			const body = await readBody(request);
			requests.push({
				body,
				headers: request.headers,
				method: request.method,
				url: request.url,
			});

			response.setHeader("Content-Type", "application/json");
			if (request.url === "/.well-known/agent-card.json") {
				response.end(
					JSON.stringify({
						protocolVersion: "1.0",
						name: "Mock Codex Peer",
						url: baseUrl,
						version: "test",
						capabilities: { streaming: false },
						defaultInputModes: ["text/plain"],
						defaultOutputModes: ["text/plain"],
						supportedInterfaces: [
							{
								url: baseUrl,
								protocolBinding: "HTTP+JSON",
								protocolVersion: "1.0",
							},
						],
						skills: [],
					}),
				);
				return;
			}
			if (request.url === "/bad-json/.well-known/agent-card.json") {
				response.end("{not json");
				return;
			}
			if (request.url === "/message:send") {
				response.end(
					JSON.stringify({
						task: {
							id: "task-1",
							contextId: "ctx-1",
							status: {
								state: "TASK_STATE_COMPLETED",
								message: {
									role: "ROLE_AGENT",
									parts: [{ text: "hello from peer", mediaType: "text/plain" }],
								},
							},
							artifacts: [],
							history: [],
							metadata: {},
						},
					}),
				);
				return;
			}
			if (request.url === "/tasks/task-1") {
				response.end(
					JSON.stringify({
						id: "task-1",
						contextId: "ctx-1",
						status: { state: "TASK_STATE_COMPLETED" },
					}),
				);
				return;
			}
			response.statusCode = 404;
			response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
		});
		await new Promise<void>((resolveListen) => {
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("mock server did not bind to a TCP port");
		}
		baseUrl = `http://127.0.0.1:${address.port}`;
		const directory = mkdtempSync(join(tmpdir(), "codex-a2a-peer-"));
		configPath = join(directory, "peers.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				defaultPeer: "mock",
				peers: {
					mock: {
						url: `${baseUrl}/message:send`,
						tokenEnv: "TEST_A2A_PEER_TOKEN",
					},
				},
			}),
		);
	});

	afterEach(async () => {
		await new Promise<void>((resolveClose) => {
			server.close(() => resolveClose());
		});
	});

	it("lists peers without printing token values", async () => {
		const output = await runPeer(configPath, ["list"], {
			TEST_A2A_PEER_TOKEN: "super-secret-token",
		});

		expect(output).toContain("mock");
		expect(output).toContain(baseUrl);
		expect(output).toContain("auth=env:TEST_A2A_PEER_TOKEN");
		expect(output).not.toContain("super-secret-token");
	});

	it("fetches a peer Agent Card with A2A headers", async () => {
		const output = await runPeer(configPath, ["card", "mock"], {
			TEST_A2A_PEER_TOKEN: "super-secret-token",
		});

		expect(output).toContain("name: Mock Codex Peer");
		expect(requests[0]).toMatchObject({
			method: "GET",
			url: "/.well-known/agent-card.json",
		});
		expect(requests[0]?.headers.authorization).toBe(
			"Bearer super-secret-token",
		);
		expect(requests[0]?.headers["a2a-version"]).toBe("1.0");
	});

	it("reports malformed JSON responses without a traceback", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				defaultPeer: "bad",
				authRequired: false,
				peers: {
					bad: {
						url: `${baseUrl}/bad-json`,
					},
				},
			}),
		);

		await expect(runPeer(configPath, ["card"], {})).rejects.toMatchObject({
			stderr: expect.stringContaining("returned invalid JSON"),
		});
	});

	it("sends a synchronous handoff through message:send", async () => {
		const output = await runPeer(
			configPath,
			["send", "--from", "dev-desktop", "mock", "hello", "fleet"],
			{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
		);

		expect(output).toContain("task: task-1");
		expect(output).toContain("state: TASK_STATE_COMPLETED");
		expect(output).toContain("hello from peer");
		const request = requests.find((item) => item.url === "/message:send");
		expect(request?.headers.authorization).toBe("Bearer super-secret-token");
		expect(request?.headers["a2a-version"]).toBe("1.0");
		const body = JSON.parse(request?.body ?? "{}");
		expect(body).toMatchObject({
			configuration: { returnImmediately: false },
			message: {
				role: "ROLE_USER",
				parts: [{ text: "hello fleet", mediaType: "text/plain" }],
				metadata: { handoffFrom: "dev-desktop", relayPeer: "mock" },
			},
		});
	});

	it("uses defaultPeer for inline send messages without an explicit peer", async () => {
		await runPeer(configPath, ["send", "hello", "fleet"], {
			TEST_A2A_PEER_TOKEN: "super-secret-token",
		});

		const request = requests.find((item) => item.url === "/message:send");
		const body = JSON.parse(request?.body ?? "{}");
		expect(body).toMatchObject({
			message: {
				parts: [{ text: "hello fleet", mediaType: "text/plain" }],
				metadata: { relayPeer: "mock" },
			},
		});
	});

	it("fails closed when the peer token is missing", async () => {
		await expect(
			runPeer(configPath, ["send", "mock", "hello"], {}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("peer token is required"),
		});
		expect(requests).toHaveLength(0);
	});
});
