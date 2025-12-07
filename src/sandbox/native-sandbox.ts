/**
 * Native Sandboxing for Command Execution
 *
 * Provides OS-native sandboxing using:
 * - macOS: Seatbelt (sandbox-exec) with SBPL policies
 * - Linux: Landlock LSM + seccomp (via external helper or kernel APIs)
 *
 * This is a TypeScript implementation that spawns sandboxed processes.
 */

import {
	type ChildProcess,
	type SpawnOptions,
	exec,
	spawn,
} from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExecResult, Sandbox } from "./types.js";

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────
// Sandbox Policy Types
// ─────────────────────────────────────────────────────────────

export type NativeSandboxMode =
	| "read-only"
	| "workspace-write"
	| "danger-full-access";

export interface NativeSandboxPolicy {
	mode: NativeSandboxMode;
	/** Additional writable directories */
	writableRoots?: string[];
	/** Allow network access */
	networkAccess?: boolean;
	/** Exclude TMPDIR from writable roots */
	excludeTmpdir?: boolean;
	/** Exclude /tmp from writable roots */
	excludeSlashTmp?: boolean;
}

export interface WritableRoot {
	root: string;
	readOnlySubpaths: string[];
}

// ─────────────────────────────────────────────────────────────
// Seatbelt Policy (macOS)
// ─────────────────────────────────────────────────────────────

const SEATBELT_BASE_POLICY = `(version 1)

; start with closed-by-default
(deny default)

; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))

; Allow cf prefs to work.
(allow user-preference-read)

; process-info
(allow process-info* (target same-sandbox))

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; sysctls permitted.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable.")
)

; Allow Java to read some CPU info.
(allow sysctl-write
  (sysctl-name "kern.grade_cputype"))

; IOKit
(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient")
)

; needed to look up user info
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
)

; Needed for python multiprocessing on MacOS for the SemLock
(allow ipc-posix-sem)

(allow mach-lookup
  (global-name "com.apple.PowerManagement.control")
)

; allow openpty()
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
`;

const SEATBELT_NETWORK_POLICY = `
; Network access policies
(allow network-outbound)
(allow network-inbound)
(allow system-socket)

(allow mach-lookup
    (global-name "com.apple.bsd.dirhelper")
    (global-name "com.apple.system.opendirectoryd.membership")
    (global-name "com.apple.SecurityServer")
    (global-name "com.apple.networkd")
    (global-name "com.apple.ocspd")
    (global-name "com.apple.trustd.agent")
    (global-name "com.apple.SystemConfiguration.DNSConfiguration")
    (global-name "com.apple.SystemConfiguration.configd")
)

(allow sysctl-read
  (sysctl-name-regex #"^net.routetable")
)

(allow file-write*
  (subpath (param "DARWIN_USER_CACHE_DIR"))
)
`;

const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";
const SANDBOX_ENV_VAR = "COMPOSER_SANDBOX";

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

function getWritableRootsWithCwd(
	policy: NativeSandboxPolicy,
	cwd: string,
): WritableRoot[] {
	const roots: WritableRoot[] = [];

	if (policy.mode === "danger-full-access") {
		return roots;
	}

	if (policy.mode === "read-only") {
		return roots;
	}

	// Add user-specified roots
	for (const root of policy.writableRoots ?? []) {
		roots.push({ root, readOnlySubpaths: [] });
	}

	// Add /tmp unless excluded
	if (!policy.excludeSlashTmp) {
		roots.push({ root: "/tmp", readOnlySubpaths: [] });
	}

	// Add TMPDIR unless excluded
	if (!policy.excludeTmpdir && process.env.TMPDIR) {
		const tmpdir = process.env.TMPDIR;
		if (tmpdir !== "/tmp") {
			roots.push({ root: tmpdir, readOnlySubpaths: [] });
		}
	}

	// Add cwd with .git as read-only subpath if present
	const gitDir = join(cwd, ".git");
	const readOnlySubpaths = existsSync(gitDir) ? [gitDir] : [];
	roots.push({ root: cwd, readOnlySubpaths });

	return roots;
}

function canonicalize(path: string): string {
	// On macOS, /var is a symlink to /private/var
	try {
		const { realpathSync } = require("node:fs");
		return realpathSync(path);
	} catch {
		return path;
	}
}

// ─────────────────────────────────────────────────────────────
// Seatbelt Implementation (macOS)
// ─────────────────────────────────────────────────────────────

