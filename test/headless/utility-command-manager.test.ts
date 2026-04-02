import { afterEach, describe, expect, it } from "vitest";

import { HeadlessUtilityCommandManager } from "../../src/headless/utility-command-manager.js";

function waitForExit(
	managerEvents: Array<{ type: string }>,
	timeoutMs = 5000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			if (managerEvents.some((event) => event.type === "exited")) {
				clearInterval(timer);
				resolve();
				return;
			}
			if (Date.now() - startedAt > timeoutMs) {
				clearInterval(timer);
				reject(new Error("Timed out waiting for utility command to exit"));
			}
		}, 20);
	});
}

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
});
