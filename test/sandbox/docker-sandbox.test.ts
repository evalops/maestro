import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
	exec: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMock);

import { DockerSandbox } from "../../src/sandbox/docker-sandbox.js";

type MockChildProcess = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
};

function createMockChildProcess(): MockChildProcess {
	const child = new EventEmitter() as MockChildProcess;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	const stdin = new EventEmitter() as MockChildProcess["stdin"];
	stdin.end = vi.fn();
	child.stdin = stdin;
	return child;
}

describe("DockerSandbox", () => {
	beforeEach(() => {
		childProcessMock.exec.mockReset();
		childProcessMock.spawn.mockReset();
	});

	it("caps execWithArgs output to the default buffer size", async () => {
		const sandbox = new DockerSandbox();
		(sandbox as unknown as { containerId: string | null }).containerId =
			"container-id";
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);

		const promise = sandbox.execWithArgs("gh", ["api"]);
		await Promise.resolve();
		child.stdout.emit("data", Buffer.from("x".repeat(1024 * 1024 + 1024)));
		child.emit("close", 0);

		const result = await promise;

		expect(childProcessMock.spawn).toHaveBeenCalledWith(
			"docker",
			["exec", "container-id", "gh", "api"],
			{
				signal: undefined,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.length).toBe(1024 * 1024);
		expect(result.stderr).toBe("");
	});

	it("treats signaled execWithArgs exits as failures", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);
		const sandbox = new DockerSandbox();
		(sandbox as unknown as { containerId: string | null }).containerId =
			"container-123";

		const promise = sandbox.execWithArgs("gh", ["pr", "view", "1"]);
		await Promise.resolve();
		child.stdout.emit("data", Buffer.from("partial output"));
		child.stderr.emit("data", Buffer.from("terminated by signal"));
		child.emit("close", null, "SIGKILL");

		await expect(promise).resolves.toEqual({
			stdout: "partial output",
			stderr: "terminated by signal",
			exitCode: 1,
		});
		expect(childProcessMock.spawn).toHaveBeenCalledWith(
			"docker",
			["exec", "container-123", "gh", "pr", "view", "1"],
			{
				signal: undefined,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	});

	it("returns an ExecResult when docker spawn fails", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);
		const sandbox = new DockerSandbox();
		(sandbox as unknown as { containerId: string | null }).containerId =
			"container-456";

		const promise = sandbox.execWithArgs("gh", ["pr", "view", "1"]);
		await Promise.resolve();
		child.emit(
			"error",
			Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }),
		);

		await expect(promise).resolves.toEqual({
			stdout: "",
			stderr: "spawn docker ENOENT",
			exitCode: 1,
		});
	});

	describe("exec — env-on-argv leak fix (#2473)", () => {
		it("passes env vars by name only — secret values never appear on argv", async () => {
			const child = createMockChildProcess();
			childProcessMock.spawn.mockReturnValueOnce(child);
			const sandbox = new DockerSandbox();
			(sandbox as unknown as { containerId: string | null }).containerId =
				"container-env";

			const promise = sandbox.exec("env", undefined, {
				MY_API_KEY: "secret-value-123",
				DATABASE_URL: "REDACTED",
			});
			await Promise.resolve();
			child.emit("close", 0);
			await promise;

			const [bin, args, opts] = childProcessMock.spawn.mock.calls[0] as [
				string,
				string[],
				{ env: NodeJS.ProcessEnv },
			];
			expect(bin).toBe("docker");

			// The argv has `-e KEY` flags but NO `=value` pairs. Secret
			// values are passed via the child's env instead, where
			// they never reach the host's `ps`.
			const argvJoined = args.join(" ");
			expect(args).toContain("-e");
			expect(args).toContain("MY_API_KEY");
			expect(args).toContain("DATABASE_URL");
			expect(argvJoined).not.toContain("secret-value-123");
			expect(argvJoined).not.toContain("MY_API_KEY=");
			expect(argvJoined).not.toContain("DATABASE_URL=");

			// Values DO live in the child's env (Docker reads them
			// from there).
			expect(opts.env?.MY_API_KEY).toBe("secret-value-123");
			expect(opts.env?.DATABASE_URL).toBe("REDACTED");
		});

		it("passes cwd via -w argv (not via a shell string)", async () => {
			const child = createMockChildProcess();
			childProcessMock.spawn.mockReturnValueOnce(child);
			const sandbox = new DockerSandbox();
			(sandbox as unknown as { containerId: string | null }).containerId =
				"container-cwd";

			const promise = sandbox.exec("pwd", "/path with spaces");
			await Promise.resolve();
			child.emit("close", 0);
			await promise;

			const [, args] = childProcessMock.spawn.mock.calls[0] as [
				string,
				string[],
				unknown,
			];
			expect(args).toContain("-w");
			expect(args).toContain("/path with spaces");
		});
	});

	describe("writeFile — stdin-piped content (#2473)", () => {
		it("streams content over stdin instead of echoing into a shell string", async () => {
			const child = createMockChildProcess();
			childProcessMock.spawn.mockReturnValueOnce(child);
			const sandbox = new DockerSandbox();
			(sandbox as unknown as { containerId: string | null }).containerId =
				"container-wf";

			const content = 'hello "world" with $special chars\nand\nnewlines';
			const promise = sandbox.writeFile("/path/with $weird chars", content);
			await Promise.resolve();
			child.emit("close", 0);
			await promise;

			const [bin, args] = childProcessMock.spawn.mock.calls[0] as [
				string,
				string[],
				unknown,
			];
			expect(bin).toBe("docker");
			// Argv shape: docker exec -i <id> sh -c 'cat > "$1"' sh <path>
			expect(args).toEqual([
				"exec",
				"-i",
				"container-wf",
				"sh",
				"-c",
				'cat > "$1"',
				"sh",
				"/path/with $weird chars",
			]);

			// Content went to stdin, NOT embedded in the argv anywhere
			expect(child.stdin.end).toHaveBeenCalledWith(content);
			expect(args.join(" ")).not.toContain(content);
		});

		it("rejects when the write fails", async () => {
			const child = createMockChildProcess();
			childProcessMock.spawn.mockReturnValueOnce(child);
			const sandbox = new DockerSandbox();
			(sandbox as unknown as { containerId: string | null }).containerId =
				"container-wf-err";

			const promise = sandbox.writeFile("/no/such/path", "content");
			await Promise.resolve();
			child.stderr.emit("data", Buffer.from("No such file or directory"));
			child.emit("close", 1);

			await expect(promise).rejects.toThrow(/No such file or directory/);
		});
	});

	describe("readFile / exists — argv-quoted paths (#2473)", () => {
		it("readFile uses execWithArgs so the path is not interpolated into a shell string", async () => {
			const child = createMockChildProcess();
			childProcessMock.spawn.mockReturnValueOnce(child);
			const sandbox = new DockerSandbox();
			(sandbox as unknown as { containerId: string | null }).containerId =
				"container-rf";

			const promise = sandbox.readFile("/etc/passwd; rm -rf /tmp");
			await Promise.resolve();
			child.stdout.emit("data", Buffer.from("root:x:0:0..."));
			child.emit("close", 0);
			const result = await promise;

			expect(result).toBe("root:x:0:0...");
			const [bin, args] = childProcessMock.spawn.mock.calls[0] as [
				string,
				string[],
				unknown,
			];
			expect(bin).toBe("docker");
			// Path stays an opaque argv entry; the shell-injection
			// substring is preserved literally and never interpreted.
			expect(args).toEqual([
				"exec",
				"container-rf",
				"cat",
				"/etc/passwd; rm -rf /tmp",
			]);
		});

		it("exists uses execWithArgs (no shell interpolation)", async () => {
			const child = createMockChildProcess();
			childProcessMock.spawn.mockReturnValueOnce(child);
			const sandbox = new DockerSandbox();
			(sandbox as unknown as { containerId: string | null }).containerId =
				"container-ex";

			const promise = sandbox.exists('"$(rm -rf /)"');
			await Promise.resolve();
			child.emit("close", 1);
			expect(await promise).toBe(false);

			const [, args] = childProcessMock.spawn.mock.calls[0] as [
				string,
				string[],
				unknown,
			];
			expect(args).toEqual([
				"exec",
				"container-ex",
				"test",
				"-e",
				'"$(rm -rf /)"',
			]);
		});
	});

	it("wraps abortable execWithArgs in a shell that forwards cancellation", async () => {
		const child = createMockChildProcess();
		childProcessMock.spawn.mockReturnValueOnce(child);
		const sandbox = new DockerSandbox();
		(sandbox as unknown as { containerId: string | null }).containerId =
			"container-789";
		const controller = new AbortController();

		const promise = sandbox.execWithArgs(
			"gh",
			["repo", "clone", "owner/repo"],
			{
				signal: controller.signal,
			},
		);
		await Promise.resolve();
		child.emit("close", 0);

		await expect(promise).resolves.toEqual({
			stdout: "",
			stderr: "",
			exitCode: 0,
		});
		expect(childProcessMock.spawn).toHaveBeenCalledWith(
			"docker",
			[
				"exec",
				"container-789",
				"sh",
				"-lc",
				expect.stringContaining("trap on_signal TERM INT HUP"),
				"sh",
				"gh",
				"repo",
				"clone",
				"owner/repo",
			],
			{
				signal: controller.signal,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	});
});
