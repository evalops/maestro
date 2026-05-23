import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadMcpConfig, McpClientManager } from "../src/mcp/index.js";

type JsonRecord = Record<string, unknown>;

const execFileAsync = promisify(execFile);
const targetBundleId = "com.evalops.fathom.cua-dogfood-target";
const smokeSchema = "maestro.fathom-cua-mcp-smoke.v1";
const fathomCuaEnvVars = [
	"MAESTRO_FATHOM_CUA_ENABLED",
	"FATHOM_CUA_MCP_ENABLED",
	"MAESTRO_FATHOM_CUA_MCP_NAME",
	"FATHOM_CUA_MCP_NAME",
	"MAESTRO_FATHOM_CUA_CLIENT_COMMAND",
	"FATHOM_CUA_CLIENT_COMMAND",
	"MAESTRO_FATHOM_CUA_CLIENT_ARGS_JSON",
	"FATHOM_CUA_CLIENT_ARGS_JSON",
	"MAESTRO_FATHOM_CUA_REPO",
	"FATHOM_CUA_REPO",
	"MAESTRO_FATHOM_CUA_CLIENT_CWD",
	"FATHOM_CUA_CLIENT_CWD",
	"MAESTRO_FATHOM_CUA_WORKSPACE_ID",
	"FATHOM_CUA_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
	"MAESTRO_FATHOM_CUA_HELPER_ENDPOINT",
	"FATHOM_CUA_HELPER_ENDPOINT",
	"MAESTRO_FATHOM_CUA_IPC_ROOT",
	"FATHOM_CUA_IPC_ROOT",
	"FATHOM_IPC_ROOT",
	"MAESTRO_FATHOM_CUA_SESSION_ID",
	"FATHOM_CUA_SESSION_ID",
	"MAESTRO_SESSION_ID",
	"MAESTRO_FATHOM_CUA_TURN_ID",
	"FATHOM_CUA_TURN_ID",
	"MAESTRO_AGENT_RUN_ID",
	"MAESTRO_REQUEST_ID",
	"MAESTRO_FATHOM_CUA_DISABLE_IPC",
	"FATHOM_CUA_DISABLE_IPC",
	"FATHOM_CALLER_PRODUCT",
	"FATHOM_CUA_PRODUCT",
] as const;

class SmokeError extends Error {
	constructor(
		message: string,
		readonly details?: JsonRecord,
	) {
		super(message);
		this.name = "SmokeError";
	}
}

function resolveFathomServerName(
	config: ReturnType<typeof loadMcpConfig>,
): string {
	const server = config.servers.find(
		(candidate) =>
			candidate.env?.FATHOM_CUA_PRODUCT === "maestro" ||
			candidate.env?.FATHOM_CALLER_PRODUCT === "maestro" ||
			candidate.name === "fathom-cua",
	);
	if (!server) {
		throw new SmokeError("Fathom CUA MCP server was not configured", {
			servers: config.servers.map((candidate) => ({
				name: candidate.name,
				scope: candidate.scope,
			})),
		});
	}
	return server.name;
}

interface RunningProcess {
	process: ReturnType<typeof spawn>;
	spawnError: Promise<Error>;
	closed: Promise<ProcessCloseResult>;
	stdout: () => string;
	stderr: () => string;
}

type ProcessCloseResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
};

function hasLiveOptIn(): boolean {
	return (
		process.env.MAESTRO_RUN_LIVE_FATHOM_CUA_MCP === "1" ||
		process.argv.includes("--allow-live")
	);
}

function assertLiveOptIn(): void {
	if (hasLiveOptIn()) {
		return;
	}
	throw new SmokeError(
		"Refusing to run live Fathom CUA MCP smoke without MAESTRO_RUN_LIVE_FATHOM_CUA_MCP=1 or --allow-live.",
		{
			reason:
				"This opens a local AppKit target and performs a real set_value action through Maestro's MCP manager and Fathom Helper IPC.",
		},
	);
}

async function execText(
	command: string,
	args: string[],
	options: { cwd?: string } = {},
): Promise<string> {
	const { stdout } = await execFileAsync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return String(stdout);
}

async function execChecked(
	command: string,
	args: string[],
	options: { cwd?: string } = {},
): Promise<void> {
	await execFileAsync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
}