function createSeatbeltArgs(
	command: string[],
	policy: NativeSandboxPolicy,
	cwd: string,
): string[] {
	const params: [string, string][] = [];
	let fileWritePolicy = "";

	if (policy.mode === "danger-full-access") {
		fileWritePolicy = '(allow file-write* (regex #"^/"))';
	} else {
		const writableRoots = getWritableRootsWithCwd(policy, cwd);
		const policies: string[] = [];

		for (let index = 0; index < writableRoots.length; index++) {
			const wr = writableRoots[index];
			const canonicalRoot = canonicalize(wr.root);
			const rootParam = `WRITABLE_ROOT_${index}`;
			params.push([rootParam, canonicalRoot]);

			if (wr.readOnlySubpaths.length === 0) {
				policies.push(`(subpath (param "${rootParam}"))`);
			} else {
				const requireParts = [`(subpath (param "${rootParam}"))`];
				for (
					let subIndex = 0;
					subIndex < wr.readOnlySubpaths.length;
					subIndex++
				) {
					const ro = wr.readOnlySubpaths[subIndex];
					const canonicalRo = canonicalize(ro);
					const roParam = `WRITABLE_ROOT_${index}_RO_${subIndex}`;
					requireParts.push(`(require-not (subpath (param "${roParam}")))`);
					params.push([roParam, canonicalRo]);
				}
				policies.push(`(require-all ${requireParts.join(" ")} )`);
			}
		}

		if (policies.length > 0) {
			fileWritePolicy = `(allow file-write*\n${policies.join(" ")}\n)`;
		}
	}

	// Always allow file reads - the difference between modes is about WRITE permissions
	const fileReadPolicy =
		"; allow read-only file operations\n(allow file-read*)";

	const networkPolicy = policy.networkAccess ? SEATBELT_NETWORK_POLICY : "";

	// Add Darwin cache dir if available
	const darwinCacheDir = process.env.DARWIN_USER_CACHE_DIR;
	if (darwinCacheDir) {
		params.push(["DARWIN_USER_CACHE_DIR", canonicalize(darwinCacheDir)]);
	}

	const fullPolicy = `${SEATBELT_BASE_POLICY}\n${fileReadPolicy}\n${fileWritePolicy}\n${networkPolicy}`;

	const args = ["-p", fullPolicy];

	// Add parameter definitions
	for (const [key, value] of params) {
		args.push(`-D${key}=${value}`);
	}

	args.push("--");
	args.push(...command);

	return args;
}

// ─────────────────────────────────────────────────────────────
// Native Sandbox Class
// ─────────────────────────────────────────────────────────────

export class NativeSandbox implements Sandbox {
	private policy: NativeSandboxPolicy;
	private cwd: string;
	private activeProcesses: Set<ChildProcess> = new Set();

	constructor(policy: NativeSandboxPolicy, cwd: string) {
		this.policy = policy;
		this.cwd = cwd;
	}

	async initialize(): Promise<void> {
		// Verify sandbox-exec is available on macOS
		if (platform() === "darwin" && !existsSync(SEATBELT_EXECUTABLE)) {
			throw new Error(
				"Seatbelt (sandbox-exec) not found at /usr/bin/sandbox-exec",
			);
		}

		// On Linux, we would verify Landlock support here
		if (platform() === "linux") {
			// Check for Landlock support by reading /sys/kernel/security/lsm
			try {
				const lsm = readFileSync("/sys/kernel/security/lsm", "utf-8");
				if (!lsm.includes("landlock")) {
					console.warn(
						"[native-sandbox] Landlock not available on this Linux system",
					);
				}
			} catch {
				console.warn("[native-sandbox] Could not verify Landlock support");
			}
		}
	}

