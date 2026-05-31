import { describe, expect, it } from "vitest";
import {
	getImmediateCliExit,
	isStartupTelemetryRequested,
	shouldUseInstantCliExit,
} from "../../src/cli/instant-exit.js";

describe("instant CLI exits", () => {
	it("detects global help flags", () => {
		expect(getImmediateCliExit(["--help"])).toEqual({
			kind: "help",
			includeHidden: false,
		});
		expect(getImmediateCliExit(["codex", "doctor", "-h"])).toEqual({
			kind: "help",
			includeHidden: false,
		});
	});

	it("detects hidden help flags", () => {
		expect(getImmediateCliExit(["--help-hidden"])).toEqual({
			kind: "help",
			includeHidden: true,
		});
		expect(getImmediateCliExit(["--help-all"])).toEqual({
			kind: "help",
			includeHidden: true,
		});
	});

	it("keeps version precedence when help is also present", () => {
		expect(getImmediateCliExit(["--help", "--version"])).toEqual({
			kind: "version",
		});
	});

	it("ignores non-immediate invocations", () => {
		expect(getImmediateCliExit(["models", "providers"])).toBeNull();
		expect(getImmediateCliExit(["audit this repo"])).toBeNull();
	});

	it("leaves a2a help with the dedicated command handler", () => {
		expect(getImmediateCliExit(["a2a", "--help"])).toBeNull();
	});

	it("leaves a2a version-looking payloads with the dedicated command handler", () => {
		expect(
			getImmediateCliExit(["a2a", "send", "peer", "--version"]),
		).toBeNull();
		expect(getImmediateCliExit(["a2a", "send", "peer", "-v"])).toBeNull();
	});

	it("leaves pass-through command help with dedicated command handlers", () => {
		for (const command of [
			"evalops",
			"hosted-runner",
			"init",
			"operating-plane",
			"remote",
			"skill",
			"update",
		]) {
			expect(getImmediateCliExit([command, "--help"])).toBeNull();
			expect(getImmediateCliExit([command, "-h"])).toBeNull();
		}
	});

	it("leaves pass-through command version flags with dedicated command handlers", () => {
		for (const command of [
			"evalops",
			"hosted-runner",
			"init",
			"operating-plane",
			"remote",
			"skill",
			"update",
		]) {
			expect(getImmediateCliExit([command, "--version"])).toBeNull();
			expect(getImmediateCliExit([command, "-v"])).toBeNull();
		}
	});

	it("keeps global help instant when help appears before a command token", () => {
		expect(getImmediateCliExit(["--help", "skill"])).toEqual({
			kind: "help",
			includeHidden: false,
		});
		expect(getImmediateCliExit(["--help-hidden", "remote"])).toEqual({
			kind: "help",
			includeHidden: true,
		});
	});

	it("keeps global version instant when version appears before a command token", () => {
		expect(getImmediateCliExit(["--version", "a2a"])).toEqual({
			kind: "version",
		});
	});

	it("does not treat value-bearing option values as instant flags", () => {
		expect(
			getImmediateCliExit(["--system-prompt", "--help", "summarize"]),
		).toBeNull();
		expect(
			getImmediateCliExit(["--append-system-prompt", "--version", "summarize"]),
		).toBeNull();
		expect(
			getImmediateCliExit([
				"--profile",
				"skill",
				"--append-system-prompt",
				"--help",
				"task",
			]),
		).toBeNull();
	});

	it("keeps global help instant after value-bearing global options", () => {
		expect(getImmediateCliExit(["--profile", "skill", "--help"])).toEqual({
			kind: "help",
			includeHidden: false,
		});
	});

	it("uses the instant path unless startup telemetry is explicitly requested", () => {
		const exit = getImmediateCliExit(["--version"]);
		expect(shouldUseInstantCliExit(exit, {})).toBe(true);
		expect(shouldUseInstantCliExit(exit, { MAESTRO_TELEMETRY: "1" })).toBe(
			false,
		);
		expect(
			shouldUseInstantCliExit(exit, {
				MAESTRO_TELEMETRY: "1",
				MAESTRO_INTERNAL_TELEMETRY_DISABLED: "1",
			}),
		).toBe(true);
	});

	it("recognizes Playwright-compatible startup telemetry flags", () => {
		expect(isStartupTelemetryRequested({ PLAYWRIGHT_TELEMETRY: "true" })).toBe(
			true,
		);
		expect(
			isStartupTelemetryRequested({
				PLAYWRIGHT_TELEMETRY: "true",
				EVALOPS_INTERNAL_TELEMETRY_DISABLED: "yes",
			}),
		).toBe(false);
	});

	it("recognizes beacon destinations as startup telemetry requests", () => {
		expect(
			isStartupTelemetryRequested({
				MAESTRO_BEACON_ENDPOINT: "https://t.test",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_TELEMETRY_ENDPOINT: "https://t.test",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				PLAYWRIGHT_TELEMETRY_ENDPOINT: "https://t.test",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({ MAESTRO_BEACON_FILE: "/tmp/t.jsonl" }),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_TELEMETRY_FILE: "/tmp/telemetry.jsonl",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				PLAYWRIGHT_TELEMETRY_FILE: "/tmp/telemetry.jsonl",
			}),
		).toBe(true);
	});

	it("recognizes remote meter destinations as startup telemetry requests", () => {
		expect(
			isStartupTelemetryRequested({
				MAESTRO_METER_BASE: "https://meter.test",
				MAESTRO_METER_ORGANIZATION_ID: "org_123",
				MAESTRO_METER_ACCESS_TOKEN: "token",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_METER_SERVICE_URL: "https://meter.test",
				EVALOPS_ORG_ID: "org_123",
				EVALOPS_TOKEN: "token",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_METER_BASE: "https://meter.test",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_METER_ACCESS_TOKEN: "token",
			}),
		).toBe(false);
	});

	it("recognizes event bus destinations as startup telemetry requests", () => {
		expect(
			isStartupTelemetryRequested({
				MAESTRO_EVENT_BUS_URL: "nats://bus.test:4222",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				EVALOPS_NATS_URL: "nats://bus.test:4222",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				NATS_URL: "nats://bus.test:4222",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_EVENT_BUS_URL: "nats://bus.test:4222",
				MAESTRO_TELEMETRY_SAMPLE: "0",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_EVENT_BUS_URL: "nats://bus.test:4222",
				MAESTRO_TELEMETRY: "0",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_EVENT_BUS_URL: "nats://bus.test:4222",
				MAESTRO_EVENT_BUS: "false",
				MAESTRO_TELEMETRY_SAMPLE: "0",
			}),
		).toBe(false);
	});

	it("recognizes managed EvalOps event bus routing as startup telemetry", () => {
		expect(
			isStartupTelemetryRequested({
				EVALOPS_TOKEN: "token",
				MAESTRO_REMOTE_RUNNER_ORG_ID: "org_123",
				MAESTRO_AGENT_ID: "agent_123",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				MAESTRO_EVALOPS_ACCESS_TOKEN: "token",
				MAESTRO_LLM_GATEWAY_ORG_ID: "org_123",
				MAESTRO_AGENT_RUN_ID: "run_123",
			}),
		).toBe(true);
		expect(
			isStartupTelemetryRequested({
				EVALOPS_TOKEN: "token",
				MAESTRO_REMOTE_RUNNER_ORG_ID: "org_123",
			}),
		).toBe(false);
		expect(
			isStartupTelemetryRequested({
				EVALOPS_TOKEN: "token",
				MAESTRO_REMOTE_RUNNER_ORG_ID: "org_123",
				MAESTRO_AGENT_ID: "agent_123",
				MAESTRO_EVENT_BUS: "0",
			}),
		).toBe(false);
	});

	it("allows instant exits when beacon destinations are explicitly disabled", () => {
		const exit = getImmediateCliExit(["--version"]);
		expect(
			shouldUseInstantCliExit(exit, {
				MAESTRO_BEACON_ENDPOINT: "https://t.test",
				MAESTRO_TELEMETRY: "0",
			}),
		).toBe(true);
		expect(
			shouldUseInstantCliExit(exit, {
				MAESTRO_BEACON_FILE: "/tmp/t.jsonl",
				MAESTRO_TELEMETRY_SAMPLE: "0",
			}),
		).toBe(true);
	});
});