function spawnCaptured(
	command: string,
	args: string[],
	options: { cwd?: string } = {},
): RunningProcess {
	const child = spawn(command, args, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const spawnError = new Promise<Error>((resolveError) => {
		child.once("error", (error) => {
			resolveError(error);
		});
	});
	const closed = new Promise<ProcessCloseResult>((resolveClose) => {
		child.once("close", (code, signal) => {
			resolveClose({ code, signal });
		});
	});
	child.stdout?.on("data", (chunk: string | Buffer) => {
		stdout += String(chunk);
	});
	child.stderr?.on("data", (chunk: string | Buffer) => {
		stderr += String(chunk);
	});
	return {
		process: child,
		spawnError,
		closed,
		stdout: () => stdout,
		stderr: () => stderr,
	};
}

async function waitForProcess(
	running: RunningProcess,
	timeoutMs: number,
): Promise<number> {
	const child = running.process;
	return new Promise((resolveStatus, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			child.kill();
			reject(
				new SmokeError("Timed out waiting for process", {
					pid: child.pid,
					stdout: running.stdout(),
					stderr: running.stderr(),
				}),
			);
		}, timeoutMs);
		const complete = ({ code, signal }: ProcessCloseResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (signal) {
				reject(
					new SmokeError("Process terminated by signal", {
						code,
						pid: child.pid,
						signal,
						stdout: running.stdout(),
						stderr: running.stderr(),
					}),
				);
				return;
			}
			if (code === null) {
				reject(
					new SmokeError("Process closed without an exit status", {
						pid: child.pid,
						stdout: running.stdout(),
						stderr: running.stderr(),
					}),
				);
				return;
			}
			resolveStatus(code);
		};
		running.spawnError.then((error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(
				new SmokeError("Failed to start process", {
					error: error.message,
					pid: child.pid,
					stdout: running.stdout(),
					stderr: running.stderr(),
				}),
			);
		});
		running.closed.then((code) => complete(code));
	});
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readJsonFile(path: string): Promise<JsonRecord> {
	const text = await readFile(path, "utf8");
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed)) {
		throw new SmokeError(`Expected JSON object at ${path}`);
	}
	return parsed;
}

async function waitForJsonFile(
	path: string,
	predicate: (value: JsonRecord) => boolean,
	timeoutMs: number,
): Promise<JsonRecord> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (existsSync(path)) {
				const value = await readJsonFile(path);
				if (predicate(value)) {
					return value;
				}
			}
		} catch (error) {
			lastError = error;
		}
		await sleep(100);
	}
	throw new SmokeError(`Timed out waiting for ${path}`, {
		lastError:
			lastError instanceof Error ? lastError.message : String(lastError),
	});
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
	if (!isRecord(value)) {
		throw new SmokeError(`${label} was not an object`, { value });
	}
	return value;
}

function asArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new SmokeError(`${label} was not an array`, { value });
	}
	return value;
}

function resolveFathomRepo(): string {
	const configured =
		process.env.MAESTRO_FATHOM_CUA_REPO ?? process.env.FATHOM_CUA_REPO;
	if (configured) {
		return resolve(configured);
	}
	const candidates = [
		resolve(process.cwd(), "..", "fathom"),
		resolve(process.cwd(), "..", "..", "fathom"),
		resolve(process.cwd(), "..", "..", "..", "fathom"),
	];
	const repo = candidates.find((candidate) =>
		existsSync(join(candidate, "cmd", "fathom-client", "main.go")),
	);
	if (!repo) {
		throw new SmokeError("Could not find a Fathom repo checkout", {
			candidates,
			override: "Set MAESTRO_FATHOM_CUA_REPO=/path/to/fathom.",
		});
	}
	return repo;
}

async function swiftBinPath(packageDir: string): Promise<string> {
	return (
		await execText("swift", [
			"build",
			"--package-path",
			packageDir,
			"--show-bin-path",
		])
	).trim();
}

async function buildFathomProducts(packageDir: string): Promise<void> {
	await execChecked("swift", [
		"build",
		"--package-path",
		packageDir,
		"--product",
		"fathom-cua-dogfood-target",
	]);
	await execChecked("swift", [
		"build",
		"--package-path",
		packageDir,
		"--product",
		"fathom-helper",
	]);
}