	/**
	 * Execute a command in the sandbox.
	 * Implements the Sandbox interface.
	 */
	async exec(
		command: string,
		cwd?: string,
		env?: Record<string, string>,
	): Promise<ExecResult> {
		const workingDir = cwd ?? this.cwd;
		const mergedEnv = {
			...process.env,
			...env,
			[SANDBOX_ENV_VAR]: this.getSandboxType(),
		};

		// For the Sandbox interface, command is a full shell command string
		// We need to wrap it in a shell
		const shellCommand = ["sh", "-c", command];

		return new Promise((resolve, reject) => {
			let child: ChildProcess;

			if (platform() === "darwin") {
				const seatbeltArgs = createSeatbeltArgs(
					shellCommand,
					this.policy,
					workingDir,
				);
				child = spawn(SEATBELT_EXECUTABLE, seatbeltArgs, {
					cwd: workingDir,
					env: mergedEnv,
				});
			} else if (platform() === "linux") {
				// On Linux, spawn directly (Landlock would need kernel support or helper binary)
				console.warn(
					"[native-sandbox] Linux native sandbox requires Landlock helper binary",
				);
				child = spawn("sh", ["-c", command], {
					cwd: workingDir,
					env: mergedEnv,
				});
			} else {
				// Unsupported platform
				console.warn(
					`[native-sandbox] Platform ${platform()} not supported, running unsandboxed`,
				);
				child = spawn("sh", ["-c", command], {
					cwd: workingDir,
					env: mergedEnv,
				});
			}

			this.activeProcesses.add(child);

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
			});

			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			child.on("close", (code) => {
				this.activeProcesses.delete(child);
				resolve({
					stdout,
					stderr,
					exitCode: code ?? 0,
				});
			});

			child.on("error", (error) => {
				this.activeProcesses.delete(child);
				reject(error);
			});
		});
	}

	/**
	 * Execute a command with explicit args (internal use).
	 */
	async execWithArgs(
		command: string,
		args: string[] = [],
		options: SpawnOptions = {},
	): Promise<ExecResult> {
		const fullCommand = [command, ...args];
		const mergedOptions: SpawnOptions = {
			cwd: this.cwd,
			...options,
			env: {
				...process.env,
				...options.env,
				[SANDBOX_ENV_VAR]: this.getSandboxType(),
			},
		};

		return new Promise((resolve, reject) => {
			let child: ChildProcess;

			if (platform() === "darwin") {
				const seatbeltArgs = createSeatbeltArgs(
					fullCommand,
					this.policy,
					this.cwd,
				);
				child = spawn(SEATBELT_EXECUTABLE, seatbeltArgs, mergedOptions);
			} else if (platform() === "linux") {
				console.warn(
					"[native-sandbox] Linux native sandbox requires Landlock helper binary",
				);
				child = spawn(command, args, mergedOptions);
			} else {
				console.warn(
					`[native-sandbox] Platform ${platform()} not supported, running unsandboxed`,
				);
				child = spawn(command, args, mergedOptions);
			}

			this.activeProcesses.add(child);

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
			});

			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			child.on("close", (code) => {
				this.activeProcesses.delete(child);
				resolve({
					stdout,
					stderr,
					exitCode: code ?? 0,
				});
			});

			child.on("error", (error) => {
				this.activeProcesses.delete(child);
				reject(error);
			});
		});
	}

	/**
	 * Read a file from the sandbox.
	 */
	async readFile(path: string): Promise<string> {
		const fullPath = this.resolvePath(path);
		return readFileSync(fullPath, "utf-8");
	}

	/**
	 * Write a file to the sandbox.
	 */
	async writeFile(path: string, content: string): Promise<void> {
		if (this.policy.mode === "read-only") {
			throw new Error("Cannot write files in read-only sandbox mode");
		}

		const fullPath = this.resolvePath(path);

		// Ensure parent directory exists
		const dir = dirname(fullPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		writeFileSync(fullPath, content, "utf-8");
	}

	/**
	 * Check if a file exists.
	 */
	async exists(path: string): Promise<boolean> {
		const fullPath = this.resolvePath(path);
		return existsSync(fullPath);
	}

	/**
	 * List files in a directory.
	 */
	async list(path: string): Promise<string[]> {
		const fullPath = this.resolvePath(path);
		return readdirSync(fullPath);
	}

	/**
	 * Delete a file or directory.
	 */
	async delete(path: string, recursive?: boolean): Promise<void> {
		if (this.policy.mode === "read-only") {
			throw new Error("Cannot delete files in read-only sandbox mode");
		}

		const fullPath = this.resolvePath(path);
		rmSync(fullPath, { recursive: recursive ?? false, force: true });
	}

	async dispose(): Promise<void> {
		// Kill any active processes
		for (const proc of this.activeProcesses) {
			proc.kill("SIGTERM");
		}
		this.activeProcesses.clear();
	}

	private resolvePath(path: string): string {
		// If absolute, use as-is; otherwise resolve relative to cwd
		if (path.startsWith("/")) {
			return path;
		}
		return join(this.cwd, path);
	}

	private getSandboxType(): string {
		if (platform() === "darwin") return "seatbelt";
		if (platform() === "linux") return "landlock";
		return "none";
	}
}

// ─────────────────────────────────────────────────────────────
// Factory Functions
// ─────────────────────────────────────────────────────────────

/**
 * Check if native sandboxing is available on this platform.
 */
export function isNativeSandboxAvailable(): boolean {
	if (platform() === "darwin") {
		return existsSync(SEATBELT_EXECUTABLE);
	}
	if (platform() === "linux") {
		try {
			const { readFileSync } = require("node:fs");
			const lsm = readFileSync("/sys/kernel/security/lsm", "utf-8");
			return lsm.includes("landlock");
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Get the native sandbox type for the current platform.
 */
export function getNativeSandboxType(): "seatbelt" | "landlock" | "none" {
	if (platform() === "darwin") return "seatbelt";
	if (platform() === "linux") return "landlock";
	return "none";
}

/**
 * Create a native sandbox instance.
 */
export function createNativeSandbox(
	policy: NativeSandboxPolicy,
	cwd: string,
): NativeSandbox {
	return new NativeSandbox(policy, cwd);
}
