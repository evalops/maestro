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
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadMcpConfig, McpClientManager } from "../src/mcp/index.js";

type JsonRecord = Record<string, unknown>;

const execFileAsync = promisify(execFile);
const targetBundleIdPrefix = "com.evalops.fathom.cua-dogfood-target";
const smokeSchema = "maestro.fathom-cua-mcp-smoke.v1";
const userActivityIdleDelayMs = 2_750;
const stateReadinessAttempts = 8;
const stateReadinessDelayMs = 650;
const focusSettleDelayMs = 150;
const desktopActionRecoveryAttempts = 1;
const focusedProofs = [
	{
		name: "text-value",
		tool: "set_value",
		bundleSuffix: "text",
		displayName: "Fathom CUA Text Proof",
		elementRole: "AXTextField",
	},
	{
		name: "toggle-state",
		tool: "set_toggle_state",
		bundleSuffix: "toggle",
		displayName: "Fathom CUA Toggle Proof",
		elementRole: "AXCheckBox",
	},
	{
		name: "slider-value",
		tool: "set_slider_value",
		bundleSuffix: "slider",
		displayName: "Fathom CUA Slider Proof",
		elementRole: "AXSlider",
	},
	{
		name: "menu-option",
		tool: "select_menu_option",
		bundleSuffix: "menu",
		displayName: "Fathom CUA Menu Proof",
		elementRole: "AXPopUpButton",
	},
] as const;
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
				"This opens local AppKit proof targets and performs real desktop actions through Maestro's MCP manager and Fathom Helper IPC.",
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

async function assertUnlockedConsoleSession(): Promise<void> {
	let sessionState: string;
	try {
		sessionState = await execText("ioreg", ["-n", "Root", "-d1"]);
	} catch (error) {
		throw new SmokeError("Could not inspect macOS console lock state", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (sessionState.includes('"CGSSessionScreenIsLocked"=Yes')) {
		throw new SmokeError(
			"Refusing live Fathom CUA MCP smoke while macOS console is locked",
			{
				reason:
					"macOS does not expose usable application windows to Accessibility while the console is locked, so desktop CUA proof would only see menu-bar nodes.",
				nextStep: "Unlock the desktop session and rerun the smoke.",
			},
		);
	}
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
	bundleId: string,
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
  <string>${bundleId}</string>
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
	variant: string,
	windowX: number,
	windowY: number,
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
		variant,
		"--window-x",
		String(windowX),
		"--window-y",
		String(windowY),
	]);
	const ready = await waitForJsonFile(
		readyFile,
		(value) => typeof value.pid === "number",
		12_000,
	);
	return Number(ready.pid);
}

