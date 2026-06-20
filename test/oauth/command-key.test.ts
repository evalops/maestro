import { beforeEach, describe, expect, it, vi } from "vitest";

// Control surface for the execSync mock: tests configure what the "command"
// returns and whether it throws, and we assert call counts to prove caching.
let mockOutput = "resolved-key";
let mockShouldThrow = false;
const execSyncMock = vi.fn((_cmd: string) => mockOutput);

vi.mock("node:child_process", () => ({
	execSync: (...args: unknown[]) => execSyncMock(...(args as [string])),
}));

const {
	COMMAND_PREFIX,
	COMMAND_TEMPLATES,
	clearCommandCache,
	clearCommandCacheEntry,
	extractCommand,
	isCommandKey,
	resolveApiKey,
	resolveApiKeys,
	resolveCommandKey,
	validateCommandKey,
} = await import("../../src/oauth/command-key.js");

beforeEach(() => {
	clearCommandCache();
	execSyncMock.mockClear();
	mockOutput = "resolved-key";
	mockShouldThrow = false;
	execSyncMock.mockImplementation(() => mockOutput);
});

describe("command-key — pure validators", () => {
	it("isCommandKey detects the cmd: prefix", () => {
		expect(isCommandKey("cmd:echo hi")).toBe(true);
		expect(isCommandKey("sk-literal-key")).toBe(false);
		expect(isCommandKey("")).toBe(false);
	});

	it("extractCommand strips the prefix and trims, and rejects non-command values", () => {
		expect(extractCommand("cmd:   echo hi  ")).toBe("echo hi");
		expect(() => extractCommand("not-a-command")).toThrow("not a command key");
		// the error preview is truncated for safety
		expect(() => extractCommand("a-very-long-literal-value")).toThrow(
			"not a command key",
		);
	});

	it("COMMAND_PREFIX is exported", () => {
		expect(COMMAND_PREFIX).toBe("cmd:");
	});
});

describe("command-key — COMMAND_TEMPLATES", () => {
	it("every template produces a cmd:-prefixed command", () => {
		const samples = [
			COMMAND_TEMPLATES.macos_keychain("anthropic"),
			COMMAND_TEMPLATES.onepassword("vault", "item"),
			COMMAND_TEMPLATES.bitwarden("item"),
			COMMAND_TEMPLATES.vault("path", "field"),
			COMMAND_TEMPLATES.aws_secrets("id"),
			COMMAND_TEMPLATES.gcp_secrets("name"),
			COMMAND_TEMPLATES.azure_keyvault("vault", "name"),
			COMMAND_TEMPLATES.gopass("path"),
			COMMAND_TEMPLATES.pass("path"),
		];
		for (const cmd of samples) {
			expect(isCommandKey(cmd)).toBe(true);
		}
	});

	it("templates interpolate their arguments", () => {
		expect(COMMAND_TEMPLATES.macos_keychain("svc")).toContain(
			"find-generic-password -ws 'svc'",
		);
		expect(COMMAND_TEMPLATES.onepassword("v", "i", "credential")).toContain(
			"op://v/i/credential",
		);
	});
});

describe("command-key — resolveCommandKey", () => {
	it("returns literal values unchanged without executing anything", () => {
		expect(resolveCommandKey("sk-literal")).toBe("sk-literal");
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it("executes the command once and caches the result", () => {
		mockOutput = "cached-key";
		expect(resolveCommandKey("cmd:echo cached-key")).toBe("cached-key");
		expect(execSyncMock).toHaveBeenCalledTimes(1);
		// second call is served from cache -> no new execution
		expect(resolveCommandKey("cmd:echo cached-key")).toBe("cached-key");
		expect(execSyncMock).toHaveBeenCalledTimes(1);
	});

	it("useCache=false bypasses the cache and re-executes", () => {
		mockOutput = "v1";
		resolveCommandKey("cmd:echo key");
		mockOutput = "v2";
		expect(resolveCommandKey("cmd:echo key", false)).toBe("v2");
		expect(execSyncMock).toHaveBeenCalledTimes(2);
	});

	it("clearCommandCacheEntry invalidates a single command", () => {
		mockOutput = "first";
		resolveCommandKey("cmd:echo key");
		clearCommandCacheEntry("echo key");
		mockOutput = "second";
		expect(resolveCommandKey("cmd:echo key")).toBe("second");
		expect(execSyncMock).toHaveBeenCalledTimes(2);
	});

	it("throws when the command returns empty output", () => {
		mockOutput = "   ";
		expect(() => resolveCommandKey("cmd:echo ''")).toThrow("empty result");
	});

	it("wraps command failures with a descriptive error", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => resolveCommandKey("cmd:broken")).toThrow(
			"Failed to execute API key command",
		);
	});
});

describe("command-key — resolveApiKey / resolveApiKeys", () => {
	it("resolveApiKey delegates cmd: values and passes literals through", () => {
		mockOutput = "from-cmd";
		expect(resolveApiKey("cmd:echo from-cmd")).toBe("from-cmd");
		expect(resolveApiKey("sk-literal")).toBe("sk-literal");
	});

	it("resolveApiKeys keeps the original value when a command fails", () => {
		execSyncMock.mockReset();
		execSyncMock
			.mockImplementationOnce(() => "ok")
			.mockImplementationOnce(() => {
				throw new Error("nope");
			});
		const mixed = resolveApiKeys({
			good: "cmd:echo ok",
			bad: "cmd:failing",
			literal: "sk-123",
		});
		expect(mixed.good).toBe("ok");
		expect(mixed.literal).toBe("sk-123");
		// on failure the original (cmd:...) value is retained rather than throwing
		expect(mixed.bad).toBe("cmd:failing");
	});
});

describe("command-key — validateCommandKey", () => {
	it("non-command values are always valid (no execution)", () => {
		expect(validateCommandKey("sk-literal")).toEqual({ valid: true });
		expect(execSyncMock).not.toHaveBeenCalled();
	});

	it("a resolving command reports valid", () => {
		mockOutput = "ok";
		expect(validateCommandKey("cmd:echo ok")).toEqual({ valid: true });
	});

	it("a failing command reports invalid with a redacted error", () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("secret-leak-in-message");
		});
		const result = validateCommandKey("cmd:broken");
		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("an empty command result reports invalid", () => {
		mockOutput = "";
		const result = validateCommandKey("cmd:echo ''");
		expect(result.valid).toBe(false);
		// resolveCommandKey throws on empty output; validateCommandKey surfaces a
		// redacted message that includes the "empty result" reason.
		expect(result.error).toMatch(/empty result/i);
	});
});
