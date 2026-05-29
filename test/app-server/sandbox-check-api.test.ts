import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import {
	type MaestroAppServerSandboxCheck,
	createMaestroAppServerSandboxCheck,
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { SessionManager } from "../../src/session/manager.js";

describe("Maestro app-server sandbox check API", () => {
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

	it("advertises sandbox probe and check capabilities", () => {
		const api = createMaestroAppServerSessionApi(manager);

		expect(api.initialize()).toMatchObject({
			capabilities: {
				sandboxProbe: true,
				sandboxCheck: true,
			},
		});
	});

	it("exposes probe and check results through the app-server contract", async () => {
		const sandboxCheck: MaestroAppServerSandboxCheck = {
			probe: () => ({
				available: true,
				type: "seatbelt",
				platform: "darwin",
				supportedModes: ["read-only", "workspace-write"],
				checkAvailable: true,
			}),
			runCheck: async () => ({
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
		const api = createMaestroAppServerSessionApi(manager, { sandboxCheck });

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
			checkAvailable: true,
		});
		expect(Value.Check(MaestroAppServerResponseSchema, probeResponse)).toBe(
			true,
		);

		const checkResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "sandbox-check",
			method: "sandbox/check/run",
			params: { mode: "workspace-write" },
		});
		expect(checkResponse.result).toMatchObject({
			mode: "workspace-write",
			available: true,
			type: "seatbelt",
			passed: true,
			checks: [
				{ name: "workspace-write", passed: true },
				{ name: "outside-write-blocked", passed: true },
			],
		});
		expect(Value.Check(MaestroAppServerResponseSchema, checkResponse)).toBe(
			true,
		);
	});

	it("reports unavailable native sandbox check without falling back silently", async () => {
		const sandboxCheck = createMaestroAppServerSandboxCheck({
			cwd: testDir,
			isNativeSandboxAvailable: () => false,
			getNativeSandboxType: () => "none",
		});

		const check = await sandboxCheck.runCheck({ mode: "workspace-write" });

		expect(check).toEqual({
			mode: "workspace-write",
			available: false,
			type: "none",
			passed: false,
			skippedReason: "Native sandbox is not available on this platform.",
			checks: [],
		});
	});

	it("reports workspace preparation failures as failed sandbox checks", async () => {
		const sandboxCheck = createMaestroAppServerSandboxCheck({
			cwd: join(testDir, "missing-parent"),
			isNativeSandboxAvailable: () => true,
			getNativeSandboxType: () => "seatbelt",
		});

		const check = await sandboxCheck.runCheck({ mode: "workspace-write" });

		expect(check).toMatchObject({
			mode: "workspace-write",
			available: true,
			type: "seatbelt",
			passed: false,
			checks: [{ name: "native-sandbox-check", passed: false }],
		});
	});

	it("runs the workspace-write check through the native sandbox adapter", async () => {
		const commands: string[] = [];
		let disposed = false;
		const sandboxCheck = createMaestroAppServerSandboxCheck({
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
				expect(options.cwd).toContain("maestro-native-check-");
				return {
					exec: async (command: string) => {
						commands.push(command);
						if (command.includes("MAESTRO_SANDBOX")) {
							return { stdout: "seatbelt", stderr: "", exitCode: 0 };
						}
						if (command.includes("inside-check.txt")) {
							return { stdout: "", stderr: "", exitCode: 0 };
						}
						if (command.includes("maestro-native-check-outside")) {
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

		const check = await sandboxCheck.runCheck({ mode: "workspace-write" });

		expect(check).toMatchObject({
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

	it("rejects malformed check params as an invalid request", async () => {
		const api = createMaestroAppServerSessionApi(manager);

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "sandbox-invalid-params",
			method: "sandbox/check/run",
			params: ["workspace-write"] as unknown as Record<string, unknown>,
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "Invalid params",
		});
	});

	it("rejects malformed check params before invoking injected adapters", async () => {
		let invoked = false;
		const sandboxCheck: MaestroAppServerSandboxCheck = {
			probe: () => ({
				available: true,
				type: "seatbelt",
				platform: "darwin",
				supportedModes: ["read-only", "workspace-write"],
				checkAvailable: true,
			}),
			runCheck: async () => {
				invoked = true;
				throw new Error("adapter should not be called");
			},
		};
		const api = createMaestroAppServerSessionApi(manager, { sandboxCheck });

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "sandbox-injected-invalid-params",
			method: "sandbox/check/run",
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
