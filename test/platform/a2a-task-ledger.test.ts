import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getA2ATaskLedgerPath,
	loadA2ATaskLedger,
	recordA2ATaskStart,
	updateA2ATaskInLedger,
} from "../../src/platform/a2a-task-ledger.js";

const NOW = new Date("2026-05-16T00:00:00.000Z");
const LATER = new Date("2026-05-16T00:01:00.000Z");

describe("A2A task ledger", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("records delegated task transcripts using the migration env alias", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-")),
			"tasks.json",
		);
		vi.stubEnv("CODEX_A2A_TASKS_FILE", path);

		await recordA2ATaskStart({
			peer: "dev-desktop",
			task: {
				id: "task-dev-1",
				status: { state: "TASK_STATE_SUBMITTED" },
			},
			text: "run the full checks",
			messageId: "message-1",
			kind: "delegation",
			role: "heavy-builder",
			cwd: "/repo",
			now: NOW,
		});
		await updateA2ATaskInLedger({
			peer: "dev-desktop",
			task: {
				id: "task-dev-1",
				status: {
					state: "TASK_STATE_COMPLETED",
					message: {
						messageId: "agent-message-1",
						role: "ROLE_AGENT",
						parts: [{ text: "checks passed", mediaType: "text/plain" }],
					},
				},
			},
			now: LATER,
		});

		expect(getA2ATaskLedgerPath()).toBe(path);
		await expect(loadA2ATaskLedger()).resolves.toMatchObject({
			tasks: [
				{
					peer: "dev-desktop",
					taskId: "task-dev-1",
					state: "TASK_STATE_COMPLETED",
					responseText: "checks passed",
					transcript: [
						{ role: "user", text: "run the full checks" },
						{ role: "agent", text: "checks passed" },
					],
				},
			],
		});
		const raw = await readFile(path, "utf8");
		expect(raw).toContain("heavy-builder");
		expect(raw).not.toContain("Bearer ");
	});

	it("does not treat echoed user history as agent response text", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-history-")),
			"tasks.json",
		);

		const result = await recordA2ATaskStart({
			path,
			peer: "mac-mini",
			task: {
				id: "task-mac-1",
				status: { state: "TASK_STATE_SUBMITTED" },
				history: [
					{
						messageId: "message-1",
						role: "ROLE_USER",
						parts: [{ text: "run --json checks", mediaType: "text/plain" }],
					},
				],
			},
			text: "run --json checks",
			now: NOW,
		});

		expect(result.entry.responseText).toBeUndefined();
		expect(result.entry.transcript).toEqual([
			expect.objectContaining({
				role: "user",
				text: "run --json checks",
			}),
		]);
	});
	it("rejects array-shaped ledger files instead of treating them as empty", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "maestro-a2a-ledger-array-")),
			"tasks.json",
		);
		await writeFile(path, "[]\n", "utf8");

		await expect(loadA2ATaskLedger({ path })).rejects.toThrow(
			`A2A task ledger at ${path} must be a JSON object`,
		);
		await expect(readFile(path, "utf8")).resolves.toBe("[]\n");
	});
});
