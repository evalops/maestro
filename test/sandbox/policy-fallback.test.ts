import { afterEach, describe, expect, it, vi } from "vitest";

const nativeSandboxModule = "../../src/sandbox/native-sandbox.js";

describe("policy sandbox fallback behavior", () => {
	afterEach(() => {
		vi.doUnmock(nativeSandboxModule);
		vi.resetModules();
	});

	it("refuses to fall back to local execution when policy mode native sandboxing is unavailable", async () => {
		vi.resetModules();
		vi.doMock(nativeSandboxModule, async () => {
			const actual =
				await vi.importActual<
					typeof import("../../src/sandbox/native-sandbox.js")
				>(nativeSandboxModule);
			return {
				...actual,
				isNativeSandboxAvailable: () => false,
				getNativeSandboxType: () => "none",
			};
		});

		const { createSandbox } = await import("../../src/sandbox/index.js");

		await expect(
			createSandbox({
				mode: "workspace-write",
				cwd: "/tmp/maestro-policy-test",
			}),
		).rejects.toThrow(
			'Native sandbox policy mode "workspace-write" requires native sandbox support; refusing to fall back to local execution.',
		);
	});

	it("allows danger-full-access without native sandboxing support", async () => {
		vi.resetModules();
		vi.doMock(nativeSandboxModule, async () => {
			const actual =
				await vi.importActual<
					typeof import("../../src/sandbox/native-sandbox.js")
				>(nativeSandboxModule);
			return {
				...actual,
				isNativeSandboxAvailable: () => false,
				getNativeSandboxType: () => "none",
			};
		});

		const { createSandbox } = await import("../../src/sandbox/index.js");

		await expect(
			createSandbox({
				mode: "danger-full-access",
				cwd: "/tmp/maestro-policy-test",
			}),
		).resolves.toBeUndefined();
	});

	it("keeps legacy native backend fallback when native sandboxing is unavailable", async () => {
		vi.resetModules();
		vi.doMock(nativeSandboxModule, async () => {
			const actual =
				await vi.importActual<
					typeof import("../../src/sandbox/native-sandbox.js")
				>(nativeSandboxModule);
			return {
				...actual,
				isNativeSandboxAvailable: () => false,
				getNativeSandboxType: () => "none",
			};
		});

		const [{ createSandbox }, { LocalSandbox }] = await Promise.all([
			import("../../src/sandbox/index.js"),
			import("../../src/sandbox/local-sandbox.js"),
		]);

		const sandbox = await createSandbox({
			mode: "native",
			cwd: "/tmp/maestro-policy-test",
		});

		expect(sandbox).toBeInstanceOf(LocalSandbox);
		await sandbox?.dispose();
	});

	it("refuses to fall back to local execution when policy mode native initialization fails", async () => {
		vi.resetModules();
		vi.doMock(nativeSandboxModule, async () => {
			const actual =
				await vi.importActual<
					typeof import("../../src/sandbox/native-sandbox.js")
				>(nativeSandboxModule);
			return {
				...actual,
				isNativeSandboxAvailable: () => true,
				getNativeSandboxType: () => "seatbelt",
				createNativeSandbox: () => ({
					initialize: async () => {
						throw new Error("native init failed");
					},
					dispose: async () => {},
					exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
					readFile: async () => "",
					writeFile: async () => {},
					exists: async () => false,
				}),
			};
		});

		const { createSandbox } = await import("../../src/sandbox/index.js");

		await expect(
			createSandbox({ mode: "read-only", cwd: "/tmp/maestro-policy-test" }),
		).rejects.toThrow(
			'Native sandbox policy mode "read-only" failed to initialize; refusing to fall back to local execution.',
		);
	});
});
