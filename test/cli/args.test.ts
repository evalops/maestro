import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";

describe("parseArgs", () => {
	it("parses --task-budget as a positive integer", () => {
		expect(parseArgs(["--task-budget", "500000"]).taskBudget).toBe(500000);
	});

	it("rejects invalid task budgets", () => {
		expect(parseArgs(["--task-budget", "0"]).error).toBe(
			"--task-budget must be a positive integer",
		);
		expect(parseArgs(["--task-budget", "-10"]).error).toBe(
			"--task-budget must be a positive integer",
		);
		expect(parseArgs(["--task-budget", "1.5"]).error).toBe(
			"--task-budget must be a positive integer",
		);
		expect(parseArgs(["--task-budget", "not-a-number"]).error).toBe(
			"--task-budget must be a positive integer",
		);
	});

	it("rejects missing task-budget values", () => {
		expect(parseArgs(["--task-budget"]).error).toBe(
			"--task-budget requires a value",
		);
		expect(parseArgs(["--task-budget", "--model", "test"]).error).toBe(
			"--task-budget requires a value",
		);
	});

	it("treats --mode headless forms as headless invocations", () => {
		expect(parseArgs(["--mode", "headless"])).toMatchObject({
			mode: "headless",
			headless: true,
		});
		expect(parseArgs(["--mode=headless"])).toMatchObject({
			mode: "headless",
			headless: true,
		});
	});

	it("parses hidden support discovery flags", () => {
		expect(parseArgs(["--help-hidden"])).toMatchObject({
			help: true,
			helpHidden: true,
		});
		expect(parseArgs(["--help-all"])).toMatchObject({
			help: true,
			helpHidden: true,
		});
		expect(parseArgs(["--list-modes-all"])).toMatchObject({
			listModesAll: true,
		});
	});

	it("rejects unknown CLI flags before they become support surfaces", () => {
		expect(parseArgs(["--headless", "--legacy-runtime"])).toMatchObject({
			headless: true,
			mode: "headless",
			error: "Unknown option: --legacy-runtime",
		});
		expect(parseArgs(["--experimental-runtime"]).error).toBe(
			"Unknown option: --experimental-runtime",
		);
	});

	it("does not consume command tokens after deprecated value flags", () => {
		expect(parseArgs(["--codex-api-key"]).error).toBeUndefined();
		expect(parseArgs(["--codex-api-key", "--help"])).toMatchObject({
			help: true,
		});
		expect(parseArgs(["--codex-api-key", "config", "show"])).toMatchObject({
			command: "config",
			subcommand: "show",
		});
	});

	it("preserves config init preset flags for the config handler", () => {
		const longForm = parseArgs(["config", "init", "--preset", "evalops"]);
		expect(longForm).toMatchObject({
			command: "config",
			subcommand: "init",
			messages: [],
		});
		expect(longForm.error).toBeUndefined();

		const shortForm = parseArgs(["config", "init", "-p", "local"]);
		expect(shortForm).toMatchObject({
			command: "config",
			subcommand: "init",
			messages: [],
		});
		expect(shortForm.error).toBeUndefined();
	});

	it("still rejects unknown config init flags", () => {
		expect(parseArgs(["config", "init", "--unknown"]).error).toBe(
			"Unknown option: --unknown",
		);
		expect(parseArgs(["config", "init", "--preset=local"]).error).toBe(
			"Unknown option: --preset=local",
		);
	});

	it("parses export commands and formats", () => {
		expect(
			parseArgs([
				"export",
				"session-123",
				"./session.json",
				"--format",
				"json",
				"--redact-secrets",
			]),
		).toMatchObject({
			command: "export",
			messages: ["session-123", "./session.json"],
			exportFormat: "json",
			redactSecrets: true,
		});
	});

	it("parses import commands", () => {
		expect(parseArgs(["import", "./session.jsonl"])).toMatchObject({
			command: "import",
			messages: ["./session.jsonl"],
		});
	});

	it("preserves remote command-group arguments for the remote handler", () => {
		expect(
			parseArgs([
				"remote",
				"start",
				"--workspace",
				"ws_123",
				"--repo",
				"evalops/foo",
				"--json",
			]),
		).toMatchObject({
			command: "remote",
			subcommand: "start",
			commandArgs: ["--workspace", "ws_123", "--repo", "evalops/foo", "--json"],
			messages: [],
		});
	});

	it("preserves a2a command-group arguments for the native peer handler", () => {
		expect(
			parseArgs([
				"a2a",
				"accept",
				"maestro-pair-v1.payload.checksum",
				"--name",
				"mac-mini",
				"--default",
			]),
		).toMatchObject({
			command: "a2a",
			commandArgs: [
				"accept",
				"maestro-pair-v1.payload.checksum",
				"--name",
				"mac-mini",
				"--default",
			],
			messages: [],
		});
	});

	it("preserves operating-plane command-group arguments for operator lookups", () => {
		expect(
			parseArgs([
				"operating-plane",
				"status",
				"--thread-id",
				"C123:1740000000.000100",
				"--evidence-id",
				"gateway:req_123",
				"--json",
			]),
		).toMatchObject({
			command: "operating-plane",
			commandArgs: [
				"status",
				"--thread-id",
				"C123:1740000000.000100",
				"--evidence-id",
				"gateway:req_123",
				"--json",
			],
			messages: [],
		});
	});

	it("preserves hosted-runner arguments for the hosted entrypoint", () => {
		expect(
			parseArgs([
				"hosted-runner",
				"--runner-session-id",
				"mrs_123",
				"--workspace-root",
				"/workspace",
				"--listen",
				"0.0.0.0:8080",
			]),
		).toMatchObject({
			command: "hosted-runner",
			commandArgs: [
				"--runner-session-id",
				"mrs_123",
				"--workspace-root",
				"/workspace",
				"--listen",
				"0.0.0.0:8080",
			],
			messages: [],
		});
	});

	it("parses stats commands", () => {
		expect(parseArgs(["stats"])).toMatchObject({
			command: "stats",
		});
		expect(parseArgs(["stats", "month"])).toMatchObject({
			command: "stats",
			subcommand: "month",
		});
		expect(parseArgs(["stats", "--session", "session-123"])).toMatchObject({
			command: "stats",
			session: "session-123",
		});
	});

	it("parses context explain commands", () => {
		expect(parseArgs(["context", "explain", "/repo", "--json"])).toMatchObject({
			command: "context",
			subcommand: "explain",
			messages: ["/repo"],
			execJson: true,
		});
	});

	it("parses context path commands without requiring explain", () => {
		const parsed = parseArgs(["context", "/repo", "--json"]);
		expect(parsed).toMatchObject({
			command: "context",
			messages: ["/repo"],
			execJson: true,
		});
		expect(parsed.subcommand).toBeUndefined();
	});

	it("parses context diff commands and live MCP discovery", () => {
		expect(
			parseArgs([
				"context",
				"diff",
				"/before",
				"/after",
				"--json",
				"--live-mcp",
			]),
		).toMatchObject({
			command: "context",
			subcommand: "diff",
			messages: ["/before", "/after"],
			execJson: true,
			contextLiveMcp: true,
		});
	});

	it("only treats run as a command for known run subcommands", () => {
		expect(
			parseArgs(["run", "inspect", "session-123", "--json"]),
		).toMatchObject({
			command: "run",
			subcommand: "inspect",
			messages: ["session-123"],
			execJson: true,
		});
		expect(parseArgs(["run", "tests", "and", "fix", "failures"])).toMatchObject(
			{
				messages: ["run", "tests", "and", "fix", "failures"],
			},
		);
		expect(
			parseArgs(["run", "tests", "and", "fix", "failures"]).command,
		).toBeUndefined();
		expect(parseArgs(["please", "run", "inspect", "my", "logs"])).toMatchObject(
			{
				messages: ["please", "run", "inspect", "my", "logs"],
			},
		);
		expect(
			parseArgs(["please", "run", "inspect", "my", "logs"]).command,
		).toBeUndefined();
		expect(
			parseArgs(["run", "--json", "inspect", "session-123"]),
		).toMatchObject({
			command: "run",
			subcommand: "inspect",
			messages: ["session-123"],
			execJson: true,
		});
		for (const subcommand of ["ledger", "replay", "promote"] as const) {
			expect(
				parseArgs(["run", "--json", subcommand, "session-123"]),
			).toMatchObject({
				command: "run",
				subcommand,
				messages: ["session-123"],
				execJson: true,
			});
		}
		expect(
			parseArgs([
				"run",
				"--profile",
				"local",
				"--json",
				"inspect",
				"session-123",
			]),
		).toMatchObject({
			command: "run",
			subcommand: "inspect",
			profile: "local",
			messages: ["session-123"],
			execJson: true,
		});
	});

	it("parses public scenario replay commands", () => {
		expect(
			parseArgs([
				"scenario",
				"run",
				"evals/internal/complex-task-gauntlet.json",
			]),
		).toMatchObject({
			command: "scenario",
			subcommand: "run",
			messages: ["evals/internal/complex-task-gauntlet.json"],
		});
		expect(parseArgs(["--replay", "scenario.json"])).toMatchObject({
			replayScenarioPath: "scenario.json",
			messages: [],
		});
		expect(parseArgs(["--record-scenario", "recorded.json"])).toMatchObject({
			recordScenarioPath: "recorded.json",
			messages: [],
		});
	});

	it("keeps --junit out of prompt messages", () => {
		expect(
			parseArgs(["--junit", "./tmp/scenario.xml", "fix", "the", "bug"]),
		).toMatchObject({
			junitPath: "./tmp/scenario.xml",
			messages: ["fix", "the", "bug"],
		});
	});

	it("parses evalops auth commands", () => {
		expect(parseArgs(["evalops", "login"])).toMatchObject({
			command: "evalops",
			subcommand: "login",
			commandArgs: [],
			messages: [],
		});
		expect(parseArgs(["evalops", "status"])).toMatchObject({
			command: "evalops",
			subcommand: "status",
			commandArgs: [],
			messages: [],
		});
	});

	it("preserves codex login flags for the codex handler", () => {
		expect(parseArgs(["codex", "login", "--device"])).toMatchObject({
			command: "codex",
			subcommand: "login",
			commandArgs: ["--device"],
			messages: [],
		});
		expect(parseArgs(["codex", "login", "--device-code"])).toMatchObject({
			command: "codex",
			subcommand: "login",
			commandArgs: ["--device-code"],
			messages: [],
		});
	});

	it("preserves evalops init bootstrap arguments for the init handler", () => {
		expect(
			parseArgs([
				"evalops",
				"init",
				"--mcp-url",
				"https://app.evalops.dev",
				"--rotate-key",
			]),
		).toMatchObject({
			command: "evalops",
			subcommand: "init",
			commandArgs: ["--mcp-url", "https://app.evalops.dev", "--rotate-key"],
			messages: [],
		});
	});

	it("preserves maestro init bootstrap arguments for the init handler", () => {
		expect(
			parseArgs([
				"init",
				"--mcp-url",
				"https://app.evalops.dev",
				"--rotate-key",
				"--json",
			]),
		).toMatchObject({
			command: "init",
			commandArgs: [
				"--mcp-url",
				"https://app.evalops.dev",
				"--rotate-key",
				"--json",
			],
			messages: [],
		});
	});
});
