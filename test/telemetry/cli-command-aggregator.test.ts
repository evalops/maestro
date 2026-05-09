import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("CLI command telemetry aggregator", () => {
	let tempDir: string;
	let beaconFile: string;
	let bufferFile: string;
	let now: number;

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), "maestro-cli-agg-"));
		beaconFile = join(tempDir, "beacon.jsonl");
		bufferFile = join(tempDir, "buffer.json");
		now = 1_772_000_000_000;
		vi.stubEnv("MAESTRO_TELEMETRY", "1");
		vi.stubEnv("MAESTRO_BEACON_FILE", beaconFile);
		vi.stubEnv("MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE", bufferFile);
		vi.stubEnv("MAESTRO_OTEL", "0");
	});

	afterEach(async () => {
		vi.resetModules();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(tempDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 25,
		});
	});

	it("flushes repeated command submissions as one counted beacon event", async () => {
		const { CliCommandAggregator } = await import(
			"../../src/telemetry/cli-command-aggregator.js"
		);
		const aggregator = new CliCommandAggregator({
			clientVersion: "0.10.18",
			bufferMs: 10_000,
			bufferFile,
			now: () => now,
		});

		for (let index = 0; index < 50; index += 1) {
			await aggregator.submit("run");
		}
		await aggregator.flush();

		const [event] = JSON.parse((await readFile(beaconFile, "utf8")).trim()) as [
			{
				feature: string;
				action: string;
				parameters?: {
					metadata?: Record<string, unknown>;
				};
			},
		];

		expect(event).toMatchObject({
			feature: "cli.command",
			action: "cli.command.run",
			parameters: {
				metadata: {
					count: 50,
				},
			},
		});
		await expect(readFile(bufferFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("serializes concurrent command-count buffer updates", async () => {
		const { CliCommandAggregator } = await import(
			"../../src/telemetry/cli-command-aggregator.js"
		);
		const first = new CliCommandAggregator({
			clientVersion: "0.10.18",
			bufferMs: 10_000,
			bufferFile,
			now: () => now,
		});
		const second = new CliCommandAggregator({
			clientVersion: "0.10.18",
			bufferMs: 10_000,
			bufferFile,
			now: () => now,
		});

		await Promise.all(
			Array.from({ length: 50 }, (_, index) =>
				(index % 2 === 0 ? first : second).submit("run"),
			),
		);
		await first.flush();

		const [event] = JSON.parse((await readFile(beaconFile, "utf8")).trim()) as [
			{
				parameters?: {
					metadata?: Record<string, unknown>;
				};
			},
		];

		expect(event.parameters?.metadata).toEqual({
			count: 50,
		});
		await expect(readFile(`${bufferFile}.lock`, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("keeps command counts buffered when sampling skips a flush", async () => {
		vi.stubEnv("MAESTRO_TELEMETRY_SAMPLE", "0.5");
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const { CliCommandAggregator } = await import(
			"../../src/telemetry/cli-command-aggregator.js"
		);
		const aggregator = new CliCommandAggregator({
			clientVersion: "0.10.18",
			bufferMs: 10_000,
			bufferFile,
			now: () => now,
		});

		await aggregator.submit("run");
		now += 10_000;
		await aggregator.flush();

		const buffer = JSON.parse(await readFile(bufferFile, "utf8")) as {
			counts: Record<string, number>;
		};
		expect(buffer.counts).toEqual({
			"cli.command.run": 1,
		});
		await expect(readFile(beaconFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("keeps command counts buffered when endpoint emission fails", async () => {
		vi.stubEnv("MAESTRO_BEACON_FILE", "");
		vi.stubEnv("MAESTRO_BEACON_ENDPOINT", "https://telemetry.example.test");
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
		);
		const { CliCommandAggregator } = await import(
			"../../src/telemetry/cli-command-aggregator.js"
		);
		const aggregator = new CliCommandAggregator({
			clientVersion: "0.10.18",
			bufferMs: 10_000,
			bufferFile,
			now: () => now,
		});

		await aggregator.submit("run");
		now += 10_000;
		await aggregator.flush();

		const buffer = JSON.parse(await readFile(bufferFile, "utf8")) as {
			counts: Record<string, number>;
		};
		expect(buffer.counts).toEqual({
			"cli.command.run": 1,
		});
	});

	it("does not hold the buffer lock while posting beacon batches", async () => {
		vi.stubEnv("MAESTRO_BEACON_FILE", "");
		vi.stubEnv("MAESTRO_BEACON_ENDPOINT", "https://telemetry.example.test");
		let releaseFetch: ((response: Response) => void) | undefined;
		let fetchStarted: (() => void) | undefined;
		const fetchStartedPromise = new Promise<void>((resolve) => {
			fetchStarted = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						fetchStarted?.();
						releaseFetch = resolve;
					}),
			),
		);
		const { CliCommandAggregator } = await import(
			"../../src/telemetry/cli-command-aggregator.js"
		);
		const aggregator = new CliCommandAggregator({
			clientVersion: "0.10.18",
			bufferMs: 10_000,
			bufferFile,
			now: () => now,
		});

		await aggregator.submit("first");
		const flushPromise = aggregator.flush();
		await fetchStartedPromise;
		await aggregator.submit("second");

		const buffer = JSON.parse(await readFile(bufferFile, "utf8")) as {
			counts: Record<string, number>;
		};
		expect(buffer.counts).toEqual({
			"cli.command.second": 1,
		});
		releaseFetch?.(new Response(null, { status: 200 }));
		await flushPromise;
	});

	it("recovers stale lock files before updating command counts", async () => {
		const lockFile = `${bufferFile}.lock`;
		await writeFile(lockFile, "", "utf8");
		const staleTime = new Date(Date.now() - 20_000);
		await utimes(lockFile, staleTime, staleTime);
		const { CliCommandAggregator } = await import(
			"../../src/telemetry/cli-command-aggregator.js"
		);
		const aggregator = new CliCommandAggregator({
			clientVersion: "0.10.18",
			bufferMs: 10_000,
			bufferFile,
			now: () => now,
		});

		await aggregator.submit("run");

		const buffer = JSON.parse(await readFile(bufferFile, "utf8")) as {
			counts: Record<string, number>;
		};
		expect(buffer.counts).toEqual({
			"cli.command.run": 1,
		});
		await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("evicts stale locks without waiting for the beacon timeout budget", async () => {
		vi.stubEnv("MAESTRO_BEACON_TIMEOUT_MS", "10000");
		const lockFile = `${bufferFile}.lock`;
		await writeFile(lockFile, "", "utf8");
		const activeTime = new Date(Date.now() - 6_000);
		await utimes(lockFile, activeTime, activeTime);
		const { CliCommandAggregator } = await import(
			"../../src/telemetry/cli-command-aggregator.js"
		);
		const aggregator = new CliCommandAggregator({
			clientVersion: "0.10.18",
			bufferMs: 10_000,
			bufferFile,
			lockTimeoutMs: 10,
			now: () => now,
		});

		await aggregator.submit("run");

		await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		const buffer = JSON.parse(await readFile(bufferFile, "utf8")) as {
			counts: Record<string, number>;
		};
		expect(buffer.counts).toEqual({
			"cli.command.run": 1,
		});
	});

	it("reinitializes the global aggregator when buffer options change", async () => {
		const firstBufferFile = join(tempDir, "first-buffer.json");
		const secondBufferFile = join(tempDir, "second-buffer.json");
		const { CliCommandAggregator, getGlobalCliCommandAggregator } =
			await import("../../src/telemetry/cli-command-aggregator.js");
		const disposeSpy = vi.spyOn(CliCommandAggregator.prototype, "dispose");

		await getGlobalCliCommandAggregator({
			clientVersion: "0.10.18",
			bufferFile: firstBufferFile,
			now: () => now,
		}).submit("first");
		const firstBuffer = JSON.parse(await readFile(firstBufferFile, "utf8")) as {
			counts: Record<string, number>;
		};
		await getGlobalCliCommandAggregator({
			clientVersion: "0.10.18",
			bufferFile: secondBufferFile,
			now: () => now,
		}).submit("second");

		const secondBuffer = JSON.parse(
			await readFile(secondBufferFile, "utf8"),
		) as {
			counts: Record<string, number>;
		};
		expect(firstBuffer.counts).toEqual({
			"cli.command.first": 1,
		});
		expect(secondBuffer.counts).toEqual({
			"cli.command.second": 1,
		});
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		const disposeResults = disposeSpy.mock.results
			.map((result) => result.value)
			.filter(
				(value): value is Promise<unknown> =>
					typeof value === "object" &&
					value !== null &&
					"then" in value &&
					typeof value.then === "function",
			);
		await Promise.allSettled(disposeResults);
	});

	it("classifies early-exit flags before parsed subcommands", async () => {
		const { cliCommandName } = await import(
			"../../src/telemetry/cli-startup.js"
		);

		expect(
			cliCommandName({
				command: "models",
				subcommand: "list",
				version: true,
				messages: [],
			}),
		).toBe("version");
		expect(
			cliCommandName({
				command: "models",
				subcommand: "list",
				help: true,
				messages: [],
			}),
		).toBe("help");
		expect(
			cliCommandName({
				command: "models",
				subcommand: "list",
				error: "bad arguments",
				messages: [],
			}),
		).toBe("parse_error");
	});

	it("records startup and command-count telemetry before a session exists", async () => {
		const { recordCliStartupTelemetry } = await import(
			"../../src/telemetry/cli-startup.js"
		);

		await recordCliStartupTelemetry({
			args: {
				command: "exec",
				messages: ["hello"],
			},
			clientVersion: "0.10.18",
			rawArgs: ["exec", "hello"],
			now: () => now,
		});

		const [startupEvent] = JSON.parse(
			(await readFile(beaconFile, "utf8")).trim(),
		) as [
			{
				feature: string;
				action: string;
				parameters?: {
					metadata?: Record<string, unknown>;
				};
			},
		];
		const buffer = JSON.parse(await readFile(bufferFile, "utf8")) as {
			counts: Record<string, number>;
		};

		expect(startupEvent).toMatchObject({
			feature: "cli.startup",
			action: "exec",
			parameters: {
				metadata: {
					command: "exec",
					hasPrompt: true,
					argCount: 2,
				},
			},
		});
		expect(buffer.counts).toEqual({
			"cli.command.exec": 1,
		});
	});

	it("records legacy runtime startup metadata through the canonical selector", async () => {
		const { LEGACY_HEADLESS_RUNTIME_ENV, LEGACY_HEADLESS_RUNTIME_ENV_VALUE } =
			await import("../../src/cli/headless-runtime-selection.js");
		const { recordCliStartupTelemetry } = await import(
			"../../src/telemetry/cli-startup.js"
		);

		await recordCliStartupTelemetry({
			args: {
				headless: true,
				messages: [],
			},
			clientVersion: "0.10.18",
			rawArgs: ["--headless"],
			now: () => now,
			env: {
				...process.env,
				[LEGACY_HEADLESS_RUNTIME_ENV]: LEGACY_HEADLESS_RUNTIME_ENV_VALUE,
			},
		});

		const [startupEvent] = JSON.parse(
			(await readFile(beaconFile, "utf8")).trim(),
		) as [
			{
				parameters?: {
					metadata?: Record<string, unknown>;
				};
			},
		];

		expect(startupEvent.parameters?.metadata).toMatchObject({
			command: "headless",
			legacyRuntimeRequested: true,
		});
	});

	it("records default prompt startup mode as text", async () => {
		const { recordCliStartupTelemetry } = await import(
			"../../src/telemetry/cli-startup.js"
		);

		await recordCliStartupTelemetry({
			args: {
				messages: ["hello"],
			},
			clientVersion: "0.10.18",
			rawArgs: ["hello"],
			now: () => now,
		});

		const [startupEvent] = JSON.parse(
			(await readFile(beaconFile, "utf8")).trim(),
		) as [
			{
				feature: string;
				action: string;
				parameters?: {
					metadata?: Record<string, unknown>;
				};
			},
		];

		expect(startupEvent).toMatchObject({
			feature: "cli.startup",
			action: "prompt.text",
			parameters: {
				metadata: {
					command: "prompt.text",
					mode: "text",
					hasPrompt: true,
					argCount: 1,
				},
			},
		});
	});

	it("records startup beacons without waiting on command-count lock contention", async () => {
		const lockFile = `${bufferFile}.lock`;
		await writeFile(lockFile, "", "utf8");
		const { recordCliStartupTelemetry } = await import(
			"../../src/telemetry/cli-startup.js"
		);

		await recordCliStartupTelemetry({
			args: {
				command: "models",
				subcommand: "providers",
				messages: [],
			},
			clientVersion: "0.10.18",
			commandCountLockTimeoutMs: 0,
			rawArgs: ["models", "providers"],
			now: () => now,
		});

		const [startupEvent] = JSON.parse(
			(await readFile(beaconFile, "utf8")).trim(),
		) as [
			{
				action: string;
				parameters?: {
					metadata?: Record<string, unknown>;
				};
			},
		];
		expect(startupEvent).toMatchObject({
			action: "models.providers",
			parameters: {
				metadata: {
					command: "models.providers",
				},
			},
		});
		await expect(readFile(bufferFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(lockFile, "utf8")).resolves.toBe("");
	});
});
