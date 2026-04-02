import { afterEach, describe, expect, it, vi } from "vitest";

type LineHandler = (line: string) => void | Promise<void>;
type CloseHandler = () => void;

describe("runHeadlessMode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("node:readline");
	});

	it("reports utility command runtime errors without parse prefixes", async () => {
		let onLine: LineHandler | undefined;
		let onClose: CloseHandler | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "line") {
					onLine = handler as LineHandler;
				}
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
		);

		await vi.waitFor(() => {
			expect(onLine).toBeTypeOf("function");
			expect(onClose).toBeTypeOf("function");
		});

		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.0",
				client_info: { name: "maestro-test", version: "0.1.0" },
				capabilities: {
					utility_operations: ["command_exec"],
				},
				role: "controller",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "utility_command_stdin",
				command_id: "missing-command",
				content: "hello",
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						message?: string;
						error_type?: string;
					},
			);
		const error = messages.find((message) => message.type === "error");

		expect(error).toMatchObject({
			type: "error",
			message: "Utility command not found: missing-command",
			error_type: "tool",
		});
		expect(
			messages.some(
				(message) =>
					message.type === "error" &&
					message.message?.includes("Failed to parse command:"),
			),
		).toBe(false);
	});
});
