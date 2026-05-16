import { describe, expect, it } from "vitest";
import {
	isA2AWaitCompletionState,
	parseA2AArgs,
} from "../../../src/cli/commands/a2a.js";

describe("A2A CLI command helpers", () => {
	it("preserves unknown -- tokens as message text", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"review",
			"--help",
			"and",
			"--dry-run",
		]);

		expect(parsed.positionals).toEqual([
			"send",
			"mac-mini",
			"review",
			"--help",
			"and",
			"--dry-run",
		]);
		expect(parsed.flags.has("--help")).toBe(false);
		expect(parsed.flags.has("--dry-run")).toBe(false);
	});

	it("preserves known option-looking text after an explicit delimiter", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"--",
			"--wait",
			"--timeout-ms=1000",
		]);

		expect(parsed.positionals).toEqual([
			"send",
			"mac-mini",
			"--wait",
			"--timeout-ms=1000",
		]);
		expect(parsed.flags.size).toBe(0);
	});

	it("still parses known send flags", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"ping",
			"--wait",
			"--work-graph",
			"--timeout-ms",
			"1000",
		]);

		expect(parsed.positionals).toEqual(["send", "mac-mini", "ping"]);
		expect(parsed.flags.get("--wait")).toBe(true);
		expect(parsed.flags.get("--work-graph")).toBe(true);
		expect(parsed.flags.get("--timeout-ms")).toBe("1000");
	});

	it("parses direct task output work graph flags", () => {
		const reply = parseA2AArgs([
			"reply",
			"mac-mini",
			"task-1",
			"use",
			"the",
			"short",
			"smoke",
			"--work-graph",
		]);
		expect(reply.positionals).toEqual([
			"reply",
			"mac-mini",
			"task-1",
			"use",
			"the",
			"short",
			"smoke",
		]);
		expect(reply.flags.get("--work-graph")).toBe(true);

		const wait = parseA2AArgs(["wait", "mac-mini", "task-1", "--work-graph"]);
		expect(wait.positionals).toEqual(["wait", "mac-mini", "task-1"]);
		expect(wait.flags.get("--work-graph")).toBe(true);
	});

	it("parses task reply flags without swallowing reply text", () => {
		const parsed = parseA2AArgs([
			"reply",
			"mac-mini",
			"task-1",
			"use",
			"--json",
			"--wait",
			"--tasks",
			"/tmp/tasks.json",
		]);

		expect(parsed.positionals).toEqual([
			"reply",
			"mac-mini",
			"task-1",
			"use",
			"--json",
		]);
		expect(parsed.flags.get("--wait")).toBe(true);
		expect(parsed.flags.get("--tasks")).toBe("/tmp/tasks.json");
	});

	it("scopes json and refresh flags to fleet task views", () => {
		const delegate = parseA2AArgs([
			"delegate",
			"mac-mini",
			"emit",
			"--json",
			"--refresh",
		]);
		expect(delegate.positionals).toEqual([
			"delegate",
			"mac-mini",
			"emit",
			"--json",
			"--refresh",
		]);
		expect(delegate.flags.size).toBe(0);

		const tasks = parseA2AArgs(["tasks", "--json", "--refresh"]);
		expect(tasks.positionals).toEqual(["tasks"]);
		expect(tasks.flags.get("--json")).toBe(true);
		expect(tasks.flags.get("--refresh")).toBe(true);

		const workGraph = parseA2AArgs(["tasks", "mac-mini", "--work-graph"]);
		expect(workGraph.positionals).toEqual(["tasks", "mac-mini"]);
		expect(workGraph.flags.get("--work-graph")).toBe(true);
	});

	it("parses coordinate flags without swallowing reply text", () => {
		const parsed = parseA2AArgs([
			"coordinate",
			"mac-mini",
			"--refresh",
			"--reply",
			"use",
			"the",
			"short",
			"smoke",
			"--wait",
			"--json",
			"--tasks",
			"/tmp/tasks.json",
		]);

		expect(parsed.positionals).toEqual(["coordinate", "mac-mini"]);
		expect(parsed.flags.get("--refresh")).toBe(true);
		expect(parsed.flags.get("--reply")).toBe("use the short smoke");
		expect(parsed.flags.get("--wait")).toBe(true);
		expect(parsed.flags.get("--json")).toBe(true);
		expect(parsed.flags.get("--tasks")).toBe("/tmp/tasks.json");
	});

	it("rejects coordinate reply flags without reply text", () => {
		expect(() =>
			parseA2AArgs(["coordinate", "mac-mini", "--reply", "--wait"]),
		).toThrow("--reply requires text");
		expect(() => parseA2AArgs(["coordinate", "mac-mini", "--reply="])).toThrow(
			"Usage: maestro a2a coordinate [peer] --reply <text> [--wait]",
		);
	});

	it("parses leading flags after locating the subcommand", () => {
		const parsed = parseA2AArgs(["--registry", "/tmp/peers.json", "peers"]);

		expect(parsed.positionals).toEqual(["peers"]);
		expect(parsed.flags.get("--registry")).toBe("/tmp/peers.json");
	});

	it("ignores leading flags from other subcommands during dispatch", () => {
		const delegate = parseA2AArgs([
			"--json",
			"delegate",
			"mac-mini",
			"do",
			"stuff",
		]);

		expect(delegate.positionals).toEqual([
			"delegate",
			"mac-mini",
			"do",
			"stuff",
		]);
		expect(delegate.flags.size).toBe(0);

		const peers = parseA2AArgs(["--timeout-ms", "1000", "peers"]);
		expect(peers.positionals).toEqual(["peers"]);
		expect(peers.flags.size).toBe(0);
	});

	it("treats actionable A2A states as wait completion", () => {
		expect(isA2AWaitCompletionState("completed")).toBe(true);
		expect(isA2AWaitCompletionState("input-required")).toBe(true);
		expect(isA2AWaitCompletionState("AUTH_REQUIRED")).toBe(true);
		expect(isA2AWaitCompletionState("working")).toBe(false);
		expect(isA2AWaitCompletionState("submitted")).toBe(false);
	});
});
