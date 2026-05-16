import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TranscriptEntry {
	role: string;
	text: string;
	state?: string;
}

interface LedgerEntry {
	taskId: string;
	contextId?: string;
	state: string;
	text: string;
	responseText?: string;
	transcript: TranscriptEntry[];
}

interface LedgerFile {
	tasks: LedgerEntry[];
}

const PEER_NAME = "codex-input-required";
const TOKEN = "test-token";
const FIRST_USER_TEXT = "Run the deterministic input-required A2A fixture smoke.";
const USER_REPLY_TEXT = "Use the deterministic reply and complete the fixture task.";
const READY_TIMEOUT_MS = positiveIntEnv(
	"MAESTRO_A2A_INPUT_REQUIRED_SMOKE_READY_TIMEOUT_MS",
	30_000,
);
const CLI_TIMEOUT_MS = positiveIntEnv(
	"MAESTRO_A2A_INPUT_REQUIRED_SMOKE_CLI_TIMEOUT_MS",
	15_000,
);
const PROCESS_EXIT_GRACE_MS = 2_000;
const BRIDGE_START_ATTEMPTS = 5;

function positiveIntEnv(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("failed to allocate a local TCP port");
	}
	const port = address.port;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return port;
}

async function waitForHealth(
	baseUrl: string,
	stderr: () => string,
	child?: ChildProcess,
): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (
			child &&
			(child.exitCode !== null || child.signalCode !== null)
		) {
			throw new Error(
				`Codex A2A bridge exited before health check passed:\n${stderr()}`,
			);
		}
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) {
				return;
			}
		} catch {
			// Bridge process is still starting.
		}
		await delay(100);
	}
	throw new Error(`Codex A2A bridge did not become ready:\n${stderr()}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), delay(PROCESS_EXIT_GRACE_MS)]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
}

async function runMaestroA2A(
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const child = spawn("bun", ["run", "a2a", "--", ...args], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const [code, signal] = await waitForChildExit(
		child,
		CLI_TIMEOUT_MS + PROCESS_EXIT_GRACE_MS,
		`maestro a2a ${args[0] ?? "command"}`,
	);
	if (code !== 0) {
		throw new Error(
			`maestro a2a ${args[0] ?? "command"} failed with ${code ?? signal ?? "unknown"}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
		);
	}
	return stdout;
}

async function waitForChildExit(
	child: ChildProcess,
	timeoutMs: number,
	label: string,
): Promise<[number | null, NodeJS.Signals | null]> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			void stopProcess(child).finally(() => {
				reject(new Error(`${label} timed out after ${timeoutMs}ms`));
			});
		}, timeoutMs);
		child.once("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			resolve([code, signal]);
		});
	});
}

async function loadLedger(path: string): Promise<LedgerFile> {
	const raw = await readFile(path, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
		throw new Error(`A2A task ledger at ${path} did not contain a tasks array`);
	}
	return {
		tasks: parsed.tasks.map((entry, index) =>
			normalizeLedgerEntry(entry, `tasks[${index}]`),
		),
	};
}

function normalizeLedgerEntry(input: unknown, label: string): LedgerEntry {
	if (!isRecord(input)) {
		throw new Error(`${label} must be an object`);
	}
	const taskId = requiredString(input.taskId, `${label}.taskId`);
	const state = requiredString(input.state, `${label}.state`);
	const text = requiredString(input.text, `${label}.text`);
	const transcriptInput = input.transcript;
	if (!Array.isArray(transcriptInput)) {
		throw new Error(`${label}.transcript must be an array`);
	}
	return {
		taskId,
		state,
		text,
		...(typeof input.contextId === "string" ? { contextId: input.contextId } : {}),
		...(typeof input.responseText === "string"
			? { responseText: input.responseText }
			: {}),
		transcript: transcriptInput.map((entry, index) =>
			normalizeTranscriptEntry(entry, `${label}.transcript[${index}]`),
		),
	};
}

