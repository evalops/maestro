import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../../src/rpc/rpc-client.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

function createFakeProcess() {
	const process = new EventEmitter() as EventEmitter & {
		stdin: PassThrough;
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	process.stdin = new PassThrough();
	process.stdout = new PassThrough();
	process.stderr = new PassThrough();
	process.kill = vi.fn();
	return process;
}

describe("RpcClient", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		spawnMock.mockReturnValue(createFakeProcess());
	});

	it("defaults to the maestro CLI binary", () => {
		const client = new RpcClient();
		const internals = client as unknown as {
			options: { cliPath: string };
		};

		expect(internals.options.cliPath).toBe("maestro");
		expect(internals.options.cliPath).not.toBe("composer");
	});

	it("preserves custom CLI path overrides", () => {
		const client = new RpcClient({ cliPath: "/usr/local/bin/maestro-dev" });
		const internals = client as unknown as {
			options: { cliPath: string };
		};

		expect(internals.options.cliPath).toBe("/usr/local/bin/maestro-dev");
	});

	it("starts Maestro in the public rpc mode", async () => {
		const client = new RpcClient({ cwd: "/tmp/maestro-rpc-test" });

		await client.start();

		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			["--mode", "rpc"],
			expect.objectContaining({
				cwd: "/tmp/maestro-rpc-test",
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
		client.stop();
	});
});
