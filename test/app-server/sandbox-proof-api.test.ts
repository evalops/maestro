import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import {
	type MaestroAppServerSandboxProof,
	createMaestroAppServerSandboxProof,
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { SessionManager } from "../../src/session/manager.js";

describe("Maestro app-server sandbox proof API", () => {
	let testDir: string;
	let manager: SessionManager;

	beforeEach(() => {
		testDir = join(tmpdir(), `maestro-app-server-sandbox-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		manager = new SessionManager(false, undefined, { sessionDir: testDir });
	});

	afterEach(() => {
		manager.disable();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("advertises sandbox probe and proof capabilities", () => {
		const api = createMaestroAppServerSessionApi(manager);

		expect(api.initialize()).toMatchObject({
			capabilities: {
				sandboxProbe: true,
				sandboxProof: true,
			},
		});
	});

	it("exposes probe and proof results through the app-server contract", async () => {
		const sandboxProof: MaestroAppServerSandboxProof = {
			probe: () => ({
				available: true,
				type: "seatbelt",
				platform: "darwin",
				supportedModes: ["read-only", "workspace-write"],
				proofAvailable: true,
			}),
			runProof: async () => ({
				mode: "workspace-write",
				available: true,
				type: "seatbelt",
				passed: true,
				checks: [
					{
						name: "workspace-write",
						passed: true,
						detail: "wrote inside workspace",
					},
					{
						name: "outside-write-blocked",
						passed: true,
						detail: "blocked write outside workspace",
					},
				],
			}),
		};
		const api = createMaestroAppServerSessionApi(manager, { sandboxProof });

		const probeResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "sandbox-probe",
			method: "sandbox/probe",
		});
		expect(probeResponse.result).toEqual({
			available: true,
			type: "seatbelt",
			platform: "darwin",
			supportedModes: ["read-only", "workspace-write"],
			proofAvailable: true,
		});
		expect(Value.Check(MaestroAppServerResponseSchema, probeResponse)).toBe(
			true,
		);

		const proofResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "sandbox-proof",
			method: "sandbox/proof/run",
			params: { mode: "workspace-write" },
		});
		expect(proofResponse.result).toMatchObject({
			mode: "workspace-write",
			available: true,
			type: "seatbelt",
			passed: true,
			checks: [
				{ name: "workspace-write", passed: true },
				{ name: "outside-write-blocked", passed: true },
			],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, proofResponse)).toBe(
			true,
		);
	});

	it("reports unavailable native sandbox proof without falling back silently", async () => {
		const sandboxProof = createMaestroAppServerSandboxProof({
			cwd: testDir,
			isNativeSandboxAvailable: () => false,
			getNativeSandboxType: () => "none",
		});

		const proof = await sandboxProof.runProof({ mode: "workspace-write" });

		expect(proof).toEqual({
			mode: "workspace-write",
			available: false,
			type: "none",
			passed: false,
			skippedReason: "Native sandbox is not available on this platform.",
			checks: [],
		});
	});

	it("reports workspace preparation failures as failed proof checks", async () => {
		const sandboxProof = createMaestroAppServerSandboxProof({
			cwd: join(testDir, "missing-parent"),
			isNativeSandboxAvailable: () => true,
			getNativeSandboxType: () => "seatbelt",
		});

		const proof = await sandboxProof.runProof({ mode: "workspace-write" });

		expect(proof).toMatchObject({
			mode: "workspace-write",
			available: true,
			type: "seatbelt",
			passed: false,
			checks: [{ name: "native-sandbox-proof", passed: false }],
		});
	});

	it("runs workspace-write proof through the native sandbox adapter", async () => {
		const commands: string[] = [];
		let disposed = false;
		const sandboxProof = createMaestroAppServerSandboxProof({
			cwd: testDir,
			isNativeSandboxAvailable: () => true,
			getNativeSandboxType: () => "seatbelt",
			createSandbox: async (options) => {
				expect(options.mode).toBe("workspace-write");
				expect(options.native).toMatchObject({
					policy: "workspace-write",
					networkAccess: false,
					excludeSlashTmp: true,
					excludeTmpdir: true,
				});
				expect(options.cwd.startsWith(testDir)).toBe(true);
				expect(options.cwd).toContain("maestro-native-proof-");
				return {
					exec: async (command: string) => {
						commands.push(command);
						if (command.includes("MAESTRO_SANDBOX")) {
							return { stdout: "seatbelt", stderr: "", exitCode: 0 };
						}
						if (command.includes("inside-proof.txt")) {
							return { stdout: "", stderr: "", exitCode: 0 };
						}
						if (command.includes("maestro-native-proof-outside")) {
							return {
								stdout: "",
								stderr: "Operation not permitted",
								exitCode: 1,
							};
						}
						return { stdout: "", stderr: "unexpected command", exitCode: 1 };
					},
					readFile: async () => "",
					writeFile: async () => {},
					exists: async () => false,
					dispose: async () => {
						disposed = true;
					},
				};
			},
		});

		const proof = await sandboxProof.runProof({ mode: "workspace-write" });

		expect(proof).toMatchObject({
			mode: "workspace-write",
			available: true,
			type: "seatbelt",
			passed: true,
			checks: [
				{ name: "native-env-marker", passed: true },
				{ name: "workspace-write", passed: true },
				{ name: "outside-write-blocked", passed: true },
			],
		});
		expect(commands).toHaveLength(3);
		expect(disposed).toBe(true);
	});

	it("rejects malformed proof params as an invalid request", async () => {
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "sandbox-invalid-params",
			method: "sandbox/proof/run",
			params: ["workspace-write"] as unknown as Record<string, unknown>,
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "Invalid params",
		});
	});

	it("rejects malformed proof params before invoking injected adapters", async () => {
		let invoked = false;
		const sandboxProof: MaestroAppServerSandboxProof = {
			probe: () => ({
				available: true,
				type: "seatbelt",
				platform: "darwin",
				supportedModes: ["read-only", "workspace-write"],
				proofAvailable: true,
			}),
			runProof: async () => {
				invoked = true;
				throw new Error("adapter should not be called");
			},
		};
		const api = createMaestroAppServerSessionApi(manager, { sandboxProof });

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "sandbox-injected-invalid-params",
			method: "sandbox/proof/run",
			params: ["workspace-write"] as unknown as Record<string, unknown>,
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "Invalid params",
		});
		expect(invoked).toBe(false);
	});

	it("rejects malformed probe params as an invalid request", async () => {
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "sandbox-probe-invalid-params",
			method: "sandbox/probe",
			params: "probe" as unknown as Record<string, unknown>,
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "Invalid params",
		});
	});
});
