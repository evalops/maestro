import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import {
	createMaestroAppServerNetworkGovernance,
	fetchWithPinnedAddress,
} from "../../src/app-server/network-governance-api.js";
import {
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { loadPolicy } from "../../src/safety/policy.js";
import { SessionManager } from "../../src/session/manager.js";

async function startLocalServer(
	onRequest: (req: IncomingMessage) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((req, res) => {
		onRequest(req);
		res.writeHead(200, {
			"content-type": "text/plain",
			"x-maestro-network-test": "ok",
		});
		res.end("network-ok");
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}/ok`,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			}),
	};
}

describe("Maestro app-server network governance API", () => {
	let testDir: string;
	let manager: SessionManager;
	const cleanupServers: Array<() => Promise<void>> = [];
	const originalPolicyPath = process.env.MAESTRO_POLICY_PATH;
	const originalEnterprisePolicyPath =
		process.env.MAESTRO_ENTERPRISE_POLICY_PATH;

	beforeEach(() => {
		testDir = join(tmpdir(), `maestro-app-server-network-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		manager = new SessionManager(false, undefined, { sessionDir: testDir });
		process.env.MAESTRO_POLICY_PATH = join(testDir, "policy.json");
		Reflect.deleteProperty(process.env, "MAESTRO_ENTERPRISE_POLICY_PATH");
		loadPolicy(true);
	});

	afterEach(async () => {
		for (const close of cleanupServers.splice(0)) {
			await close();
		}
		manager.disable();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		if (originalPolicyPath === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_POLICY_PATH");
		} else {
			process.env.MAESTRO_POLICY_PATH = originalPolicyPath;
		}
		if (originalEnterprisePolicyPath === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_ENTERPRISE_POLICY_PATH");
		} else {
			process.env.MAESTRO_ENTERPRISE_POLICY_PATH = originalEnterprisePolicyPath;
		}
		loadPolicy(true);
	});

	function writePolicy(policy: object): void {
		writeFileSync(
			process.env.MAESTRO_POLICY_PATH ?? join(testDir, "policy.json"),
			JSON.stringify(policy),
			"utf8",
		);
		loadPolicy(true);
	}

	it("advertises network proxy and audit capabilities", () => {
		const api = createMaestroAppServerSessionApi(manager);

		expect(api.initialize()).toMatchObject({
			capabilities: {
				networkProxy: true,
				networkAudit: true,
			},
		});
	});

	it("fetches through the governed proxy and records audit evidence", async () => {
		let hits = 0;
		const server = await startLocalServer(() => {
			hits += 1;
		});
		cleanupServers.push(server.close);
		const api = createMaestroAppServerSessionApi(manager);

		const fetchResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-fetch",
			method: "network/fetch",
			params: { url: server.url },
		});
		expect(fetchResponse.result).toMatchObject({
			allowed: true,
			status: "allowed",
			statusCode: 200,
			bodyBase64: Buffer.from("network-ok").toString("base64"),
			audit: {
				method: "GET",
				url: server.url,
				host: "127.0.0.1",
				allowed: true,
				status: "allowed",
				statusCode: 200,
			},
		});
		expect(
			(fetchResponse.result as { headers?: Record<string, string> }).headers?.[
				"x-maestro-network-test"
			],
		).toBe("ok");
		expect(Value.Check(MaestroAppServerResponseSchema, fetchResponse)).toBe(
			true,
		);
		expect(hits).toBe(1);

		const auditResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-audit",
			method: "network/audit/list",
		});
		expect(auditResponse.result).toMatchObject({
			audit: [
				{
					method: "GET",
					url: server.url,
					host: "127.0.0.1",
					allowed: true,
					status: "allowed",
					statusCode: 200,
				},
			],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, auditResponse)).toBe(
			true,
		);
	});

	it("preserves repeated response headers in the fetch result", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			networkGovernance: createMaestroAppServerNetworkGovernance({
				fetchImpl: async () =>
					new Response("headers-ok", {
						status: 200,
						headers: [
							["set-cookie", "session=abc; Path=/"],
							["set-cookie", "theme=dark; Path=/"],
							["x-repeat", "one"],
							["x-repeat", "two"],
						],
					}),
			}),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-repeated-headers",
			method: "network/fetch",
			params: { url: "https://example.com/repeated-headers" },
		});

		expect(response.result).toMatchObject({
			allowed: true,
			status: "allowed",
			statusCode: 200,
			headers: {
				"set-cookie": "session=abc; Path=/\ntheme=dark; Path=/",
				"x-repeat": "one, two",
			},
			bodyBase64: Buffer.from("headers-ok").toString("base64"),
		});
		expect(Value.Check(MaestroAppServerResponseSchema, response)).toBe(true);
	});

	it("redacts URL credentials from network audit evidence", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			networkGovernance: createMaestroAppServerNetworkGovernance({
				fetchImpl: async () => new Response("credential-ok", { status: 200 }),
			}),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-redacted-url",
			method: "network/fetch",
			params: { url: "https://user:pass@example.com/secret?token=keep" },
		});

		expect(response.result).toMatchObject({
			allowed: true,
			status: "allowed",
			audit: {
				url: "https://example.com/secret?token=keep",
				host: "example.com",
			},
		});
		const auditResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-redacted-url-audit",
			method: "network/audit/list",
		});
		expect(auditResponse.result).toMatchObject({
			audit: [
				{
					url: "https://example.com/secret?token=keep",
					host: "example.com",
				},
			],
		});
	});

	it("preserves URL credentials in pinned transport while redacting audit evidence", async () => {
		writePolicy({ network: {} });
		let authHeader: string | undefined;
		const server = await startLocalServer((req) => {
			authHeader = req.headers.authorization;
		});
		cleanupServers.push(server.close);
		const credentialedUrl = server.url.replace("http://", "http://user:pass@");
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-credentialed-pinned",
			method: "network/fetch",
			params: { url: credentialedUrl },
		});

		expect(response.result).toMatchObject({
			allowed: true,
			status: "allowed",
			statusCode: 200,
			audit: {
				url: server.url,
				host: "127.0.0.1",
			},
		});
		expect(authHeader).toBe(
			`Basic ${Buffer.from("user:pass", "utf8").toString("base64")}`,
		);
		const auditResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-credentialed-pinned-audit",
			method: "network/audit/list",
		});
		expect(auditResponse.result).toMatchObject({
			audit: [
				{
					url: server.url,
					host: "127.0.0.1",
				},
			],
		});
	});

	it("times out an unresponsive pinned address", async () => {
		const hangingServer: Server = createServer((_req, _res) => undefined);
		await new Promise<void>((resolve) => {
			hangingServer.listen(0, "127.0.0.1", resolve);
		});
		cleanupServers.push(
			() =>
				new Promise((resolve, reject) => {
					hangingServer.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				}),
		);
		const hangingAddress = hangingServer.address() as AddressInfo;
		const startedAt = Date.now();

		await expect(
			fetchWithPinnedAddress(
				`http://localhost:${hangingAddress.port}/ok`,
				{ method: "GET" },
				{
					originalHost: "localhost",
					resolvedAddress: "127.0.0.1",
					resolvedAddresses: ["127.0.0.1"],
				},
				25,
			),
		).rejects.toThrow(
			"Pinned network request to 127.0.0.1 timed out after 25ms",
		);
		expect(Date.now() - startedAt).toBeLessThan(1000);
	});

	it("tries the next validated address when a pinned address fails", async () => {
		let hits = 0;
		const fallbackServer: Server = createServer((_req, res) => {
			hits += 1;
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("fallback-ok");
		});
		await new Promise<void>((resolve) => {
			fallbackServer.listen(0, "127.0.0.1", resolve);
		});
		cleanupServers.push(
			() =>
				new Promise((resolve, reject) => {
					fallbackServer.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				}),
		);
		const fallbackAddress = fallbackServer.address() as AddressInfo;

		const response = await fetchWithPinnedAddress(
			`http://localhost:${fallbackAddress.port}/ok`,
			{ method: "GET" },
			{
				originalHost: "localhost",
				resolvedAddress: "127.0.0.2",
				resolvedAddresses: ["127.0.0.2", "127.0.0.1"],
			},
			100,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("fallback-ok");
		expect(hits).toBe(1);
	});

	it("does not replay non-idempotent requests across validated addresses", async () => {
		let hits = 0;
		const fallbackServer: Server = createServer((_req, res) => {
			hits += 1;
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("unexpected-retry");
		});
		await new Promise<void>((resolve) => {
			fallbackServer.listen(0, "127.0.0.1", resolve);
		});
		cleanupServers.push(
			() =>
				new Promise((resolve, reject) => {
					fallbackServer.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				}),
		);
		const fallbackAddress = fallbackServer.address() as AddressInfo;

		await expect(
			fetchWithPinnedAddress(
				`http://localhost:${fallbackAddress.port}/write`,
				{ method: "POST", body: "payload" },
				{
					originalHost: "localhost",
					resolvedAddress: "127.0.0.2",
					resolvedAddresses: ["127.0.0.2", "127.0.0.1"],
				},
				100,
			),
		).rejects.toThrow();
		expect(hits).toBe(0);
	});

	it("blocks policy-denied egress before contacting the destination", async () => {
		writePolicy({ network: { blockLocalhost: true } });
		let hits = 0;
		const server = await startLocalServer(() => {
			hits += 1;
		});
		cleanupServers.push(server.close);
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-blocked",
			method: "network/fetch",
			params: { url: server.url },
		});

		expect(response.result).toMatchObject({
			allowed: false,
			status: "blocked",
			reason: "Access to localhost is blocked by enterprise policy.",
			audit: {
				method: "GET",
				url: server.url,
				host: "127.0.0.1",
				allowed: false,
				status: "blocked",
				reason: "Access to localhost is blocked by enterprise policy.",
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, response)).toBe(true);
		expect(hits).toBe(0);
	});

	it("passes the validated DNS address to the fetch transport", async () => {
		writePolicy({ network: {} });
		let binding:
			| {
					originalHost?: string;
					resolvedAddress?: string;
					resolvedAddresses?: string[];
			  }
			| undefined;
		const api = createMaestroAppServerSessionApi(manager, {
			networkGovernance: createMaestroAppServerNetworkGovernance({
				fetchImpl: async (_input, _init, networkBinding) => {
					binding = networkBinding;
					return new Response("pinned-ok", { status: 200 });
				},
			}),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-pinned-dns",
			method: "network/fetch",
			params: { url: "http://localhost/pinned" },
		});

		expect(response.result).toMatchObject({
			allowed: true,
			status: "allowed",
			statusCode: 200,
			bodyBase64: Buffer.from("pinned-ok").toString("base64"),
		});
		expect(binding?.originalHost).toBe("localhost");
		expect(binding?.resolvedAddress).toMatch(/^(127\.0\.0\.1|::1)$/);
		expect(binding?.resolvedAddresses).toContain(binding?.resolvedAddress);
	});

	it("returns audit snapshots without exposing mutable stored records", async () => {
		let hits = 0;
		const server = await startLocalServer(() => {
			hits += 1;
		});
		cleanupServers.push(server.close);
		const api = createMaestroAppServerSessionApi(manager);

		const fetchResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-fetch-snapshot",
			method: "network/fetch",
			params: { url: server.url },
		});
		const fetchResult = fetchResponse.result as {
			audit: { status: string; reason?: string };
		};
		fetchResult.audit.status = "blocked";
		fetchResult.audit.reason = "mutated by caller";

		const firstAuditResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-audit-snapshot-1",
			method: "network/audit/list",
		});
		const firstAudit = firstAuditResponse.result as {
			audit: Array<{ status: string; reason?: string }>;
		};
		firstAudit.audit[0].status = "failed";
		firstAudit.audit[0].reason = "mutated by caller";

		const secondAuditResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-audit-snapshot-2",
			method: "network/audit/list",
		});
		expect(secondAuditResponse.result).toMatchObject({
			audit: [
				{
					method: "GET",
					url: server.url,
					host: "127.0.0.1",
					allowed: true,
					status: "allowed",
					statusCode: 200,
				},
			],
		});
		expect(
			(secondAuditResponse.result as { audit: Array<{ reason?: string }> })
				.audit[0].reason,
		).toBeUndefined();
		expect(hits).toBe(1);
	});

	it("cancels oversized streamed responses before buffering the full body", async () => {
		let pulls = 0;
		let canceled = false;
		const api = createMaestroAppServerSessionApi(manager, {
			networkGovernance: createMaestroAppServerNetworkGovernance({
				maxResponseBytes: 10,
				fetchImpl: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								pulls += 1;
								controller.enqueue(Buffer.alloc(6));
							},
							cancel() {
								canceled = true;
							},
						}),
						{ status: 200 },
					),
			}),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-oversized",
			method: "network/fetch",
			params: { url: "https://example.com/large" },
		});

		expect(response.result).toMatchObject({
			allowed: true,
			status: "failed",
			reason: "Response body exceeds 10 byte network proxy limit",
			audit: {
				method: "GET",
				url: "https://example.com/large",
				host: "example.com",
				allowed: true,
				status: "failed",
				reason: "Response body exceeds 10 byte network proxy limit",
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, response)).toBe(true);
		expect(pulls).toBeLessThanOrEqual(3);
		expect(canceled).toBe(true);
	});

	it("falls back to the default response-size limit for non-finite config", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			networkGovernance: createMaestroAppServerNetworkGovernance({
				maxResponseBytes: Number.NaN,
				fetchImpl: async () =>
					new Response(Buffer.alloc(1024 * 1024 + 1), { status: 200 }),
			}),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-nan-response-limit",
			method: "network/fetch",
			params: { url: "https://example.com/large" },
		});

		expect(response.result).toMatchObject({
			allowed: true,
			status: "failed",
			reason: "Response body exceeds 1048576 byte network proxy limit",
			audit: {
				method: "GET",
				url: "https://example.com/large",
				host: "example.com",
				allowed: true,
				status: "failed",
				reason: "Response body exceeds 1048576 byte network proxy limit",
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, response)).toBe(true);
	});

	it("rejects malformed base64 request bodies before network dispatch", async () => {
		let hits = 0;
		const api = createMaestroAppServerSessionApi(manager, {
			networkGovernance: createMaestroAppServerNetworkGovernance({
				fetchImpl: async () => {
					hits += 1;
					return new Response("unexpected", { status: 200 });
				},
			}),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-malformed-body",
			method: "network/fetch",
			params: {
				url: "https://example.com/upload",
				method: "POST",
				bodyBase64: "not base64!",
			},
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "bodyBase64 must be valid base64",
		});
		expect(hits).toBe(0);

		const auditResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-malformed-body-audit",
			method: "network/audit/list",
		});
		expect(auditResponse.result).toEqual({ audit: [], nextCursor: null });
	});

	it("rejects non-object params for network methods as invalid params", async () => {
		const api = createMaestroAppServerSessionApi(manager);

		const fetchResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-null-params",
			method: "network/fetch",
			params: null as unknown as Record<string, unknown>,
		});
		expect(fetchResponse.error).toEqual({
			code: -32602,
			message: "Invalid params",
		});

		const auditResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-array-params",
			method: "network/audit/list",
			params: [] as unknown as Record<string, unknown>,
		});
		expect(auditResponse.error).toEqual({
			code: -32602,
			message: "Invalid params",
		});

		const validAuditResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-invalid-params-audit",
			method: "network/audit/list",
		});
		expect(validAuditResponse.result).toEqual({
			audit: [],
			nextCursor: null,
		});
	});

	it("does not auto-follow redirects outside the governed proxy decision", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			networkGovernance: createMaestroAppServerNetworkGovernance({
				fetchImpl: async (_input, init) => {
					expect(init?.redirect).toBe("manual");
					return new Response("", {
						status: 302,
						headers: { location: "http://127.0.0.1/private" },
					});
				},
			}),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "network-redirect",
			method: "network/fetch",
			params: { url: "https://example.com/redirect" },
		});

		expect(response.result).toMatchObject({
			allowed: true,
			status: "allowed",
			statusCode: 302,
			headers: { location: "http://127.0.0.1/private" },
			bodyBase64: "",
			audit: {
				method: "GET",
				url: "https://example.com/redirect",
				host: "example.com",
				allowed: true,
				status: "allowed",
				statusCode: 302,
			},
		});
		expect(Value.Check(MaestroAppServerResponseSchema, response)).toBe(true);
	});
});