async function packageTargetApp(
	binDir: string,
	appDir: string,
	displayName: string,
): Promise<void> {
	await rm(appDir, { recursive: true, force: true });
	const macosDir = join(appDir, "Contents", "MacOS");
	await mkdir(macosDir, { recursive: true });
	await copyFile(
		join(binDir, "fathom-cua-dogfood-target"),
		join(macosDir, "fathom-cua-dogfood-target"),
	);
	await writeFile(
		join(appDir, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>fathom-cua-dogfood-target</string>
  <key>CFBundleIdentifier</key>
  <string>${targetBundleId}</string>
  <key>CFBundleName</key>
  <string>${displayName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
`,
	);
}

async function launchDogfoodTarget(
	appDir: string,
	readyFile: string,
	stopFile: string,
	stateFile: string,
): Promise<number> {
	await execChecked("open", [
		"-n",
		appDir,
		"--args",
		"--ready-file",
		readyFile,
		"--stop-file",
		stopFile,
		"--state-file",
		stateFile,
		"--variant",
		"maestro",
		"--window-x",
		"120",
		"--window-y",
		"120",
	]);
	const ready = await waitForJsonFile(
		readyFile,
		(value) => typeof value.pid === "number",
		12_000,
	);
	return Number(ready.pid);
}

async function foreground(pid: number): Promise<void> {
	await execFileAsync(
		"osascript",
		[
			"-e",
			`tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`,
		],
		{ encoding: "utf8" },
	).catch(() => undefined);
}

async function configureIsolatedMcpEnv(
	tempDir: string,
	fathomRepo: string,
	ipcRoot: string,
): Promise<string> {
	const userMcpPath = join(tempDir, "user-mcp.json");
	const enterpriseMcpPath = join(tempDir, "enterprise-mcp.json");
	const projectRoot = join(tempDir, "project-root");
	const projectMcpDir = join(projectRoot, ".maestro");
	const projectMcpPath = join(projectMcpDir, "mcp.json");
	const projectLocalMcpPath = join(projectMcpDir, "mcp.local.json");
	await mkdir(projectMcpDir, { recursive: true });
	await writeFile(userMcpPath, "{}\n");
	await writeFile(enterpriseMcpPath, "{}\n");
	await writeFile(projectMcpPath, "{}\n");
	await writeFile(projectLocalMcpPath, "{}\n");

	for (const name of fathomCuaEnvVars) {
		delete process.env[name];
	}

	process.env.MAESTRO_USER_MCP_PATH = userMcpPath;
	process.env.MAESTRO_ENTERPRISE_MCP_PATH = enterpriseMcpPath;
	process.env.MAESTRO_FATHOM_CUA_ENABLED = "1";
	process.env.MAESTRO_FATHOM_CUA_REPO = fathomRepo;
	process.env.MAESTRO_FATHOM_CUA_WORKSPACE_ID = "workspace_1";
	process.env.MAESTRO_FATHOM_CUA_IPC_ROOT = ipcRoot;
	process.env.MAESTRO_FATHOM_CUA_SESSION_ID = "desktop-session-maestro-smoke";
	process.env.MAESTRO_FATHOM_CUA_TURN_ID = "turn-maestro-smoke";

	return projectRoot;
}

async function callMcpTool(
	manager: McpClientManager,
	serverName: string,
	toolName: string,
	args: JsonRecord,
): Promise<JsonRecord> {
	const result = await manager.callTool(serverName, toolName, args);
	const structured = asRecord(
		result.structuredContent,
		`${toolName} structuredContent`,
	);
	if (
		result.isError ||
		structured.ok === false ||
		typeof structured.error === "string"
	) {
		throw new SmokeError(`Fathom CUA MCP tool ${toolName} failed`, {
			result: structured,
			content: result.content,
		});
	}
	return structured;
}

function findTextElement(state: JsonRecord): JsonRecord {
	const elements = asArray(state.elements, "get_app_state elements");
	for (const element of elements) {
		const record = asRecord(element, "get_app_state element");
		if (
			record.role === "AXTextField" &&
			record.element_index !== undefined &&
			typeof record.element_path_hash === "string"
		) {
			return record;
		}
	}
	throw new SmokeError("No AXTextField element found in Fathom dogfood state", {
		elementCount: elements.length,
	});
}

function parseHelperReport(output: string): JsonRecord {
	const trimmed = output.trim();
	if (!trimmed) {
		return {};
	}
	return asRecord(JSON.parse(trimmed) as unknown, "helper report");
}

async function runSmoke(): Promise<JsonRecord> {
	assertLiveOptIn();
	const fathomRepo = resolveFathomRepo();
	const packageDir = join(fathomRepo, "macos", "FathomCore");
	const tempDir = await mkdtemp(join(tmpdir(), "maestro-fathom-cua-mcp."));
	const readyFile = join(tempDir, "ready.json");
	const stopFile = join(tempDir, "stop");
	const stateFile = join(tempDir, "state.json");
	const ipcRoot = join(tempDir, "ipc");
	const appDir = join(
		fathomRepo,
		".build",
		"FathomCUADogfoodTargetMaestro.app",
	);
	const manager = new McpClientManager();
	let helper: RunningProcess | undefined;
	let targetPid: number | undefined;

	try {
		await buildFathomProducts(packageDir);
		const binDir = await swiftBinPath(packageDir);
		await packageTargetApp(binDir, appDir, "Fathom CUA Dogfood Target Maestro");
		targetPid = await launchDogfoodTarget(
			appDir,
			readyFile,
			stopFile,
			stateFile,
		);
		await foreground(targetPid);

		helper = spawnCaptured(join(binDir, "fathom-helper"), [
			"live-cua-process-ipc",
			"--indicator-present",
			"--stop-control-present",
			"--agent-runtime-reachable",
			"--ipc-root",
			ipcRoot,
			"--max-requests",
			"2",
			"--idle-timeout-seconds",
			"20",
		]);

		const mcpProjectRoot = await configureIsolatedMcpEnv(
			tempDir,
			fathomRepo,
			ipcRoot,
		);
		const config = loadMcpConfig(mcpProjectRoot);
		const fathomServerName = resolveFathomServerName(config);
		await manager.configure(config);
		await manager.connectAll();
		const status = manager.getStatus();
		const fathomStatus = status.servers.find(
			(server) => server.name === fathomServerName,
		);
		if (!fathomStatus?.connected) {
			throw new SmokeError("Fathom CUA MCP server did not connect", {
				status: fathomStatus,
			});
		}
		const toolNames = manager
			.getAllTools()
			.filter((tool) => tool.server === fathomServerName)
			.map((tool) => tool.tool.name)
			.sort();
		for (const requiredTool of ["get_app_state", "set_value"]) {
			if (!toolNames.includes(requiredTool)) {
				throw new SmokeError(
					"Fathom CUA MCP server is missing a required tool",
					{
						requiredTool,
						toolNames,
					},
				);
			}
		}

		const before = await callMcpTool(
			manager,
			fathomServerName,
			"get_app_state",
			{
				app: targetBundleId,
				reason: "maestro fathom cua mcp smoke",
			},
		);
		const textElement = findTextElement(before);
		const rawValue = `Maestro Fathom CUA MCP ${Date.now()}`;
		const expectedHash = sha256(`set-value:v1:${rawValue}`);
		const action = await callMcpTool(manager, fathomServerName, "set_value", {
			app: targetBundleId,
			element_index: String(textElement.element_index),
			value: rawValue,
		});
		const observedState = await waitForJsonFile(
			stateFile,
			(value) => value.field_value_hash === expectedHash,
			12_000,
		);
		await manager.disconnectAll();
		const helperStatus = helper ? await waitForProcess(helper, 35_000) : 1;
		const helperReport = helper ? parseHelperReport(helper.stdout()) : {};
		if (helperStatus !== 0 || helperReport.ok !== true) {
			throw new SmokeError("Fathom Helper live IPC processor failed", {
				status: helperStatus,
				helperReport,
				stderr: helper?.stderr(),
			});
		}

		const report: JsonRecord = {
			schemaVersion: smokeSchema,
			ok: true,
			source: "maestro-mcp-manager",
			fathomRepo,
			targetBundleId,
			mcpServer: {
				name: fathomServerName,
				connected: true,
				toolCount: toolNames.length,
				requiredTools: ["get_app_state", "set_value"],
			},
			action: {
				tool: "set_value",
				receiptId: action.receipt_id,
				contextSnapshotId: action.context_snapshot_id,
				elementIndex: textElement.element_index,
				elementPathHash: textElement.element_path_hash,
			},
			stateObserved: {
				fieldValueHash: observedState.field_value_hash,
				expectedHash,
				changed: observedState.field_value_hash === expectedHash,
			},
			helper: {
				ok: helperReport.ok,
				processedRequests: helperReport.processed_requests,
			},
			rawValueRedacted: true,
		};
		const encoded = JSON.stringify(report);
		if (encoded.includes(rawValue)) {
			throw new SmokeError("Smoke report leaked the raw desktop value");
		}
		return report;
	} finally {
		await manager.disconnectAll().catch(() => undefined);
		if (helper && helper.process.exitCode === null) {
			helper.process.kill();
		}
		await writeFile(stopFile, "").catch(() => undefined);
		if (targetPid) {
			await execFileAsync("kill", [String(targetPid)]).catch(() => undefined);
		}
		await rm(dirname(readyFile), { recursive: true, force: true }).catch(
			() => undefined,
		);
	}
}

runSmoke()
	.then((report) => {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	})
	.catch((error) => {
		const payload = {
			schemaVersion: smokeSchema,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			details: error instanceof SmokeError ? error.details : undefined,
		};
		process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
		process.exitCode = 1;
	});
