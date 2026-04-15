import { afterEach, describe, expect, it } from "vitest";

import { getHeadlessPtyPythonCommand } from "../../src/headless/pty-helper.js";
import { HeadlessUtilityCommandManager } from "../../src/headless/utility-command-manager.js";

function waitForExit(
	managerEvents: Array<{ type: string }>,
	timeoutMs = 5000,
): Promise<void> {
	return waitForEvent(
		() => managerEvents.some((event) => event.type === "exited"),
		timeoutMs,
		"Timed out waiting for utility command to exit",
	);
}

function waitForEvent(
	check: () => boolean,
	timeoutMs: number,
	timeoutMessage: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			if (check()) {
				clearInterval(timer);
				resolve();
				return;
			}
			if (Date.now() - startedAt > timeoutMs) {
				clearInterval(timer);
				reject(new Error(timeoutMessage));
			}
		}, 20);
	});
}

const supportsPty =
	process.platform !== "win32" &&
	(() => {
		try {
			getHeadlessPtyPythonCommand();
			return true;
		} catch {
			return false;
		}
	})();

describe("HeadlessUtilityCommandManager", () => {
	let manager: HeadlessUtilityCommandManager | null = null;

	afterEach(async () => {
		if (manager) {
			await manager.dispose();
			manager = null;
		}
	});

	it("streams stdout/stderr and exit events", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_echo",
			command: `"${process.execPath}" -e "process.stdout.write('hello');process.stderr.write('err');"`,
			shell_mode: "direct",
		});

		await waitForExit(events as Array<{ type: string }>);

		expect(events[0]).toMatchObject({
			type: "started",
			command_id: "cmd_echo",
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "output",
				command_id: "cmd_echo",
				stream: "stdout",
				content: "hello",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "output",
				command_id: "cmd_echo",
				stream: "stderr",
				content: "err",
			}),
		);
		expect(events.at(-1)).toMatchObject({
			type: "exited",
			command_id: "cmd_echo",
			success: true,
			exit_code: 0,
		});
	});

	it("terminates running commands and reports the termination reason", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_sleep",
			command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
			shell_mode: "direct",
		});

		await manager.terminate("cmd_sleep");
		await waitForExit(events as Array<{ type: string }>);

		expect(events.at(-1)).toMatchObject({
			type: "exited",
			command_id: "cmd_sleep",
			success: false,
			reason: "Terminated by controller",
		});
	});

	it("writes stdin to running commands and can close the stream", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_stdin",
			command: `"${process.execPath}" -e "process.stdin.setEncoding('utf8');let data='';process.stdin.on('data', chunk => data += chunk);process.stdin.on('end', () => process.stdout.write(data.toUpperCase()));"`,
			shell_mode: "direct",
			allow_stdin: true,
		});

		await manager.writeStdin("cmd_stdin", "hello world", true);
		await waitForExit(events as Array<{ type: string }>);

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "output",
				command_id: "cmd_stdin",
				stream: "stdout",
				content: "HELLO WORLD",
			}),
		);
		expect(events.at(-1)).toMatchObject({
			type: "exited",
			command_id: "cmd_stdin",
			success: true,
		});
	});

	it("defaults utility commands to closed stdin so EOF-driven commands still exit", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_eof",
			command: `"${process.execPath}" -e "process.stdin.resume();process.stdin.on('end', () => process.stdout.write('EOF'));"`,
			shell_mode: "direct",
		});

		await waitForExit(events as Array<{ type: string }>);

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "output",
				command_id: "cmd_eof",
				stream: "stdout",
				content: "EOF",
			}),
		);
		expect(events.at(-1)).toMatchObject({
			type: "exited",
			command_id: "cmd_eof",
			success: true,
		});
	});

	it("rejects stdin writes for commands that did not opt into stdin piping", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_no_stdin",
			command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
			shell_mode: "direct",
		});

		await expect(manager.writeStdin("cmd_no_stdin", "hello")).rejects.toThrow(
			"Utility command stdin is not enabled: cmd_no_stdin",
		);

		await manager.terminate("cmd_no_stdin");
		await waitForExit(events as Array<{ type: string }>);
	});

	it("rejects resize requests for non-PTY commands", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_pipe_only",
			command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
			shell_mode: "direct",
		});

		await expect(manager.resize("cmd_pipe_only", 100, 40)).rejects.toThrow(
			"Utility command resize is only supported for PTY commands: cmd_pipe_only",
		);

		await manager.terminate("cmd_pipe_only");
		await waitForExit(events as Array<{ type: string }>);
	});

	it.skipIf(!supportsPty)(
		"starts PTY-backed commands and applies resize events",
		async () => {
			const events: Array<Record<string, unknown>> = [];
			manager = new HeadlessUtilityCommandManager((event) => {
				events.push(event as Record<string, unknown>);
			});

			const script = [
				"process.stdout.write(`START:${Number(process.stdout.isTTY)}:${process.stdout.columns}x${process.stdout.rows}\\n`);",
				"process.stdout.on('resize', () => {",
				"  process.stdout.write(`RESIZE:${process.stdout.columns}x${process.stdout.rows}\\n`);",
				"});",
				"setInterval(() => {}, 1000);",
			].join("");
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

			await manager.start({
				command_id: "cmd_pty",
				command,
				shell_mode: "direct",
				terminal_mode: "pty",
				columns: 90,
				rows: 30,
			});

			await waitForEvent(
				() =>
					events.some(
						(event) =>
							event.type === "output" &&
							event.command_id === "cmd_pty" &&
							typeof event.content === "string" &&
							event.content.includes("START:1:90x30"),
					),
				5000,
				"Timed out waiting for PTY startup output",
			);

			expect(events[0]).toMatchObject({
				type: "started",
				command_id: "cmd_pty",
				terminal_mode: "pty",
				columns: 90,
				rows: 30,
			});
			expect(manager.get("cmd_pty")).toMatchObject({
				command_id: "cmd_pty",
				terminal_mode: "pty",
				columns: 90,
				rows: 30,
			});

			await manager.resize("cmd_pty", 120, 50);
			await waitForEvent(
				() =>
					events.some(
						(event) =>
							event.type === "resized" &&
							event.command_id === "cmd_pty" &&
							event.columns === 120 &&
							event.rows === 50,
					),
				5000,
				"Timed out waiting for PTY resize event",
			);

			expect(manager.get("cmd_pty")).toMatchObject({
				command_id: "cmd_pty",
				terminal_mode: "pty",
				columns: 120,
				rows: 50,
			});

			await manager.terminate("cmd_pty");
			await waitForExit(events as Array<{ type: string }>);
			expect(events.at(-1)).toMatchObject({
				type: "exited",
				command_id: "cmd_pty",
			});
		},
	);

	it("treats terminate as a no-op after natural exit", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_quick_exit",
			command: `"${process.execPath}" -e "process.exit(0)"`,
			shell_mode: "direct",
		});

		await waitForExit(events as Array<{ type: string }>);
		await expect(manager.terminate("cmd_quick_exit")).resolves.toBeUndefined();
		expect(events.filter((event) => event.type === "exited")).toHaveLength(1);
	});

	it("preserves explicit disposal reasons", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_dispose",
			command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
			shell_mode: "direct",
		});

		await manager.dispose(
			"Interrupted while utility command was still running",
		);
		await waitForExit(events as Array<{ type: string }>);

		expect(events.at(-1)).toMatchObject({
			type: "exited",
			command_id: "cmd_dispose",
			success: false,
			reason: "Interrupted while utility command was still running",
		});
	});

	it("disposes only commands owned by a closing connection", async () => {
		const events: Array<Record<string, unknown>> = [];
		manager = new HeadlessUtilityCommandManager((event) => {
			events.push(event as Record<string, unknown>);
		});

		manager.start({
			command_id: "cmd_owned",
			command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
			shell_mode: "direct",
			owner_connection_id: "conn_owned",
		});
		manager.start({
			command_id: "cmd_other",
			command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
			shell_mode: "direct",
			owner_connection_id: "conn_other",
		});

		await manager.disposeOwnedByConnection(
			"conn_owned",
			"Owning connection closed while utility command was still running",
		);
		await waitForEvent(
			() =>
				events.some(
					(event) =>
						event.type === "exited" && event.command_id === "cmd_owned",
				),
			5000,
			"Timed out waiting for owned utility command to exit",
		);

		expect(
			events.find(
				(event) => event.type === "started" && event.command_id === "cmd_owned",
			),
		).toMatchObject({
			type: "started",
			command_id: "cmd_owned",
			owner_connection_id: "conn_owned",
		});
		expect(manager.snapshot()).toEqual([
			expect.objectContaining({
				command_id: "cmd_other",
				owner_connection_id: "conn_other",
			}),
		]);

		await manager.terminate("cmd_other");
		await waitForEvent(
			() =>
				events.some(
					(event) =>
						event.type === "exited" && event.command_id === "cmd_other",
				),
			5000,
			"Timed out waiting for remaining utility command to exit",
		);
	}, 60_000);
});