function normalizeTranscriptEntry(input: unknown, label: string): TranscriptEntry {
	if (!isRecord(input)) {
		throw new Error(`${label} must be an object`);
	}
	return {
		role: requiredString(input.role, `${label}.role`),
		text: requiredString(input.text, `${label}.text`),
		...(typeof input.state === "string" ? { state: input.state } : {}),
	};
}

function requiredString(input: unknown, label: string): string {
	if (typeof input !== "string" || !input.trim()) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

function assertState(value: string, expected: "INPUT_REQUIRED" | "COMPLETED"): void {
	const normalized = value.toUpperCase().replace(/[\s-]+/gu, "_");
	if (!normalized.includes(expected)) {
		throw new Error(`expected state ${expected}, got ${value}`);
	}
}

function assertTranscript(
	entry: LedgerEntry,
	expected:
		| readonly ["user", "agent"]
		| readonly ["user", "agent", "user", "agent"],
): void {
	const roles = entry.transcript.map((item) => item.role);
	if (JSON.stringify(roles) !== JSON.stringify(expected)) {
		throw new Error(
			`unexpected transcript roles for ${entry.taskId}: ${roles.join(" -> ")}`,
		);
	}
}

function latestLedgerEntry(ledger: LedgerFile): LedgerEntry {
	if (ledger.tasks.length !== 1 || !ledger.tasks[0]) {
		throw new Error(`expected exactly one A2A task, found ${ledger.tasks.length}`);
	}
	return ledger.tasks[0];
}

async function main(): Promise<void> {
	const workDir = await mkdtemp(join(tmpdir(), "maestro-a2a-input-required-"));
	const peersPath = join(workDir, "peers.json");
	const tasksPath = join(workDir, "tasks.json");
	const runtimeDir = join(workDir, "runtime");
	let bridgeStderr = "";
	let bridgeStdout = "";
	let bridge: ChildProcess | undefined;
	let baseUrl = "";

	try {
		for (let attempt = 1; attempt <= BRIDGE_START_ATTEMPTS; attempt += 1) {
			const port = await openPort();
			baseUrl = `http://127.0.0.1:${port}`;
			await writePeerRegistry(peersPath, baseUrl);
			bridgeStdout = "";
			bridgeStderr = "";
			bridge = spawnBridge(port, baseUrl, runtimeDir);
			bridge.stdout?.on("data", (chunk: Buffer) => {
				bridgeStdout += chunk.toString("utf8");
			});
			bridge.stderr?.on("data", (chunk: Buffer) => {
				bridgeStderr += chunk.toString("utf8");
			});
			try {
				await waitForHealth(
					baseUrl,
					() => `${bridgeStdout}\n${bridgeStderr}`,
					bridge,
				);
				break;
			} catch (error) {
				await stopProcess(bridge);
				bridge = undefined;
				if (attempt >= BRIDGE_START_ATTEMPTS) {
					throw error;
				}
			}
		}
		if (!bridge) {
			throw new Error("Codex A2A bridge did not start");
		}
		const cliEnv = {
			...process.env,
			CODEX_A2A_TOKEN: TOKEN,
			MAESTRO_A2A_PEERS_FILE: peersPath,
			MAESTRO_A2A_TASKS_FILE: tasksPath,
		};
		const commonFlags = [
			"--registry",
			peersPath,
			"--tasks",
			tasksPath,
			"--max-wait-ms",
			String(CLI_TIMEOUT_MS),
			"--interval-ms",
			"100",
			"--timeout-ms",
			"3000",
		];

		await runMaestroA2A(
			[
				"delegate",
				PEER_NAME,
				FIRST_USER_TEXT,
				"--role",
				"background-worker",
				"--cwd",
				process.cwd(),
				"--wait",
				...commonFlags,
			],
			cliEnv,
		);
		const inputRequired = latestLedgerEntry(await loadLedger(tasksPath));
		assertState(inputRequired.state, "INPUT_REQUIRED");
		assertTranscript(inputRequired, ["user", "agent"]);
		if (inputRequired.text !== FIRST_USER_TEXT) {
			throw new Error(`unexpected delegated text: ${inputRequired.text}`);
		}
		const taskId = inputRequired.taskId;
		const contextId = requiredString(
			inputRequired.contextId,
			"inputRequired.contextId",
		);
		if (!inputRequired.transcript[1]?.text.includes("?")) {
			throw new Error(
				`expected input-required agent turn to ask a question, got: ${inputRequired.transcript[1]?.text ?? "<missing>"}`,
			);
		}

		await runMaestroA2A(
			["reply", PEER_NAME, taskId, USER_REPLY_TEXT, "--wait", ...commonFlags],
			cliEnv,
		);
		const completed = latestLedgerEntry(await loadLedger(tasksPath));
		assertState(completed.state, "COMPLETED");
		assertTranscript(completed, ["user", "agent", "user", "agent"]);
		if (completed.taskId !== taskId) {
			throw new Error(`reply changed taskId from ${taskId} to ${completed.taskId}`);
		}
		if (completed.contextId !== contextId) {
			throw new Error(
				`reply changed contextId from ${contextId} to ${completed.contextId ?? "<missing>"}`,
			);
		}
		if (completed.transcript[0]?.text !== FIRST_USER_TEXT) {
			throw new Error("final transcript did not preserve the original user turn");
		}
		if (completed.transcript[2]?.text !== USER_REPLY_TEXT) {
			throw new Error("final transcript did not record the user reply");
		}
		if (!completed.responseText) {
			throw new Error("completed A2A ledger entry did not record a final response");
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					peer: PEER_NAME,
					taskId,
					contextId,
					initialState: inputRequired.state,
					finalState: completed.state,
					transcript: completed.transcript.map((item) => ({
						role: item.role,
						text: item.text,
						...(item.state ? { state: item.state } : {}),
					})),
					peersPath,
					tasksPath,
				},
				null,
				2,
			),
		);
	} finally {
		if (bridge) {
			await stopProcess(bridge);
		}
		if (process.env.MAESTRO_A2A_INPUT_REQUIRED_SMOKE_KEEP_WORKDIR !== "1") {
			await rm(workDir, { force: true, recursive: true });
		}
	}
}

