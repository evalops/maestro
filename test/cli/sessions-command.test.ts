import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleExportCommand,
	handleImportCommand,
} from "../../src/cli/commands/session-transfer.js";
import { handleSessionsCommand } from "../../src/cli/commands/sessions.js";

vi.mock("../../src/cli/commands/session-transfer.js", () => ({
	handleExportCommand: vi.fn(),
	handleImportCommand: vi.fn(),
}));

function scopedSessionDir(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safePath);
}

function writeSession(
	sessionDir: string,
	options: {
		id: string;
		prompt: string;
		summary?: string;
		tags?: string[];
	},
): void {
	const timestamp = "2026-05-30T12:00:00.000Z";
	const entries = [
		{
			type: "session",
			version: 2,
			id: options.id,
			timestamp,
			cwd: process.cwd(),
			model: "openai-codex/gpt-5.5",
		},
		{
			type: "message",
			id: `${options.id}-user`,
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: options.prompt }],
				timestamp: Date.parse(timestamp),
			},
		},
		{
			type: "session_meta",
			timestamp,
			summary: options.summary,
			tags: options.tags,
		},
	];
	writeFileSync(
		join(sessionDir, `${options.id}.jsonl`),
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
}

describe("sessions command", () => {
	let testDir: string;
	let originalAgentDir: string | undefined;
	let originalCwd: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `maestro-sessions-command-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		originalCwd = process.cwd();
		originalAgentDir = process.env.MAESTRO_AGENT_DIR;
		process.env.MAESTRO_AGENT_DIR = testDir;
		process.chdir(testDir);
		mkdirSync(scopedSessionDir(process.cwd(), testDir), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_AGENT_DIR");
		} else {
			process.env.MAESTRO_AGENT_DIR = originalAgentDir;
		}
		vi.clearAllMocks();
		vi.restoreAllMocks();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("prints recent sessions as JSON", async () => {
		writeSession(scopedSessionDir(process.cwd(), testDir), {
			id: "session-one",
			prompt: "Audit startup update UX",
			summary: "Startup update UX audit",
			tags: ["cli"],
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleSessionsCommand("list", [], { json: true });

		const payload = JSON.parse(log.mock.calls[0]?.[0] as string) as {
			sessions: Array<{ id: string; summary?: string; tags?: string[] }>;
		};
		expect(payload.sessions).toHaveLength(1);
		expect(payload.sessions[0]).toMatchObject({
			id: "session-one",
			summary: "Startup update UX audit",
			tags: ["cli"],
		});
	});

	it("searches saved session text", async () => {
		writeSession(scopedSessionDir(process.cwd(), testDir), {
			id: "session-release",
			prompt: "Release verification affordances and failure recovery",
			summary: "Release verification",
		});
		writeSession(scopedSessionDir(process.cwd(), testDir), {
			id: "session-unrelated",
			prompt: "Model picker polish",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleSessionsCommand("search", ["failure", "recovery"], {
			json: true,
		});

		const payload = JSON.parse(log.mock.calls[0]?.[0] as string) as {
			sessions: Array<{ id: string }>;
		};
		expect(payload.sessions.map((session) => session.id)).toEqual([
			"session-release",
		]);
	});

	it("delegates export and import to the existing transfer commands", async () => {
		await handleSessionsCommand("export", ["session-one", "./session.json"], {
			format: "json",
			redactSecrets: true,
		});
		await handleSessionsCommand("import", ["./session.json"], {});

		expect(handleExportCommand).toHaveBeenCalledWith(
			"session-one",
			"./session.json",
			"json",
			{ redactSecrets: true },
		);
		expect(handleImportCommand).toHaveBeenCalledWith("./session.json");
	});
});
