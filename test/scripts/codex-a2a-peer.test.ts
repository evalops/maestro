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
	let waitTaskPolls: number;

	beforeEach(async () => {
		requests = [];
		waitTaskPolls = 0;
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
			if (request.url === "/bad-utf8/.well-known/agent-card.json") {
				response.end(Buffer.from([0xff]));
				return;
			}
			if (request.url === "/message:send") {
				const parsedBody = JSON.parse(body || "{}");
				const messageText = parsedBody?.message?.parts?.[0]?.text ?? "";
				if (messageText === "direct message") {
					response.end(
						JSON.stringify({
							message: {
								role: "ROLE_AGENT",
								parts: [{ text: "direct response", mediaType: "text/plain" }],
							},
						}),
					);
					return;
				}
				if (messageText === "slow ack") {
					await new Promise((resolveSlow) => setTimeout(resolveSlow, 100));
					response.end(
						JSON.stringify({
							task: {
								id: "task-wait",
								contextId: "ctx-1",
								status: {
									state: "TASK_STATE_WORKING",
									message: {
										role: "ROLE_AGENT",
										parts: [{ text: "slow ack", mediaType: "text/plain" }],
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
				const isAsyncWaitTask =
					messageText === "slow work" &&
					parsedBody?.configuration?.returnImmediately === true;
				const taskId = isAsyncWaitTask ? "task-wait" : "task-1";
				const state = isAsyncWaitTask
					? "TASK_STATE_WORKING"
					: "TASK_STATE_COMPLETED";
				response.end(
					JSON.stringify({
						task: {
							id: taskId,
							contextId: "ctx-1",
							status: {
								state,
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
			if (request.url === "/tasks/task-wait") {
				waitTaskPolls += 1;
				const completed = waitTaskPolls >= 2;
				response.end(
					JSON.stringify({
						id: "task-wait",
						contextId: "ctx-1",
						status: {
							state: completed ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING",
							message: {
								role: "ROLE_AGENT",
								parts: [
									{
										text: completed ? "done after wait" : "still working",
										mediaType: "text/plain",
									},
								],
							},
						},
					}),
				);
				return;
			}
			if (request.url === "/tasks/task-lowercase") {
				waitTaskPolls += 1;
				const completed = waitTaskPolls >= 2;
				response.end(
					JSON.stringify({
						id: "task-lowercase",
						contextId: "ctx-1",
						status: {
							state: completed ? "completed" : "working",
							message: {
								role: "ROLE_AGENT",
								parts: [
									{
										text: completed ? "lowercase done" : "lowercase active",
										mediaType: "text/plain",
									},
								],
							},
						},
					}),
				);
				return;
			}
			if (request.url === "/tasks/task-slow") {
				await new Promise((resolveSlow) => setTimeout(resolveSlow, 100));
				response.end(
					JSON.stringify({
						id: "task-slow",
						contextId: "ctx-1",
						status: {
							state: "TASK_STATE_WORKING",
							message: {
								role: "ROLE_AGENT",
								parts: [{ text: "slow poll", mediaType: "text/plain" }],
							},
						},
					}),
				);
				return;
			}
			if (request.url === "/tasks/task-never") {
				response.end(
					JSON.stringify({
						id: "task-never",
						contextId: "ctx-1",
						status: {
							state: "TASK_STATE_WORKING",
							message: {
								role: "ROLE_AGENT",
								parts: [{ text: "still working", mediaType: "text/plain" }],
							},
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
			if (request.url === "/tasks/task-1:cancel") {
				response.end(
					JSON.stringify({
						task: {
							id: "task-1",
							contextId: "ctx-1",
							status: {
								state: "TASK_STATE_CANCELED",
								message: {
									role: "ROLE_AGENT",
									parts: [{ text: "task canceled", mediaType: "text/plain" }],
								},
							},
						},
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

	it("reports unreadable registry paths without a traceback", async () => {
		const registryDirectory = mkdtempSync(
			join(tmpdir(), "codex-a2a-peer-registry-dir-"),
		);

		await expect(
			runPeer(registryDirectory, ["list"], {}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("cannot read peer registry"),
		});
		await expect(
			runPeer(registryDirectory, ["list"], {}),
		).rejects.not.toMatchObject({
			stderr: expect.stringContaining("Traceback"),
		});
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

	it("reports unreadable token files without a traceback", async () => {
		const tokenDirectory = mkdtempSync(
			join(tmpdir(), "codex-a2a-peer-token-dir-"),
		);
		writeFileSync(
			configPath,
			JSON.stringify({
				peers: {
					mock: {
						url: `${baseUrl}/message:send`,
						tokenFile: tokenDirectory,
					},
				},
			}),
		);

		await expect(
			runPeer(configPath, ["card", "mock"], {}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("cannot read token file"),
		});
		await expect(
			runPeer(configPath, ["card", "mock"], {}),
		).rejects.not.toMatchObject({
			stderr: expect.stringContaining("Traceback"),
		});
		expect(requests).toHaveLength(0);
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
		await expect(runPeer(configPath, ["card"], {})).rejects.not.toMatchObject({
			stderr: expect.stringContaining("Traceback"),
		});
	});

	it("reports invalid UTF-8 responses without a traceback", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				defaultPeer: "bad",
				authRequired: false,
				peers: {
					bad: {
						url: `${baseUrl}/bad-utf8`,
					},
				},
			}),
		);

		await expect(runPeer(configPath, ["card"], {})).rejects.toMatchObject({
			stderr: expect.stringContaining("returned invalid JSON"),
		});
		await expect(runPeer(configPath, ["card"], {})).rejects.not.toMatchObject({
			stderr: expect.stringContaining("Traceback"),
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

	it("sends async work and waits for the returned task to settle", async () => {
		const output = await runPeer(
			configPath,
			[
				"send",
				"--wait",
				"--wait-interval",
				"0.01",
				"--max-wait",
				"1",
				"mock",
				"slow",
				"work",
			],
			{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
		);

		expect(output).toContain("task: task-wait");
		expect(output).toContain("state: TASK_STATE_COMPLETED");
		expect(output).toContain("done after wait");
		const sendRequest = requests.find((item) => item.url === "/message:send");
		expect(JSON.parse(sendRequest?.body ?? "{}")).toMatchObject({
			configuration: { returnImmediately: true },
		});
		expect(
			requests.filter((item) => item.url === "/tasks/task-wait"),
		).toHaveLength(2);
	});

	it("prints direct message responses for send --wait without requiring a task id", async () => {
		const output = await runPeer(
			configPath,
			["send", "--wait", "mock", "direct", "message"],
			{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
		);

		expect(output).toContain("direct response");
		expect(
			requests.filter((item) => item.url?.startsWith("/tasks/")),
		).toHaveLength(0);
	});

	it("waits for an existing peer task to settle", async () => {
		const output = await runPeer(
			configPath,
			["wait", "mock", "task-wait", "--interval", "0.01", "--max-wait", "1"],
			{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
		);

		expect(output).toContain("task: task-wait");
		expect(output).toContain("state: TASK_STATE_COMPLETED");
		expect(output).toContain("done after wait");
		expect(
			requests.filter((item) => item.url === "/tasks/task-wait"),
		).toHaveLength(2);
	});

	it("treats lowercase A2A active states as still waiting", async () => {
		const output = await runPeer(
			configPath,
			[
				"wait",
				"mock",
				"task-lowercase",
				"--interval",
				"0.01",
				"--max-wait",
				"1",
			],
			{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
		);

		expect(output).toContain("task: task-lowercase");
		expect(output).toContain("state: completed");
		expect(output).toContain("lowercase done");
		expect(
			requests.filter((item) => item.url === "/tasks/task-lowercase"),
		).toHaveLength(2);
	});

	it("fails bounded waits without a traceback when a task keeps working", async () => {
		await expect(
			runPeer(
				configPath,
				[
					"wait",
					"mock",
					"task-never",
					"--interval",
					"0.01",
					"--max-wait",
					"0.02",
				],
				{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("did not finish within 0.02s"),
		});
		await expect(
			runPeer(
				configPath,
				[
					"wait",
					"mock",
					"task-never",
					"--interval",
					"0.01",
					"--max-wait",
					"0.02",
				],
				{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
			),
		).rejects.not.toMatchObject({
			stderr: expect.stringContaining("Traceback"),
		});
		expect(requests.some((item) => item.url === "/tasks/task-never")).toBe(
			true,
		);
	});

	it("caps each wait poll to the remaining max-wait deadline", async () => {
		await expect(
			runPeer(
				configPath,
				[
					"wait",
					"mock",
					"task-slow",
					"--interval",
					"0.01",
					"--max-wait",
					"0.05",
					"--timeout",
					"10",
				],
				{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("did not finish within 0.05s"),
		});
		expect(requests.some((item) => item.url === "/tasks/task-slow")).toBe(true);
	});

	it("preserves configured timeoutMs while capping wait poll deadlines", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				defaultPeer: "mock",
				timeoutMs: 20,
				peers: {
					mock: {
						url: baseUrl,
						tokenEnv: "TEST_A2A_PEER_TOKEN",
					},
				},
			}),
		);

		await expect(
			runPeer(
				configPath,
				["wait", "mock", "task-slow", "--interval", "0.01", "--max-wait", "1"],
				{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("GET /tasks/task-slow timed out"),
		});
		await expect(
			runPeer(
				configPath,
				["wait", "mock", "task-slow", "--interval", "0.01", "--max-wait", "1"],
				{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
			),
		).rejects.not.toMatchObject({
			stderr: expect.stringContaining("Traceback"),
		});
		expect(requests.some((item) => item.url === "/tasks/task-slow")).toBe(true);
	});

	it("caps the initial send --wait request to the max-wait deadline", async () => {
		await expect(
			runPeer(
				configPath,
				[
					"send",
					"--wait",
					"--max-wait",
					"0.05",
					"--timeout",
					"10",
					"mock",
					"slow",
					"ack",
				],
				{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining(
				"message:send did not finish within 0.05s",
			),
		});
		expect(requests.some((item) => item.url === "/message:send")).toBe(true);
		expect(requests.some((item) => item.url?.startsWith("/tasks/"))).toBe(
			false,
		);
	});

	it("preserves configured timeoutMs for the initial send --wait request", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				defaultPeer: "mock",
				timeoutMs: 20,
				peers: {
					mock: {
						url: baseUrl,
						tokenEnv: "TEST_A2A_PEER_TOKEN",
					},
				},
			}),
		);

		await expect(
			runPeer(
				configPath,
				["send", "--wait", "--max-wait", "1", "mock", "slow", "ack"],
				{ TEST_A2A_PEER_TOKEN: "super-secret-token" },
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("POST /message:send timed out"),
		});
		expect(requests.some((item) => item.url === "/message:send")).toBe(true);
		expect(requests.some((item) => item.url?.startsWith("/tasks/"))).toBe(
			false,
		);
	});

	it("rejects non-finite wait arguments before sending", async () => {
		await expect(
			runPeer(configPath, ["wait", "mock", "task-1", "--max-wait", "inf"], {
				TEST_A2A_PEER_TOKEN: "super-secret-token",
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("must be finite"),
		});
		await expect(
			runPeer(configPath, ["wait", "mock", "task-1", "--interval", "nan"], {
				TEST_A2A_PEER_TOKEN: "super-secret-token",
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("must be finite"),
		});
		await expect(
			runPeer(configPath, ["wait", "mock", "task-1", "--timeout", "nan"], {
				TEST_A2A_PEER_TOKEN: "super-secret-token",
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("must be finite"),
		});
		await expect(
			runPeer(
				configPath,
				["send", "--peer", "mock", "--wait", "--timeout", "inf", "hello"],
				{
					TEST_A2A_PEER_TOKEN: "super-secret-token",
				},
			),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("must be finite"),
		});
		expect(requests).toHaveLength(0);
	});

	it("cancels a peer task with A2A headers", async () => {
		const output = await runPeer(configPath, ["cancel", "mock", "task-1"], {
			TEST_A2A_PEER_TOKEN: "super-secret-token",
		});

		expect(output).toContain("task: task-1");
		expect(output).toContain("state: TASK_STATE_CANCELED");
		expect(output).toContain("task canceled");
		const request = requests.find(
			(item) => item.url === "/tasks/task-1:cancel",
		);
		expect(request).toMatchObject({
			body: "",
			method: "POST",
			url: "/tasks/task-1:cancel",
		});
		expect(request?.headers.authorization).toBe("Bearer super-secret-token");
		expect(request?.headers["a2a-version"]).toBe("1.0");
	});

	it("requires an explicit peer and task id for cancel", async () => {
		await expect(
			runPeer(configPath, ["cancel", "mock"], {
				TEST_A2A_PEER_TOKEN: "super-secret-token",
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("the following arguments are required"),
		});
		expect(requests).toHaveLength(0);
	});

	it("fails unknown explicit cancel peers before sending", async () => {
		await expect(
			runPeer(configPath, ["cancel", "mok", "task-1"], {
				TEST_A2A_PEER_TOKEN: "super-secret-token",
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("unknown peer 'mok'"),
		});
		expect(requests).toHaveLength(0);
	});

	it("fails unknown explicit peers before sending", async () => {
		await expect(
			runPeer(configPath, ["send", "--peer", "mok", "hello"], {
				TEST_A2A_PEER_TOKEN: "super-secret-token",
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("unknown peer 'mok'"),
		});
		expect(requests).toHaveLength(0);
	});

	it("reports invalid configured timeoutMs without a traceback", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				defaultPeer: "mock",
				authRequired: false,
				timeoutMs: "slow",
				peers: {
					mock: {
						url: baseUrl,
					},
				},
			}),
		);

		await expect(runPeer(configPath, ["card"], {})).rejects.toMatchObject({
			stderr: expect.stringContaining("timeoutMs must be numeric"),
		});
		await expect(runPeer(configPath, ["card"], {})).rejects.not.toMatchObject({
			stderr: expect.stringContaining("Traceback"),
		});
	});

	it("reports non-positive configured timeoutMs without a traceback", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				defaultPeer: "mock",
				authRequired: false,
				timeoutMs: -1,
				peers: {
					mock: {
						url: baseUrl,
					},
				},
			}),
		);

		await expect(runPeer(configPath, ["card"], {})).rejects.toMatchObject({
			stderr: expect.stringContaining("timeoutMs must be positive"),
		});
		await expect(runPeer(configPath, ["card"], {})).rejects.not.toMatchObject({
			stderr: expect.stringContaining("Traceback"),
		});
		expect(requests).toHaveLength(0);
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
