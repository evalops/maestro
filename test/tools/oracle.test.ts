import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getRegisteredModelsMock, spawnMock } = vi.hoisted(() => ({
	getRegisteredModelsMock: vi.fn(() => [{ id: "o3-mini", reasoning: true }]),
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

vi.mock("../../src/models/registry.js", () => ({
	getRegisteredModels: getRegisteredModelsMock,
}));

import { oracleTool } from "../../src/tools/oracle.js";

function createMockChildProcess(output: string) {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
		kill: ReturnType<typeof vi.fn>;
	};
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = 4242;
	proc.kill = vi.fn();

	queueMicrotask(() => {
		proc.stdout.emit("data", Buffer.from(output));
		proc.emit("close", 0);
	});

	return proc;
}

describe("oracleTool", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		getRegisteredModelsMock.mockClear();
	});

	it("spawns the maestro CLI for seer runs", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("Foreseen."));

		const result = await oracleTool.execute("oracle-call", {
			task: "Review the architecture",
		});

		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.arrayContaining([
				"--read-only",
				"--tools",
				expect.any(String),
				"--model",
				"o3-mini",
				"--no-session",
				"exec",
				expect.stringContaining("seer-"),
			]),
			expect.objectContaining({
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
		expect(result.content).toEqual([{ type: "text", text: "Foreseen." }]);
	});
});
