import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PATHS } from "../config/constants.js";
import {
	type BeaconEvent,
	emitBeaconBatch,
	isBeaconEnabled,
} from "./beacon.js";

export interface CliCommandAggregatorOptions {
	bufferMs?: number;
	clientVersion: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	bufferFile?: string;
	lockTimeoutMs?: number;
}

interface CliCommandBuffer {
	lastFlushAt: number;
	counts: Record<string, number>;
}

const DEFAULT_BUFFER_MS = 10_000;
const LOCK_RETRY_MS = 5;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_GRACE_MS = 1_000;
let globalAggregator: CliCommandAggregator | null = null;
const inProcessBufferLockQueues = new Map<string, Promise<void>>();

export class CliCommandAggregator {
	private readonly bufferMs: number;
	private readonly clientVersion: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private readonly bufferFile: string;
	private readonly lockTimeoutMs: number;
	private timer: NodeJS.Timeout | null = null;

	constructor(options: CliCommandAggregatorOptions) {
		this.bufferMs = options.bufferMs ?? DEFAULT_BUFFER_MS;
		this.clientVersion = options.clientVersion;
		this.env = options.env ?? process.env;
		this.now = options.now ?? Date.now;
		this.bufferFile =
			options.bufferFile ??
			this.env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE ??
			join(PATHS.MAESTRO_HOME, "telemetry-cli-command-counts.json");
		this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	}

	matchesOptions(options: CliCommandAggregatorOptions): boolean {
		const env = options.env ?? process.env;
		const now = options.now ?? Date.now;
		const bufferFile =
			options.bufferFile ??
			env.MAESTRO_CLI_COMMAND_BEACON_BUFFER_FILE ??
			join(PATHS.MAESTRO_HOME, "telemetry-cli-command-counts.json");
		return (
			this.bufferMs === (options.bufferMs ?? DEFAULT_BUFFER_MS) &&
			this.clientVersion === options.clientVersion &&
			this.env === env &&
			this.now === now &&
			this.bufferFile === bufferFile &&
			this.lockTimeoutMs === (options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
		);
	}

	start(): void {
		if (this.timer || !isBeaconEnabled(this.env)) {
			return;
		}
		this.timer = setInterval(() => {
			void this.flush().catch(() => undefined);
		}, this.bufferMs);
		this.timer.unref?.();
	}

	async submit(command: string): Promise<void> {
		if (!isBeaconEnabled(this.env)) {
			return;
		}
		const action = normalizeCommandAction(command);
		let shouldFlush = false;
		let shouldStartTimer = false;
		await this.withBufferLock(async () => {
			const buffer = await this.readBuffer();
			buffer.counts[action] = (buffer.counts[action] ?? 0) + 1;
			if (this.now() - buffer.lastFlushAt >= this.bufferMs) {
				await this.writeBuffer(buffer);
				shouldFlush = true;
				return;
			}
			await this.writeBuffer(buffer);
			shouldStartTimer = true;
		});
		if (shouldFlush) {
			await this.flush();
			return;
		}
		if (shouldStartTimer) {
			this.start();
		}
	}

	async flush(): Promise<void> {
		if (!isBeaconEnabled(this.env)) {
			return;
		}
		const buffer = await this.drainBuffer();
		if (!buffer) {
			return;
		}
		const emitted = await emitBeaconBatch(this.buildCommandEvents(buffer), {
			env: this.env,
		});
		if (!emitted) {
			await this.restoreBuffer(buffer);
		}
	}

	private async drainBuffer(): Promise<CliCommandBuffer | null> {
		let drained: CliCommandBuffer | null = null;
		await this.withBufferLock(async () => {
			const buffer = await this.readBuffer();
			if (!this.buildCommandEvents(buffer).length) {
				await this.writeBuffer({ lastFlushAt: this.now(), counts: {} });
				return;
			}
			drained = buffer;
			await this.clearBuffer();
		});
		return drained;
	}

	private async restoreBuffer(buffer: CliCommandBuffer): Promise<void> {
		await this.withBufferLock(async () => {
			const current = await this.readBuffer();
			const counts = { ...current.counts };
			for (const [action, count] of Object.entries(buffer.counts)) {
				counts[action] = (counts[action] ?? 0) + count;
			}
			await this.writeBuffer({
				lastFlushAt: Math.min(current.lastFlushAt, buffer.lastFlushAt),
				counts,
			});
		});
	}

	private async withBufferLock(operation: () => Promise<void>): Promise<void> {
		const lockFile = `${this.bufferFile}.lock`;
		await runWithInProcessBufferLock(lockFile, () =>
			this.withBufferFileLock(lockFile, operation),
		);
	}

	private async withBufferFileLock(
		lockFile: string,
		operation: () => Promise<void>,
	): Promise<void> {
		const deadline = Date.now() + this.lockTimeoutMs;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		while (!handle) {
			try {
				handle = await open(lockFile, "wx");
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					await mkdirForFile(lockFile);
					continue;
				}
				if (
					code === "EEXIST" &&
					(await removeStaleLock(lockFile, this.lockStaleMs()))
				) {
					continue;
				}
				if (code !== "EEXIST" || Date.now() >= deadline) {
					return;
				}
				await sleep(LOCK_RETRY_MS, undefined, { ref: false });
			}
		}
		try {
			await operation();
		} finally {
			await handle.close().catch(() => undefined);
			await rm(lockFile, { force: true }).catch(() => undefined);
		}
	}

