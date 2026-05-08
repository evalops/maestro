import { spawn } from "node:child_process";
import { type IncomingMessage, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const children: ReturnType<typeof spawn>[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill();
	}
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);
});

describe("Conductor native host browser-control telemetry", () => {
	it("forwards browser-control decision notifications to AgentRuntime", async () => {
		const requests: Array<{
			url: string | undefined;
			headers: IncomingMessage["headers"];
			body: Record<string, unknown>;
		}> = [];
		const server = createServer(async (request, response) => {
			const body = JSON.parse(await readRequestBody(request)) as Record<
				string,
				unknown
			>;
			requests.push({ url: request.url, headers: request.headers, body });
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ event: { id: "event-1", sequence: 3 } }));
		});
		servers.push(server);
		await listen(server);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("test server did not expose a TCP address");
		}

		const child = spawn(process.execPath, ["scripts/bridge/native-host.js"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				MAESTRO_AGENT_RUNTIME_SERVICE_URL: `http://127.0.0.1:${address.port}/agentruntime.v1.AgentRuntimeService/HandleTrigger`,
				MAESTRO_EVALOPS_ACCESS_TOKEN: "evalops-token",
				MAESTRO_ENTERPRISE_ORG_ID: "org-1",
				MAESTRO_BRIDGE_PLATFORM_RUN_ID: "fallback-run",
				MAESTRO_BRIDGE_PLATFORM_RUNTIME_TIMEOUT_MS: "5000",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);

		const requestRecorded = waitForRequest(requests);
		child.stdin.write(
			frameNativeMessage({
				jsonrpc: "2.0",
				method: "onBrowserControlDecision",
				params: {
					schemaVersion: "browser-control-runtime-decision/v1",
					traceId: "bcdec_test_1",
					observedAt: "2026-05-08T18:20:00.000Z",
					method: "executeCdp",
					methodProfile: "governed-cdp",
					policyHash: "unknown",
					platformReceiptPresent: true,
					platformReceiptId: "channel_action_receipt_executeCdp",
					platformRunId: "platform-run-1",
					platformRequestHash:
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					approvalRequired: true,
					decision: "denied",
					denyReason: "invalid_platform_receipt",
					conductorContractVersion: "browsercontrol.v1/2",
				},
			}),
		);

		await requestRecorded;
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"/agentruntime.v1.AgentRuntimeService/RecordRunEvent",
		);
		expect(requests[0]?.headers.authorization).toBe("Bearer evalops-token");
		expect(requests[0]?.headers["x-organization-id"]).toBe("org-1");
		expect(requests[0]?.body).toMatchObject({
			runId: "platform-run-1",
			type: "RUNTIME_EVENT_TYPE_AGENT_PROGRESS_RECORDED",
			message: "Browser-control denied: executeCdp (invalid_platform_receipt)",
			attributes: {
				schemaVersion: "browser-control-runtime-decision/v1",
				adapter: "maestro-conductor-native-host",
				source: "conductor-browser-control-native-host",
				traceId: "bcdec_test_1",
				method: "executeCdp",
				methodProfile: "governed-cdp",
				platformReceiptPresent: true,
				platformReceiptId: "channel_action_receipt_executeCdp",
				approvalRequired: true,
				decision: "denied",
				denyReason: "invalid_platform_receipt",
			},
			visibility: {
				level: "RUNTIME_VISIBILITY_LEVEL_ADMIN_VISIBLE",
				audiences: [
					"RUNTIME_AUDIENCE_WORKSPACE_ADMINS",
					"RUNTIME_AUDIENCE_AUDIT",
					"RUNTIME_AUDIENCE_SYSTEM",
				],
				sensitivity: "RUNTIME_SENSITIVITY_INTERNAL",
			},
		});
	});

	it("responds to JSON-RPC requests instead of treating them as notifications", async () => {
		const child = spawn(process.execPath, ["scripts/bridge/native-host.js"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				MAESTRO_AGENT_RUNTIME_SERVICE_URL: "http://127.0.0.1:9",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);

		const response = waitForNativeMessage(child.stdout);
		child.stdin.write(
			frameNativeMessage({
				jsonrpc: "2.0",
				id: "bad-jsonrpc-request",
				method: "unknownMethod",
				params: {},
			}),
		);

		await expect(response).resolves.toMatchObject({
			type: "error",
			ok: false,
			error: "Invalid bridge message",
		});
	});
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("error", reject);
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

function frameNativeMessage(message: unknown): Buffer {
	const payload = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

function waitForNativeMessage(
	stdout: NodeJS.ReadableStream | null,
): Promise<Record<string, unknown>> {
	if (!stdout) {
		return Promise.reject(new Error("native host stdout unavailable"));
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("timed out waiting for native host response")),
			5000,
		);
		let buffer = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
			if (buffer.length < 4) return;
			const length = buffer.readUInt32LE(0);
			if (buffer.length < 4 + length) return;
			cleanup();
			resolve(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timeout);
			stdout.off("data", onData);
			stdout.off("error", onError);
		};
		stdout.on("data", onData);
		stdout.on("error", onError);
	});
}

function waitForRequest(requests: unknown[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("timed out waiting for AgentRuntime request"));
		}, 5000);
		const poll = setInterval(() => {
			if (requests.length > 0) {
				clearInterval(poll);
				clearTimeout(timeout);
				resolve();
			}
		}, 10);
	});
}
