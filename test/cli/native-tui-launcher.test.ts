import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	MaestroTuiBinaryNotFoundError,
	buildNativeTuiCliArgs,
	findBinaryOnPath,
	resolveMaestroTuiBinary,
	shouldLaunchNativeInteractiveTui,
} from "../../src/cli/native-tui-launcher.js";

describe("resolveMaestroTuiBinary", () => {
	const packageRoot = "/pkg";
	const platform = "darwin" as const;
	const arch = "arm64";
	const vendorPath = join(
		packageRoot,
		"vendor",
		"maestro-tui",
		"darwin-arm64",
		"maestro-tui",
	);
	const releaseDev = join(
		packageRoot,
		"packages",
		"tui-rs",
		"target",
		"release",
		"maestro-tui",
	);
	const debugDev = join(
		packageRoot,
		"packages",
		"tui-rs",
		"target",
		"debug",
		"maestro-tui",
	);

	it("prefers MAESTRO_TUI_BIN when set to an existing absolute path", () => {
		const envBin = "/custom/bin/maestro-tui";
		const exists = vi.fn((path: string) => path === envBin);
		const result = resolveMaestroTuiBinary({
			env: { MAESTRO_TUI_BIN: envBin },
			packageRoot,
			platform,
			arch,
			exists,
			findOnPath: () => undefined,
		});
		expect(result).toBe(envBin);
		expect(exists).toHaveBeenCalledWith(envBin);
	});

	it("errors when MAESTRO_TUI_BIN is set but the path is missing", () => {
		expect(() =>
			resolveMaestroTuiBinary({
				env: { MAESTRO_TUI_BIN: "/missing/maestro-tui" },
				packageRoot,
				platform,
				arch,
				exists: () => false,
				findOnPath: () => undefined,
			}),
		).toThrow(MaestroTuiBinaryNotFoundError);
		expect(() =>
			resolveMaestroTuiBinary({
				env: { MAESTRO_TUI_BIN: "/missing/maestro-tui" },
				packageRoot,
				platform,
				arch,
				exists: () => false,
				findOnPath: () => undefined,
			}),
		).toThrow(/MAESTRO_TUI_BIN is set/);
	});

	it("uses the vendor path before PATH and dev fallbacks", () => {
		const exists = vi.fn((path: string) => path === vendorPath);
		const findOnPath = vi.fn(() => "/usr/local/bin/maestro-tui");
		const result = resolveMaestroTuiBinary({
			env: {},
			packageRoot,
			platform,
			arch,
			exists,
			findOnPath,
		});
		expect(result).toBe(vendorPath);
		expect(findOnPath).not.toHaveBeenCalled();
	});

	it("uses PATH when vendor is absent", () => {
		const onPath = "/usr/bin/maestro-tui";
		const result = resolveMaestroTuiBinary({
			env: { PATH: "/usr/bin" },
			packageRoot,
			platform,
			arch,
			exists: (path) => path === onPath,
			findOnPath: () => onPath,
		});
		expect(result).toBe(onPath);
	});

	it("uses release then debug dev fallbacks after PATH", () => {
		const releaseResult = resolveMaestroTuiBinary({
			env: {},
			packageRoot,
			platform,
			arch,
			exists: (path) => path === releaseDev,
			findOnPath: () => undefined,
		});
		expect(releaseResult).toBe(releaseDev);

		const debugResult = resolveMaestroTuiBinary({
			env: {},
			packageRoot,
			platform,
			arch,
			exists: (path) => path === debugDev,
			findOnPath: () => undefined,
		});
		expect(debugResult).toBe(debugDev);
	});

	it("throws an actionable error when nothing is found", () => {
		expect(() =>
			resolveMaestroTuiBinary({
				env: {},
				packageRoot,
				platform,
				arch,
				exists: () => false,
				findOnPath: () => undefined,
			}),
		).toThrow(MaestroTuiBinaryNotFoundError);

		try {
			resolveMaestroTuiBinary({
				env: {},
				packageRoot,
				platform,
				arch,
				exists: () => false,
				findOnPath: () => undefined,
			});
			expect.unreachable("should have thrown");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain(
				"cargo build --release --manifest-path packages/tui-rs/Cargo.toml",
			);
			expect(message).toContain("MAESTRO_TUI_BIN");
			expect(message).toContain("vendor/maestro-tui");
		}
	});

	it("uses win32 .exe name under vendor", () => {
		const winVendor = join(
			packageRoot,
			"vendor",
			"maestro-tui",
			"win32-x64",
			"maestro-tui.exe",
		);
		const result = resolveMaestroTuiBinary({
			env: {},
			packageRoot,
			platform: "win32",
			arch: "x64",
			exists: (path) => path === winVendor,
			findOnPath: () => undefined,
		});
		expect(result).toBe(winVendor);
	});
});

describe("findBinaryOnPath", () => {
	it("returns the first existing PATH entry", () => {
		const found = findBinaryOnPath(
			"maestro-tui",
			{ PATH: "/a:/b:/c" },
			(path) => path === join("/b", "maestro-tui"),
		);
		expect(found).toBe(join("/b", "maestro-tui"));
	});
});

describe("buildNativeTuiCliArgs", () => {
	it("maps only flags maestro-tui accepts", () => {
		expect(
			buildNativeTuiCliArgs({
				provider: "openai",
				model: "gpt-4o",
				apiKey: "sk-test",
				continue: true,
				resume: true,
				messages: ["hello", "world"],
			}),
		).toEqual([
			"--provider",
			"openai",
			"--model",
			"gpt-4o",
			"--api-key",
			"sk-test",
			"--continue",
			"--resume",
			"hello",
			"world",
		]);
	});

	it("omits unset flags", () => {
		expect(buildNativeTuiCliArgs({ messages: [] })).toEqual([]);
		expect(buildNativeTuiCliArgs({ model: "claude-sonnet" })).toEqual([
			"--model",
			"claude-sonnet",
		]);
	});
});

describe("shouldLaunchNativeInteractiveTui", () => {
	it("launches for bare interactive invocations", () => {
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: [],
			}),
		).toBe(true);
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: [],
				mode: "text",
				continue: true,
			} as { messages: string[]; mode?: string }),
		).toBe(true);
	});

	it("does not launch for headless, rpc, prompts, or subcommands", () => {
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: ["hi"],
			}),
		).toBe(false);
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: [],
				mode: "rpc",
			}),
		).toBe(false);
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: [],
				headless: true,
			}),
		).toBe(false);
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: [],
				mode: "headless",
			}),
		).toBe(false);
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: [],
				command: "exec",
			}),
		).toBe(false);
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: [],
				command: "web",
			}),
		).toBe(false);
	});
});