	private lockStaleMs(): number {
		return this.lockTimeoutMs + LOCK_STALE_GRACE_MS;
	}

	async dispose(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.flush();
	}

	private buildCommandEvent(action: string, count: number): BeaconEvent {
		return {
			feature: "cli.command",
			action,
			timestamp: this.now() * 1000,
			source: {
				client: "cli",
				clientVersion: this.clientVersion,
			},
			parameters: {
				metadata: {
					count,
				},
			},
		};
	}

	private buildCommandEvents(buffer: CliCommandBuffer): BeaconEvent[] {
		return Object.entries(buffer.counts)
			.filter(([, count]) => count > 0)
			.map(([action, count]) => this.buildCommandEvent(action, count));
	}

	private async readBuffer(): Promise<CliCommandBuffer> {
		try {
			const parsed = JSON.parse(await readFile(this.bufferFile, "utf8")) as {
				lastFlushAt?: unknown;
				counts?: unknown;
			};
			const counts: Record<string, number> = {};
			if (
				parsed.counts &&
				typeof parsed.counts === "object" &&
				!Array.isArray(parsed.counts)
			) {
				for (const [key, value] of Object.entries(parsed.counts)) {
					if (
						typeof value === "number" &&
						Number.isFinite(value) &&
						value > 0
					) {
						counts[key] = value;
					}
				}
			}
			return {
				lastFlushAt:
					typeof parsed.lastFlushAt === "number" &&
					Number.isFinite(parsed.lastFlushAt)
						? parsed.lastFlushAt
						: this.now(),
				counts,
			};
		} catch {
			return {
				lastFlushAt: this.now(),
				counts: {},
			};
		}
	}

	private async writeBuffer(buffer: CliCommandBuffer): Promise<void> {
		await writeFile(
			this.bufferFile,
			`${JSON.stringify(buffer)}\n`,
			"utf8",
		).catch(async (error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") {
				return;
			}
			await mkdirForFile(this.bufferFile);
			await writeFile(this.bufferFile, `${JSON.stringify(buffer)}\n`, "utf8");
		});
	}

	private async clearBuffer(): Promise<void> {
		await rm(this.bufferFile, { force: true });
	}
}

async function runWithInProcessBufferLock(
	lockFile: string,
	operation: () => Promise<void>,
): Promise<void> {
	const previous = inProcessBufferLockQueues.get(lockFile) ?? Promise.resolve();
	let releaseCurrent: () => void = () => undefined;
	const current = new Promise<void>((resolve) => {
		releaseCurrent = resolve;
	});
	const queued = previous.catch(() => undefined).then(() => current);
	inProcessBufferLockQueues.set(lockFile, queued);
	await previous.catch(() => undefined);
	try {
		await operation();
	} finally {
		releaseCurrent();
		if (inProcessBufferLockQueues.get(lockFile) === queued) {
			inProcessBufferLockQueues.delete(lockFile);
		}
	}
}

export function getGlobalCliCommandAggregator(
	options: CliCommandAggregatorOptions,
): CliCommandAggregator {
	if (!globalAggregator?.matchesOptions(options)) {
		void globalAggregator?.dispose().catch(() => undefined);
		globalAggregator = new CliCommandAggregator(options);
	}
	return globalAggregator;
}

export function resetGlobalCliCommandAggregatorForTests(): void {
	globalAggregator = null;
}

export function normalizeCommandAction(command: string): string {
	const trimmed = command.trim();
	return `cli.command.${trimmed.length > 0 ? trimmed : "interactive"}`;
}

async function mkdirForFile(file: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dirname(file), { recursive: true });
}

async function removeStaleLock(
	lockFile: string,
	staleAfterMs: number,
): Promise<boolean> {
	try {
		const lock = await stat(lockFile);
		if (Date.now() - lock.mtimeMs < staleAfterMs) {
			return false;
		}
		await rm(lockFile, { force: true });
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}
