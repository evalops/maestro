import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PostToolUseHookInput,
	clearHookConfigCache,
	clearRegisteredHooks,
	getMatchingHooks,
	loadHookConfiguration,
} from "../../src/hooks/index.js";
import { resetGlobalAutoVerifyService } from "../../src/testing/auto-verify.js";
import { registerTestVerificationHooks } from "../../src/testing/test-verification-hook.js";

function createPostToolUseInput(cwd: string): PostToolUseHookInput {
	return {
		hook_event_name: "PostToolUse",
		cwd,
		timestamp: new Date().toISOString(),
		tool_name: "edit",
		tool_call_id: "call_1",
		tool_input: {
			file_path: "src/example.ts",
		},
		tool_output: "ok",
		is_error: false,
	};
}

describe("registerTestVerificationHooks", () => {
	beforeEach(() => {
		clearHookConfigCache();
		clearRegisteredHooks();
		resetGlobalAutoVerifyService();
		vi.unstubAllEnvs();
		vi.stubEnv("MAESTRO_AUTO_TEST", "true");
		vi.useRealTimers();
	});

	afterEach(() => {
		clearHookConfigCache();
		clearRegisteredHooks();
		resetGlobalAutoVerifyService();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	function createWorkspace(name: string): string {
		const cwd = join(tmpdir(), name);
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(join(cwd, "test"), { recursive: true });
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({
				devDependencies: {
					vitest: "^1.0.0",
				},
			}),
		);
		writeFileSync(join(cwd, "src/foo.ts"), "export const foo = 1;\n");
		writeFileSync(join(cwd, "test/foo.test.ts"), "it('works', () => {});\n");
		return cwd;
	}

	it("replaces prior auto-test hook registrations instead of duplicating them", () => {
		const cwd = "/tmp/maestro-test-verification";
		registerTestVerificationHooks(cwd);
		registerTestVerificationHooks(cwd);
		clearHookConfigCache();

		const config = loadHookConfiguration(cwd);
		const hooks = getMatchingHooks(config, createPostToolUseInput(cwd));

		expect(hooks).toHaveLength(1);
		expect(hooks[0]?.type).toBe("callback");
	});

	it("honors an explicit disabled override without registering hooks", () => {
		const cwd = "/tmp/maestro-test-verification-disabled";
		const service = registerTestVerificationHooks(cwd, {
			config: {
				enabled: false,
			},
		});
		clearHookConfigCache();

		const config = loadHookConfiguration(cwd);
		const hooks = getMatchingHooks(config, createPostToolUseInput(cwd));

		expect(service.getConfig().enabled).toBe(false);
		expect(hooks).toHaveLength(0);
	});

	it("stops the previous service when hooks are re-registered", async () => {
		vi.useFakeTimers();
		const cwd = createWorkspace("maestro-auto-test-reregister");
		const firstService = registerTestVerificationHooks(cwd, {
			config: {
				debounceDelayMs: 10,
				cooldownMs: 0,
			},
		});
		const firstRunTests = vi.spyOn(firstService, "runTests").mockResolvedValue({
			success: true,
			totalTests: 1,
			passedTests: 1,
			failedTests: 0,
			skippedTests: 0,
			durationMs: 1,
			failures: [],
			command: "bun test",
			output: "ok",
		});

		firstService.recordFileChange(join(cwd, "src/foo.ts"));
		registerTestVerificationHooks(cwd, {
			config: {
				debounceDelayMs: 10,
				cooldownMs: 0,
			},
		});

		await vi.advanceTimersByTimeAsync(10);

		expect(firstRunTests).not.toHaveBeenCalled();
		expect(firstService.getDirtyFiles()).toHaveLength(0);
	});

	it("stops the previous service when hooks are disabled", async () => {
		vi.useFakeTimers();
		const cwd = createWorkspace("maestro-auto-test-disable");
		const firstService = registerTestVerificationHooks(cwd, {
			config: {
				debounceDelayMs: 10,
				cooldownMs: 0,
			},
		});
		const firstRunTests = vi.spyOn(firstService, "runTests").mockResolvedValue({
			success: true,
			totalTests: 1,
			passedTests: 1,
			failedTests: 0,
			skippedTests: 0,
			durationMs: 1,
			failures: [],
			command: "bun test",
			output: "ok",
		});

		firstService.recordFileChange(join(cwd, "src/foo.ts"));
		registerTestVerificationHooks(cwd, {
			config: {
				enabled: false,
			},
		});

		await vi.advanceTimersByTimeAsync(10);

		expect(firstRunTests).not.toHaveBeenCalled();
		expect(firstService.getDirtyFiles()).toHaveLength(0);
	});
});
