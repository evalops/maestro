import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	MaestroTuiBinaryNotFoundError,
	buildNativeTuiCliArgs,
	findBinaryOnPath,
	launchNativeTui,
	resolveMaestroTuiBinary,
	shouldLaunchNativeInteractiveTui,
	shouldLaunchNativePrint,
} from "../../src/cli/native-tui-launcher.js";

type SpawnFn = typeof import("node:child_process").spawn;

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

	it("uses linux-x64 and linux-arm64 vendor paths", () => {
		for (const arch of ["x64", "arm64"] as const) {
			const vendor = join(
				packageRoot,
				"vendor",
				"maestro-tui",
				`linux-${arch}`,
				"maestro-tui",
			);
			const result = resolveMaestroTuiBinary({
				env: {},
				packageRoot,
				platform: "linux",
				arch,
				exists: (path) => path === vendor,
				findOnPath: () => undefined,
			});
			expect(result).toBe(vendor);
		}
	});

	it("names the platform triple in the not-found error", () => {
		try {
			resolveMaestroTuiBinary({
				env: {},
				packageRoot,
				platform: "linux",
				arch: "x64",
				exists: () => false,
				findOnPath: () => undefined,
			});
			expect.unreachable("should have thrown");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("vendor/maestro-tui/linux-x64/maestro-tui");
			expect(message).toContain("native Rust binary");
			expect(message).toContain("Non-interactive modes");
		}
	});
});

describe("launchNativeTui", () => {
	it("spawns the resolved binary with mapped args and forwards exit code", async () => {
		const child = new EventEmitter() as EventEmitter & {
			// minimal child process surface used by launchNativeTui
		};
		const spawnImpl = vi.fn(() => child);
		const promise = launchNativeTui({
			parsed: { model: "gpt-4o-mini", provider: "openai", messages: [] },
			cwd: "/work",
			env: { PATH: "/bin" },
			resolveOptions: {
				env: { MAESTRO_TUI_BIN: "/bin/fake-maestro-tui" },
				exists: (path) => path === "/bin/fake-maestro-tui",
			},
			spawnImpl: spawnImpl as unknown as SpawnFn,
		});
		expect(spawnImpl).toHaveBeenCalledWith(
			"/bin/fake-maestro-tui",
			["--provider", "openai", "--model", "gpt-4o-mini"],
			expect.objectContaining({
				stdio: "inherit",
				cwd: "/work",
			}),
		);
		child.emit("exit", 7, null);
		await expect(promise).resolves.toBe(7);
	});

	it("maps SIGINT to 128+2", async () => {
		const child = new EventEmitter();
		const promise = launchNativeTui({
			parsed: { messages: [] },
			resolveOptions: {
				env: { MAESTRO_TUI_BIN: "/bin/fake" },
				exists: () => true,
			},
			spawnImpl: (() => child) as unknown as SpawnFn,
		});
		child.emit("exit", null, "SIGINT");
		await expect(promise).resolves.toBe(130);
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

	it("forwards --worktree (auto name and named)", () => {
		expect(buildNativeTuiCliArgs({ worktree: true, messages: [] })).toEqual([
			"--worktree",
		]);
		expect(
			buildNativeTuiCliArgs({ worktree: "feat-x", messages: ["go"] }),
		).toEqual(["--worktree", "feat-x", "go"]);
	});

	it("forwards --print and --json", () => {
		expect(
			buildNativeTuiCliArgs({
				print: true,
				json: true,
				messages: ["hello"],
			}),
		).toEqual(["--print", "--json", "hello"]);
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
				continue: true,
			}),
		).toBe(true);
		// Explicit --mode text is single-shot scripting, not interactive native.
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: [],
				mode: "text",
			}),
		).toBe(false);
	});

	it("does not launch for headless, rpc, script modes, or subcommands", () => {
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
		// Explicit single-shot scripting stays on TS agent.
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: ["hi"],
				mode: "text",
			}),
		).toBe(false);
		expect(
			shouldLaunchNativeInteractiveTui({
				messages: ["hi"],
				mode: "json",
			}),
		).toBe(false);
	});

	it("launches native for trailing prompts in interactive TTY (Grok-style)", () => {
		const prev = process.env.MAESTRO_NATIVE_PROMPT;
		const prevTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			delete process.env.MAESTRO_NATIVE_PROMPT;
			Object.defineProperty(process.stdout, "isTTY", {
				value: true,
				configurable: true,
			});
			expect(
				shouldLaunchNativeInteractiveTui({
					messages: ["fix the bug"],
				}),
			).toBe(true);
		} finally {
			if (prev === undefined) {
				delete process.env.MAESTRO_NATIVE_PROMPT;
			} else {
				process.env.MAESTRO_NATIVE_PROMPT = prev;
			}
			if (prevTty) {
				Object.defineProperty(process.stdout, "isTTY", prevTty);
			}
		}
	});
});

describe("shouldLaunchNativePrint", () => {
	it("routes mode text/json and non-TTY prompts to native print", () => {
		expect(
			shouldLaunchNativePrint({
				messages: ["hi"],
				mode: "text",
			}),
		).toBe(true);
		expect(
			shouldLaunchNativePrint({
				messages: ["hi"],
				mode: "json",
			}),
		).toBe(true);
		expect(
			shouldLaunchNativePrint({
				command: "exec",
				messages: ["do work"],
			}),
		).toBe(true);
		expect(
			shouldLaunchNativePrint({
				command: "exec",
				messages: ["do work"],
				execOutputSchema: "schema.json",
			}),
		).toBe(false);
	});
});