function appleScriptString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function execOptional(
	command: string,
	args: string[],
): Promise<string | undefined> {
	try {
		await execFileAsync(command, args, { encoding: "utf8" });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function foreground(pid: number, bundleId: string): Promise<string[]> {
	const failures: string[] = [];
	const processFailure = await execOptional("osascript", [
		"-e",
		`tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`,
	]);
	if (processFailure) {
		failures.push(`pid:${processFailure}`);
	}
	const bundleFailure = await execOptional("osascript", [
		"-e",
		`tell application id ${appleScriptString(bundleId)} to activate`,
	]);
	if (bundleFailure) {
		failures.push(`bundle:${bundleFailure}`);
	}
	return failures;
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

function tryFindElementByRole(
	state: JsonRecord,
	role: string,
): JsonRecord | undefined {
	const elements = asArray(state.elements, "get_app_state elements");
	for (const element of elements) {
		const record = asRecord(element, "get_app_state element");
		if (
			record.role === role &&
			record.element_index !== undefined &&
			typeof record.element_path_hash === "string"
		) {
			return record;
		}
	}
	return undefined;
}

function roleHistogram(elements: unknown[]): JsonRecord {
	const histogram: Record<string, number> = {};
	for (const element of elements) {
		const record = asRecord(element, "get_app_state element");
		const role = typeof record.role === "string" ? record.role : "unknown";
		histogram[role] = (histogram[role] ?? 0) + 1;
	}
	return histogram;
}

function parseHelperReport(output: string): JsonRecord {
	const trimmed = output.trim();
	if (!trimmed) {
		return {};
	}
	return asRecord(JSON.parse(trimmed) as unknown, "helper report");
}

type FocusedProof = (typeof focusedProofs)[number];

type LaunchedProof = FocusedProof & {
	appDir: string;
	bundleId: string;
	pid: number;
	readyFile: string;
	stateFile: string;
	stopFile: string;
};

type ProbeResult = {
	ok: boolean;
	output: string;
};

type ProofTarget =
	| {
			tool: "set_value";
			rawValue: string;
			expectedHash: string;
	  }
	| {
			tool: "set_toggle_state";
			checked: boolean;
	  }
	| {
			tool: "set_slider_value";
			value: number;
	  }
	| {
			tool: "select_menu_option";
			option: string;
			expectedHash: string;
	  };

async function execProbe(
	command: string,
	args: string[],
): Promise<ProbeResult> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
		return { ok: true, output: `${stdout}${stderr}`.trim() };
	} catch (error) {
		const execError = error as Partial<{
			message: string;
			stdout: unknown;
			stderr: unknown;
		}>;
		const output =
			`${String(execError.stdout ?? "")}${String(execError.stderr ?? "")}`.trim();
		return {
			ok: false,
			output: output || execError.message || String(error),
		};
	}
}

function axReadyProbe(bundleId: string): string {
	return `
import AppKit
import ApplicationServices
import Foundation

let bundleID = ${JSON.stringify(bundleId)}
guard let app = NSRunningApplication
    .runningApplications(withBundleIdentifier: bundleID)
    .first(where: { !$0.isTerminated })
else {
    FileHandle.standardError.write(Data("missing app \\(bundleID)\\n".utf8))
    exit(2)
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success, let value else {
        return ""
    }
    return String(describing: value)
}

func elementArrayAttribute(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success, let elements = value as? [AXUIElement] else {
        return []
    }
    return elements
}

func elementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success, let value else {
        return nil
    }
    return (value as! AXUIElement)
}

let usefulRoles: Set<String> = ["AXWindow", "AXButton", "AXTextField", "AXGroup", "AXCheckBox", "AXSwitch", "AXDisclosureTriangle", "AXRadioButton", "AXList", "AXTable", "AXOutline", "AXRow", "AXCell", "AXPopUpButton", "AXSlider", "AXIncrementor"]
var foundUsefulElement = false
var seenElements = Set<CFHashCode>()
var visited = 0

func walk(_ element: AXUIElement, depth: Int) {
    guard !foundUsefulElement, depth <= 8, visited < 2048 else {
        return
    }
    let elementID = CFHash(element)
    guard !seenElements.contains(elementID) else {
        return
    }
    seenElements.insert(elementID)
    visited += 1
    if usefulRoles.contains(stringAttribute(element, kAXRoleAttribute)) {
        foundUsefulElement = true
        return
    }
    for window in elementArrayAttribute(element, kAXWindowsAttribute) {
        walk(window, depth: depth + 1)
    }
    if let mainWindow = elementAttribute(element, kAXMainWindowAttribute) {
        walk(mainWindow, depth: depth + 1)
    }
    if let focusedWindow = elementAttribute(element, kAXFocusedWindowAttribute) {
        walk(focusedWindow, depth: depth + 1)
    }
    for child in elementArrayAttribute(element, kAXChildrenAttribute) {
        walk(child, depth: depth + 1)
    }
}

walk(AXUIElementCreateApplication(app.processIdentifier), depth: 0)
if foundUsefulElement {
    exit(0)
}
FileHandle.standardError.write(Data("no usable AX window for \\(bundleID); visited=\\(visited)\\n".utf8))
exit(1)
`;
}

async function waitForNativeAxWindow(proof: LaunchedProof): Promise<void> {
	const deadline = Date.now() + 12_000;
	let lastProbe = "";
	let lastActivationFailures: string[] = [];
	while (Date.now() < deadline) {
		lastActivationFailures = await foreground(proof.pid, proof.bundleId);
		await sleep(focusSettleDelayMs);
		const probe = await execProbe("swift", [
			"-e",
			axReadyProbe(proof.bundleId),
		]);
		lastProbe = probe.output;
		if (probe.ok) {
			return;
		}
		await sleep(250);
	}
	throw new SmokeError("Timed out waiting for native AX window", {
		appBundleId: proof.bundleId,
		appDir: proof.appDir,
		pid: proof.pid,
		lastActivationFailures,
		lastProbe,
	});
}

async function stopProofTarget(proof: LaunchedProof): Promise<void> {
	await writeFile(proof.stopFile, "").catch(() => undefined);
	await execFileAsync("kill", [String(proof.pid)]).catch(() => undefined);
}

async function launchProofTarget(
	fathomRepo: string,
	binDir: string,
	tempDir: string,
	proof: FocusedProof,
	index: number,
): Promise<LaunchedProof> {
	const bundleId = `${targetBundleIdPrefix}.${proof.bundleSuffix}`;
	const appDir = join(
		fathomRepo,
		".build",
		`FathomCUADogfoodTargetMaestro-${proof.bundleSuffix}.app`,
	);
	const readyFile = join(tempDir, `${proof.bundleSuffix}.ready.json`);
	const stopFile = join(tempDir, `${proof.bundleSuffix}.stop`);
	const stateFile = join(tempDir, `${proof.bundleSuffix}.state.json`);
	await packageTargetApp(binDir, appDir, bundleId, proof.displayName);
	let launched: LaunchedProof | undefined;
	try {
		const pid = await launchDogfoodTarget(
			appDir,
			readyFile,
			stopFile,
			stateFile,
			proof.name,
			120 + index * 36,
			120 + index * 36,
		);
		launched = {
			...proof,
			appDir,
			bundleId,
			pid,
			readyFile,
			stateFile,
			stopFile,
		};
		await waitForJsonFile(
			stateFile,
			(value) =>
				value.variant === proof.name && value.raw_values_redacted === true,
			12_000,
		);
		await waitForNativeAxWindow(launched);
		return launched;
	} catch (error) {
		if (launched) {
			await stopProofTarget(launched);
		}
		throw error;
	}
}

function actionArgsForProof(
	proof: LaunchedProof,
	element: JsonRecord,
	target: ProofTarget,
): JsonRecord {
	const base = {
		app: proof.bundleId,
		element_index: String(element.element_index),
	};
	switch (proof.tool) {
		case "set_value":
			if (target.tool !== "set_value") break;
			return { ...base, value: target.rawValue };
		case "set_toggle_state":
			if (target.tool !== "set_toggle_state") break;
			return { ...base, checked: target.checked };
		case "set_slider_value":
			if (target.tool !== "set_slider_value") break;
			return { ...base, value: target.value };
		case "select_menu_option":
			if (target.tool !== "select_menu_option") break;
			return { ...base, option: target.option };
	}
	throw new SmokeError("Mismatched Fathom CUA proof target", {
		proofTool: proof.tool,
		targetTool: target.tool,
	});
}

function targetForProof(
	proof: LaunchedProof,
	beforeState: JsonRecord,
	rawValue: string,
): ProofTarget {
	switch (proof.tool) {
		case "set_value": {
			return {
				tool: "set_value",
				rawValue,
				expectedHash: sha256(`set-value:v1:${rawValue}`),
			};
		}
		case "set_toggle_state":
			return {
				tool: "set_toggle_state",
				checked: beforeState.toggle_checked !== true,
			};
		case "set_slider_value":
			return {
				tool: "set_slider_value",
				value: beforeState.slider_value === 75 ? 25 : 75,
			};
		case "select_menu_option": {
			const secondOptionHash = sha256("menu-option:v1:Second Option");
			const option =
				beforeState.menu_option_hash === secondOptionHash
					? "First Option"
					: "Second Option";
			return {
				tool: "select_menu_option",
				option,
				expectedHash: sha256(`menu-option:v1:${option}`),
			};
		}
	}
}

function statePredicateForProof(
	proof: LaunchedProof,
	beforeState: JsonRecord,
	target: ProofTarget,
): (value: JsonRecord) => boolean {
	return (value) =>
		stateChangedFromBefore(proof, beforeState, value) &&
		stateMatchesTarget(proof, value, target);
}

function stateChangedFromBefore(
	proof: LaunchedProof,
	beforeState: JsonRecord,
	afterState: JsonRecord,
): boolean {
	switch (proof.tool) {
		case "set_value":
			return beforeState.field_value_hash !== afterState.field_value_hash;
		case "set_toggle_state":
			return beforeState.toggle_checked !== afterState.toggle_checked;
		case "set_slider_value":
			return beforeState.slider_value !== afterState.slider_value;
		case "select_menu_option":
			return beforeState.menu_option_hash !== afterState.menu_option_hash;
	}
}

function stateMatchesTarget(
	proof: LaunchedProof,
	state: JsonRecord,
	target: ProofTarget,
): boolean {
	switch (proof.tool) {
		case "set_value":
			return (
				target.tool === "set_value" &&
				state.field_value_hash === target.expectedHash
			);
		case "set_toggle_state":
			return (
				target.tool === "set_toggle_state" &&
				state.toggle_checked === target.checked
			);
		case "set_slider_value":
			return (
				target.tool === "set_slider_value" &&
				state.slider_value === target.value
			);
		case "select_menu_option":
			return (
				target.tool === "select_menu_option" &&
				state.menu_option_hash === target.expectedHash
			);
	}
}

function stateEvidenceForProof(
	proof: LaunchedProof,
	beforeState: JsonRecord,
	state: JsonRecord,
	target: ProofTarget,
): JsonRecord {
	const changedFromBefore = stateChangedFromBefore(proof, beforeState, state);
	switch (proof.tool) {
		case "set_value": {
			if (target.tool !== "set_value") break;
			return {
				beforeFieldValueHash: beforeState.field_value_hash,
				fieldValueHash: state.field_value_hash,
				expectedHash: target.expectedHash,
				changedFromBefore,
				changed:
					changedFromBefore && state.field_value_hash === target.expectedHash,
			};
		}
		case "set_toggle_state":
			if (target.tool !== "set_toggle_state") break;
			return {
				beforeToggleChecked: beforeState.toggle_checked,
				toggleChecked: state.toggle_checked,
				expectedChecked: target.checked,
				changedFromBefore,
				changed: changedFromBefore && state.toggle_checked === target.checked,
			};
		case "set_slider_value":
			if (target.tool !== "set_slider_value") break;
			return {
				beforeSliderValue: beforeState.slider_value,
				sliderValue: state.slider_value,
				expectedSliderValue: target.value,
				changedFromBefore,
				changed: changedFromBefore && state.slider_value === target.value,
			};
		case "select_menu_option": {
			if (target.tool !== "select_menu_option") break;
			return {
				beforeMenuOptionHash: beforeState.menu_option_hash,
				menuOptionHash: state.menu_option_hash,
				expectedHash: target.expectedHash,
				expectedOption: target.option,
				changedFromBefore,
				changed:
					changedFromBefore && state.menu_option_hash === target.expectedHash,
			};
		}
	}
	throw new SmokeError("Mismatched Fathom CUA proof evidence target", {
		proofTool: proof.tool,
		targetTool: target.tool,
	});
}

function listedApplicationBundleIds(payload: JsonRecord): string[] {
	return asArray(payload.applications, "list_apps applications")
		.map((application) => asRecord(application, "list_apps application"))
		.map((application) => application.bundle_id)
		.filter((bundleID): bundleID is string => typeof bundleID === "string");
}

type ProofStateSelection = {
	state: JsonRecord;
	element: JsonRecord;
};

type FathomToolCaller = (
	toolName: string,
	args: JsonRecord,
) => Promise<JsonRecord>;

async function waitForProofAppState(
	callTool: FathomToolCaller,
	proof: LaunchedProof,
): Promise<ProofStateSelection> {
	let lastState: JsonRecord | undefined;
	let lastError: unknown;
	let lastActivationFailures: string[] = [];
	for (let attempt = 1; attempt <= stateReadinessAttempts; attempt++) {
		try {
			lastActivationFailures = await foreground(proof.pid, proof.bundleId);
			await sleep(focusSettleDelayMs);
			const state = await callTool("get_app_state", {
				app: proof.bundleId,
				reason: `maestro fathom cua mcp focused proof ${proof.name}`,
			});
			lastState = state;
			const element = tryFindElementByRole(state, proof.elementRole);
			if (element) {
				return { state, element };
			}
		} catch (error) {
			lastError = error;
		}
		if (attempt < stateReadinessAttempts) {
			await sleep(stateReadinessDelayMs);
		}
	}
	const elements = lastState
		? asArray(lastState.elements, "get_app_state elements")
		: [];
	throw new SmokeError(
		`Timed out waiting for ${proof.elementRole} in Fathom dogfood state`,
		{
			appBundleId: proof.bundleId,
			appDir: proof.appDir,
			pid: proof.pid,
			stateReadinessAttempts,
			stateReadinessDelayMs,
			focusSettleDelayMs,
			elementCount: elements.length,
			roleHistogram: roleHistogram(elements),
			lastActivationFailures,
			lastError:
				lastError instanceof Error ? lastError.message : String(lastError),
		},
	);
}

function isRecoverableDesktopActionError(error: unknown): boolean {
	if (!(error instanceof SmokeError)) {
		return false;
	}
	const result = error.details?.result;
	if (!isRecord(result)) {
		return false;
	}
	const nextStep = typeof result.next_step === "string" ? result.next_step : "";
	const reason =
		typeof result.error_reason === "string" ? result.error_reason : "";
	return (
		result.state_valid === false ||
		nextStep.includes("get_app_state") ||
		reason.includes("AX error -25202")
	);
}

async function waitForPostActionProofState(
	callTool: FathomToolCaller,
	proof: LaunchedProof,
	beforeState: JsonRecord,
	target: ProofTarget,
	receiptId: unknown,
): Promise<JsonRecord> {
	let lastState: JsonRecord | undefined;
	let lastError: unknown;
	const matchesTarget = statePredicateForProof(proof, beforeState, target);
	const receiptLabel = typeof receiptId === "string" ? receiptId : "unknown";
	for (let attempt = 1; attempt <= stateReadinessAttempts; attempt++) {
		try {
			const state = await callTool("get_app_state", {
				app: proof.bundleId,
				reason: `maestro fathom cua mcp post-action proof ${proof.name} receipt ${receiptLabel}`,
			});
			lastState = state;
			if (matchesTarget(state)) {
				return state;
			}
		} catch (error) {
			lastError = error;
		}
		if (attempt < stateReadinessAttempts) {
			await sleep(stateReadinessDelayMs);
		}
	}

	throw new SmokeError(
		`Timed out waiting for post-action ${proof.elementRole} proof state`,
		{
			appBundleId: proof.bundleId,
			appDir: proof.appDir,
			pid: proof.pid,
			tool: proof.tool,
			receiptId,
			stateReadinessAttempts,
			stateReadinessDelayMs,
			lastError:
				lastError instanceof Error ? lastError.message : String(lastError),
			lastEvidence: lastState
				? stateEvidenceForProof(proof, beforeState, lastState, target)
				: undefined,
		},
	);
}

async function runSmoke(): Promise<JsonRecord> {
	assertLiveOptIn();
	await assertUnlockedConsoleSession();
	const fathomRepo = resolveFathomRepo();
	const packageDir = join(fathomRepo, "macos", "FathomCore");
	const tempDir = await mkdtemp(join(tmpdir(), "maestro-fathom-cua-mcp."));
	const ipcRoot = join(tempDir, "ipc");
	const manager = new McpClientManager();
	let helper: RunningProcess | undefined;
	const launchedProofs: LaunchedProof[] = [];

	try {
		await buildFathomProducts(packageDir);
		const binDir = await swiftBinPath(packageDir);
		for (const [index, proof] of focusedProofs.entries()) {
			const launched = await launchProofTarget(
				fathomRepo,
				binDir,
				tempDir,
				proof,
				index,
			);
			launchedProofs.push(launched);
		}

		const maxRequests =
			1 +
			launchedProofs.length *
				((stateReadinessAttempts + 1) *
					(1 + desktopActionRecoveryAttempts) +
					stateReadinessAttempts);
		let helperRequestCount = 0;
		helper = spawnCaptured(join(binDir, "fathom-helper"), [
			"live-cua-process-ipc",
			"--indicator-present",
			"--stop-control-present",
			"--agent-runtime-reachable",
			"--ipc-root",
			ipcRoot,
			"--max-requests",
			String(maxRequests),
			"--idle-timeout-seconds",
			"45",
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
		const callFathomTool: FathomToolCaller = async (toolName, args) => {
			try {
				return await callMcpTool(manager, fathomServerName, toolName, args);
			} finally {
				helperRequestCount += 1;
			}
		};
		const toolNames = manager
			.getAllTools()
			.filter((tool) => tool.server === fathomServerName)
			.map((tool) => tool.tool.name)
			.sort();
		const requiredTools = [
			"list_apps",
			"get_app_state",
			...focusedProofs.map((proof) => proof.tool),
		];
		for (const requiredTool of requiredTools) {
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

		const appList = await callFathomTool("list_apps", {
			include_background: true,
		});
		const listedBundleIds = listedApplicationBundleIds(appList);
		const missingListedApps = launchedProofs
			.map((proof) => proof.bundleId)
			.filter((bundleId) => !listedBundleIds.includes(bundleId));
		if (missingListedApps.length > 0) {
			throw new SmokeError("Fathom CUA list_apps missed proof targets", {
				missingListedApps,
			});
		}

		const actionProofs: JsonRecord[] = [];
		for (const proof of launchedProofs) {
			let selection = await waitForProofAppState(callFathomTool, proof);
			let element = selection.element;
			const rawValue = `Maestro Fathom CUA MCP ${proof.name} ${Date.now()}`;
			let beforeState = selection.state;
			let target = targetForProof(proof, beforeState, rawValue);
			let action: JsonRecord | undefined;
			let recoveries = 0;
			for (;;) {
				await sleep(userActivityIdleDelayMs);
				try {
					action = await callFathomTool(
						proof.tool,
						actionArgsForProof(proof, element, target),
					);
					break;
				} catch (error) {
					if (
						recoveries >= desktopActionRecoveryAttempts ||
						!isRecoverableDesktopActionError(error)
					) {
						throw error;
					}
					recoveries += 1;
					selection = await waitForProofAppState(callFathomTool, proof);
					element = selection.element;
					beforeState = selection.state;
					target = targetForProof(proof, beforeState, rawValue);
				}
			}
			if (!action) {
				throw new SmokeError("Fathom CUA MCP action was not attempted", {
					tool: proof.tool,
				});
			}
			const observedState = await waitForPostActionProofState(
				callFathomTool,
				proof,
				beforeState,
				target,
				action.receipt_id,
			);
			actionProofs.push({
				name: proof.name,
				appBundleId: proof.bundleId,
				tool: proof.tool,
				elementRole: proof.elementRole,
				idleWaitBeforeActionMs: userActivityIdleDelayMs,
				recoveries,
				receiptId: action.receipt_id,
				contextSnapshotId: action.context_snapshot_id,
				elementIndex: element.element_index,
				elementPathHash: element.element_path_hash,
				stateObserved: stateEvidenceForProof(
					proof,
					beforeState,
					observedState,
					target,
				),
			});
		}
		while (helperRequestCount < maxRequests) {
			await callFathomTool("list_apps", { include_background: false });
		}
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
			targetBundleIds: launchedProofs.map((proof) => proof.bundleId),
			mcpServer: {
				name: fathomServerName,
				connected: true,
				toolCount: toolNames.length,
				requiredTools,
			},
			observabilityProof: {
				tool: "list_apps",
				applicationCount: listedBundleIds.length,
				proofTargetsListed: launchedProofs.length,
			},
			actionProofs,
			helper: {
				ok: helperReport.ok,
				processedRequests: helperReport.processed_requests,
				maxRequests,
			},
			rawValueRedacted: true,
		};
		const encoded = JSON.stringify(report);
		if (encoded.includes("Maestro Fathom CUA MCP ")) {
			throw new SmokeError("Smoke report leaked the raw desktop value");
		}
		return report;
	} finally {
		await manager.disconnectAll().catch(() => undefined);
		if (helper && helper.process.exitCode === null) {
			helper.process.kill();
		}
		for (const proof of launchedProofs) {
			await stopProofTarget(proof);
		}
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
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
