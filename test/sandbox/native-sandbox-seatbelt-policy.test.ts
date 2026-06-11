import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: spawnMock,
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) =>
			String(path) === "/usr/bin/sandbox-exec" ? true : actual.existsSync(path),
		),
	};
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		platform: () => "darwin",
	};
});

import { createNativeSandbox } from "../../src/sandbox/native-sandbox.js";

function createMockChildProcess(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	child.stdout = new EventEmitter() as ChildProcess["stdout"];
	child.stderr = new EventEmitter() as ChildProcess["stderr"];
	child.kill = vi.fn(() => true);
	queueMicrotask(() => child.emit("close", 0));
	return child;
}

describe("native sandbox Seatbelt policy generation", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		spawnMock.mockImplementation(() => createMockChildProcess());
	});

	it("places denyRead rules after the blanket file-read allow", async () => {
		const sandbox = createNativeSandbox(
			{ mode: "workspace-write", denyRead: ["secret.txt"] },
			"/workspace",
		);
		await sandbox.initialize();

		await sandbox.exec("cat secret.txt");

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const seatbeltArgs = spawnMock.mock.calls[0]?.[1];
		expect(Array.isArray(seatbeltArgs)).toBe(true);
		const policy = seatbeltArgs?.[1];
		expect(typeof policy).toBe("string");

		const blanketReadAllowIndex = policy.indexOf(
			"; allow read-only file operations\n(allow file-read*)",
		);
		const denyReadIndex = policy.indexOf("(deny file-read*\n");

		expect(blanketReadAllowIndex).toBeGreaterThan(-1);
		expect(denyReadIndex).toBeGreaterThan(blanketReadAllowIndex);

		await sandbox.dispose();
	});
});