async function writePeerRegistry(path: string, baseUrl: string): Promise<void> {
	await writeFile(
		path,
		`${JSON.stringify(
			{
				defaultPeer: PEER_NAME,
				peers: {
					[PEER_NAME]: {
						url: baseUrl,
						displayName: "Codex input-required fixture",
						agentCardUrl: `${baseUrl}/.well-known/agent-card.json`,
						tokenEnv: "CODEX_A2A_TOKEN",
						workspaceId: "maestro-a2a-input-required-smoke",
						agentId: "maestro-a2a-input-required-smoke",
						timeoutMs: 3_000,
						maxAttempts: 1,
					},
				},
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
}

function spawnBridge(port: number, baseUrl: string, runtimeDir: string): ChildProcess {
	return spawn("python3", ["scripts/codex-a2a-bridge.py"], {
		env: {
			...process.env,
			CODEX_A2A_ACCESS_LOG: "0",
			CODEX_A2A_BIND: "127.0.0.1",
			CODEX_A2A_CODEX_BIN: "__maestro_fixture_mode_should_not_call_codex__",
			CODEX_A2A_FIXTURE_MODE: "input-required-once",
			CODEX_A2A_HOST: "127.0.0.1",
			CODEX_A2A_PORT: String(port),
			CODEX_A2A_PUBLIC_URL: baseUrl,
			CODEX_A2A_RUNTIME_DIR: runtimeDir,
			CODEX_A2A_TOKEN: TOKEN,
			CODEX_A2A_TURN_TIMEOUT_MS: "5000",
			CODEX_A2A_WORKDIR: process.cwd(),
			PYTHONUNBUFFERED: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
