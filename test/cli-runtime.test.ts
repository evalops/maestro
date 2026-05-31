import { describe, expect, it } from "vitest";
import {
	getDirectRuntimeCommand,
	getRuntimeCommand,
	shouldAttemptDirectRuntimeDispatch,
	shouldUseUnbundledMainRuntime,
} from "../src/cli/direct-runtime-command.js";

describe("cli-runtime direct command dispatch", () => {
	it("detects early commands after global options", () => {
		expect(getDirectRuntimeCommand(["skill", "--help"])).toBe("skill");
		expect(
			getDirectRuntimeCommand([
				"--profile",
				"local",
				"--model",
				"gpt-5",
				"update",
				"--help",
			]),
		).toBe("update");
	});

	it("does not treat prompt text or global-help commands as the direct dispatch path", () => {
		expect(getDirectRuntimeCommand(["write", "a", "skill"])).toBeNull();
		expect(getDirectRuntimeCommand(["a2a", "--help"])).toBeNull();
		expect(getDirectRuntimeCommand(["context", "--help"])).toBeNull();
		expect(getDirectRuntimeCommand(["status", "--help"])).toBeNull();
	});

	it("detects exec as the unbundled package main runtime path", () => {
		expect(getRuntimeCommand(["exec", "--json", "Plan work"])).toBe("exec");
		expect(
			getRuntimeCommand([
				"--profile",
				"local",
				"--model",
				"gpt-5",
				"exec",
				"--json",
				"Plan work",
			]),
		).toBe("exec");
		expect(shouldUseUnbundledMainRuntime(["exec", "--json"])).toBe(true);
		expect(shouldUseUnbundledMainRuntime(["skill", "--help"])).toBe(false);
		expect(shouldUseUnbundledMainRuntime(["write", "exec docs"])).toBe(false);
	});

	it("falls back to the full runtime when startup telemetry is configured", () => {
		expect(
			shouldAttemptDirectRuntimeDispatch(["skill", "--help"], {
				MAESTRO_BEACON_FILE: "/tmp/maestro-beacon.jsonl",
			}),
		).toBe(false);
		expect(
			shouldAttemptDirectRuntimeDispatch(["skill", "--help"], {
				MAESTRO_TELEMETRY_ENDPOINT: "https://telemetry.example.test",
			}),
		).toBe(false);
		expect(shouldAttemptDirectRuntimeDispatch(["skill", "--help"], {})).toBe(
			true,
		);
	});

	it("falls back to the full runtime for retired auth flags", () => {
		expect(
			shouldAttemptDirectRuntimeDispatch(
				["hosted-runner", "--codex-api-key", "token"],
				{},
			),
		).toBe(false);
		expect(
			shouldAttemptDirectRuntimeDispatch(
				["skill", "--codex-api-key=token"],
				{},
			),
		).toBe(false);
		expect(
			shouldAttemptDirectRuntimeDispatch(["update", "--auth", "chatgpt"], {}),
		).toBe(false);
		expect(
			shouldAttemptDirectRuntimeDispatch(["init", "--auth=claude"], {}),
		).toBe(false);
		expect(shouldAttemptDirectRuntimeDispatch(["skill", "--help"], {})).toBe(
			true,
		);
	});
});
