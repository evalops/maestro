import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class EpipeStdin extends Writable {
	override _write(
		_chunk: Buffer | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		const err = new Error("write EPIPE") as Error & { code?: string };
		err.code = "EPIPE";
		callback(err);
		queueMicrotask(() => this.emit("error", err));
	}
}

describe("inline tool execution (EPIPE)", () => {
	let testDir: string;
	let composerDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `inline-tools-epipe-${Date.now()}`);
		composerDir = join(testDir, ".composer");
		mkdirSync(composerDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		vi.resetModules();
		vi.unmock("node:child_process");
	});

	it("ignores stdin EPIPE when the child exits immediately", async () => {
		vi.mock("node:child_process", () => {
			return {
				spawn: () => {
					const child = new EventEmitter() as unknown as {
						stdout: PassThrough;
						stderr: PassThrough;
						stdin: EpipeStdin;
						kill: (signal?: string) => boolean;
						on: (event: string, listener: (...args: unknown[]) => void) => void;
					};
					child.stdout = new PassThrough();
					child.stderr = new PassThrough();
					child.stdin = new EpipeStdin();
					child.kill = () => true;

					queueMicrotask(() => {
						(child as unknown as EventEmitter).emit("close", 1);
					});

					return child;
				},
			};
		});

		const config = {
			tools: [
				{
					name: "fail_fast",
					description: "Exits immediately",
					command: "exit 1",
				},
			],
		};
		writeFileSync(join(composerDir, "tools.json"), JSON.stringify(config));

		const { loadInlineTools } = await import("../../src/tools/inline-tools.js");
		const tools = loadInlineTools(testDir);
		expect(tools).toHaveLength(1);

		const result = await tools[0]!.execute("test-call", {});
		expect(result.isError).toBe(true);
	});
});
