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
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isPathWithin } from "../utils/path-containment.js";
import { resolveShellEnvironment } from "../utils/shell-env.js";
import type { ExecResult, Sandbox } from "./types.js";

const _execAsync = promisify(exec);

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
	/** Additional files or directories that sandboxed code may not read */
	denyRead?: string[];
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
const SANDBOX_ENV_VAR = "MAESTRO_SANDBOX";
const LINUX_NATIVE_UNIMPLEMENTED_MESSAGE =
	"Linux native sandbox enforcement is not implemented in the TypeScript runtime. Refusing to run unsandboxed.";

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

function getGitReadOnlySubpaths(cwd: string): string[] {
	const gitPath = join(cwd, ".git");
	if (!existsSync(gitPath)) {
		return [];
	}

	const readOnlySubpaths = [gitPath];
	try {
		const gitFile = readFileSync(gitPath, "utf-8");
		const match = gitFile.match(/^gitdir:\s*(.+?)\s*$/m);
		const gitDir = match?.[1];
		if (gitDir) {
			readOnlySubpaths.push(
				isAbsolute(gitDir) ? resolve(gitDir) : resolve(cwd, gitDir),
			);
		}
	} catch {
		// .git is usually a directory; only worktree gitfiles need parsing.
	}

	return readOnlySubpaths;
}

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
	roots.push({ root: cwd, readOnlySubpaths: [] });

	const readOnlySubpaths = getGitReadOnlySubpaths(cwd);
	if (readOnlySubpaths.length === 0) {
		return roots;
	}

	return roots.map((root) => ({
		...root,
		readOnlySubpaths: readOnlySubpaths.filter((readOnlySubpath) =>
			isPathWithin(
				canonicalizeForAccess(readOnlySubpath),
				canonicalizeForAccess(root.root),
			),
		),
	}));
}

function canonicalize(path: string): string {
	// On macOS, /var is a symlink to /private/var
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function canonicalizeForAccess(path: string, seen = new Set<string>()): string {
	const resolvedPath = resolve(path);
	const missingSegments: string[] = [];
	let existingParent = resolvedPath;

	while (true) {
		try {
			const stat = lstatSync(existingParent);
			if (stat.isSymbolicLink()) {
				if (seen.has(existingParent)) {
					return resolve(existingParent, ...missingSegments);
				}
				seen.add(existingParent);
				const target = readlinkSync(existingParent);
				const resolvedTarget = isAbsolute(target)
					? target
					: resolve(dirname(existingParent), target);
				return resolve(
					canonicalizeForAccess(resolvedTarget, seen),
					...missingSegments,
				);
			}
			return resolve(canonicalize(existingParent), ...missingSegments);
		} catch {
			// Keep walking upward. Unlike existsSync, lstatSync sees dangling
			// symlinks, so writes through them are checked against their targets.
		}

		const parent = dirname(existingParent);
		if (parent === existingParent) {
			return resolvedPath;
		}
		missingSegments.unshift(basename(existingParent));
		existingParent = parent;
	}
}

function canonicalizeDirectoryEntryForAccess(path: string): string {
	const resolvedPath = resolve(path);
	return resolve(
		canonicalizeForAccess(dirname(resolvedPath)),
		basename(resolvedPath),
	);
}

function isSymbolicLinkPath(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function uniqueCanonicalPaths(paths: string[]): string[] {
	return [...new Set(paths.map((path) => canonicalizeForAccess(path)))];
}

function getDefaultDenyReadRoots(): string[] {
	const home = homedir();
	return [
		join(home, ".aws"),
		join(home, ".ssh"),
		join(home, ".config", "gh"),
		join(home, ".netrc"),
		join(home, ".codex"),
		join(home, ".claude"),
		join(home, ".maestro"),
		join(home, ".config", "maestro"),
		join(home, ".config", "evalops"),
	];
}

function getConfiguredDenyReadRoots(
	policy: NativeSandboxPolicy,
	cwd: string,
): string[] {
	if (policy.mode === "danger-full-access") {
		return [];
	}
	return uniqueCanonicalPaths(
		(policy.denyRead ?? []).map((path) =>
			isAbsolute(path) ? resolve(path) : resolve(cwd, path),
		),
	);
}

function getDefaultDenyReadCarveOutRoots(
	policy: NativeSandboxPolicy,
	cwd: string,
): string[] {
	if (policy.mode === "danger-full-access") {
		return [];
	}
	if (policy.mode === "workspace-write") {
		return uniqueCanonicalPaths(
			getWritableRootsWithCwd(policy, cwd).map((root) => root.root),
		);
	}
	return uniqueCanonicalPaths([cwd, ...(policy.writableRoots ?? [])]);
}

function getDefaultDenyReadRootsWithCarveOuts(
	policy: NativeSandboxPolicy,
	cwd: string,
): Array<{ root: string; carveOutRoots: string[] }> {
	if (policy.mode === "danger-full-access") {
		return [];
	}

	const carveOutRoots = getDefaultDenyReadCarveOutRoots(policy, cwd);
	return uniqueCanonicalPaths(getDefaultDenyReadRoots()).map((root) => ({
		root,
		carveOutRoots: carveOutRoots.filter((carveOutRoot) =>
			isPathWithin(carveOutRoot, root),
		),
	}));
}

function getReadableRootsWithCwd(
	policy: NativeSandboxPolicy,
	cwd: string,
): string[] {
	if (policy.mode === "danger-full-access") {
		return [];
	}
	if (policy.mode === "workspace-write") {
		return uniqueCanonicalPaths(
			getWritableRootsWithCwd(policy, cwd).map((root) => root.root),
		);
	}
	if (policy.mode === "read-only") {
		return [parse(cwd).root];
	}
	return uniqueCanonicalPaths([cwd, ...(policy.writableRoots ?? [])]);
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
			const wr = writableRoots[index]!;
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
					const ro = wr.readOnlySubpaths[subIndex]!;
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
	const deniedReadParams: [string, string][] = [];
	const deniedReadPolicies: string[] = [];

	for (const deniedRoot of getConfiguredDenyReadRoots(policy, cwd)) {
		const denyParam = `DENY_READ_${deniedReadParams.length}`;
		deniedReadParams.push([denyParam, deniedRoot]);
		deniedReadPolicies.push(`(subpath (param "${denyParam}"))`);
	}

	for (const deniedRoot of getDefaultDenyReadRootsWithCarveOuts(policy, cwd)) {
		const denyParam = `DENY_READ_${deniedReadParams.length}`;
		deniedReadParams.push([denyParam, deniedRoot.root]);

		if (deniedRoot.carveOutRoots.length === 0) {
			deniedReadPolicies.push(`(subpath (param "${denyParam}"))`);
			continue;
		}

		const requireParts = [`(subpath (param "${denyParam}"))`];
		for (const carveOutRoot of deniedRoot.carveOutRoots) {
			const carveOutParam = `DENY_READ_EXEMPT_${deniedReadParams.length}`;
			deniedReadParams.push([carveOutParam, carveOutRoot]);
			requireParts.push(`(require-not (subpath (param "${carveOutParam}")))`);
		}
		deniedReadPolicies.push(`(require-all ${requireParts.join(" ")} )`);
	}
	const denyReadPolicy =
		deniedReadPolicies.length > 0
			? `(deny file-read*\n${deniedReadPolicies.join(" ")}\n)`
			: "";

	const networkPolicy = policy.networkAccess ? SEATBELT_NETWORK_POLICY : "";

	// Add Darwin cache dir if available
	const darwinCacheDir = process.env.DARWIN_USER_CACHE_DIR;
	if (darwinCacheDir) {
		params.push(["DARWIN_USER_CACHE_DIR", canonicalize(darwinCacheDir)]);
	}

	// Keep specific read denies after the blanket read allow so denied roots
	// still win under Seatbelt's rule-matching semantics.
	const fullPolicy = `${SEATBELT_BASE_POLICY}\n${fileReadPolicy}\n${denyReadPolicy}\n${fileWritePolicy}\n${networkPolicy}`;

	const args = ["-p", fullPolicy];

	// Add parameter definitions
	for (const [key, value] of [...params, ...deniedReadParams]) {
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

		if (platform() === "linux") {
			console.warn(`[native-sandbox] ${LINUX_NATIVE_UNIMPLEMENTED_MESSAGE}`);
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
		const workingDir = this.resolveWorkingDir(cwd);
		this.assertExecutionCwd(workingDir);
		const mergedEnv = {
			...resolveShellEnvironment(env, { workspaceDir: this.cwd }),
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
					this.cwd,
				);
				child = spawn(SEATBELT_EXECUTABLE, seatbeltArgs, {
					cwd: workingDir,
					env: mergedEnv,
				});
			} else if (platform() === "linux") {
				reject(new Error(LINUX_NATIVE_UNIMPLEMENTED_MESSAGE));
				return;
			} else {
				reject(
					new Error(
						`Native sandbox is not supported on platform ${platform()}. Refusing to run unsandboxed.`,
					),
				);
				return;
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
		const workingDir = this.resolveWorkingDir(options.cwd);
		this.assertExecutionCwd(workingDir);
		const mergedOptions: SpawnOptions = {
			...options,
			cwd: workingDir,
			env: {
				...resolveShellEnvironment(options.env, {
					workspaceDir: this.cwd,
				}),
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
				reject(new Error(LINUX_NATIVE_UNIMPLEMENTED_MESSAGE));
				return;
			} else {
				reject(
					new Error(
						`Native sandbox is not supported on platform ${platform()}. Refusing to run unsandboxed.`,
					),
				);
				return;
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
		const checkedPath = this.assertReadablePath(fullPath);
		return readFileSync(checkedPath, "utf-8");
	}

	/**
	 * Write a file to the sandbox.
	 */
	async writeFile(path: string, content: string): Promise<void> {
		if (this.policy.mode === "read-only") {
			throw new Error("Cannot write files in read-only sandbox mode");
		}

		const fullPath = this.resolvePath(path);
		const checkedPath = this.assertWritablePath(fullPath);

		// Ensure parent directory exists
		const dir = dirname(checkedPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		writeFileSync(checkedPath, content, "utf-8");
	}

	/**
	 * Check if a file exists.
	 */
	async exists(path: string): Promise<boolean> {
		const fullPath = this.resolvePath(path);
		const checkedPath = this.assertReadablePath(fullPath);
		return existsSync(checkedPath);
	}

	/**
	 * List files in a directory.
	 */
	async list(path: string): Promise<string[]> {
		const fullPath = this.resolvePath(path);
		const checkedPath = this.assertReadablePath(fullPath);
		return readdirSync(checkedPath);
	}

	/**
	 * Delete a file or directory.
	 */
	async delete(path: string, recursive?: boolean): Promise<void> {
		if (this.policy.mode === "read-only") {
			throw new Error("Cannot delete files in read-only sandbox mode");
		}

		const fullPath = this.resolvePath(path);
		const canonicalizeTarget = isSymbolicLinkPath(fullPath)
			? canonicalizeDirectoryEntryForAccess
			: canonicalizeForAccess;
		this.assertWritablePath(fullPath, {
			blockReadOnlyDescendants: recursive ?? false,
			canonicalizeTarget,
		});
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
		if (isAbsolute(path)) {
			return resolve(path);
		}
		return resolve(this.cwd, path);
	}

	private assertReadablePath(path: string): string {
		const targetPath = canonicalizeForAccess(path);

		if (this.policy.mode === "danger-full-access") {
			return targetPath;
		}

		const readableRoots = getReadableRootsWithCwd(this.policy, this.cwd);
		for (const deniedRoot of getConfiguredDenyReadRoots(
			this.policy,
			this.cwd,
		)) {
			if (isPathWithin(targetPath, deniedRoot)) {
				throw new Error(`Sandbox read denied: ${path}`);
			}
		}

		for (const deniedRoot of getDefaultDenyReadRootsWithCarveOuts(
			this.policy,
			this.cwd,
		)) {
			if (!isPathWithin(targetPath, deniedRoot.root)) {
				continue;
			}
			if (
				deniedRoot.carveOutRoots.some((carveOutRoot) =>
					isPathWithin(targetPath, carveOutRoot),
				)
			) {
				continue;
			}
			throw new Error(`Sandbox read denied: ${path}`);
		}

		if (readableRoots.some((root) => isPathWithin(targetPath, root))) {
			return targetPath;
		}

		throw new Error(`Sandbox read outside allowed roots: ${path}`);
	}

	private resolveWorkingDir(cwd?: string | URL): string {
		if (!cwd) {
			return this.cwd;
		}
		const cwdPath = typeof cwd === "string" ? cwd : fileURLToPath(cwd);
		if (isAbsolute(cwdPath)) {
			return resolve(cwdPath);
		}
		return resolve(this.cwd, cwdPath);
	}

	private assertExecutionCwd(workingDir: string): void {
		if (this.policy.mode !== "workspace-write") {
			return;
		}

		const targetPath = canonicalizeForAccess(workingDir);
		const allowedRoots = getWritableRootsWithCwd(this.policy, this.cwd).map(
			(root) => canonicalizeForAccess(root.root),
		);

		if (!allowedRoots.some((root) => isPathWithin(targetPath, root))) {
			throw new Error(
				`Cannot execute workspace-write command outside workspace or explicit writable roots: ${workingDir}`,
			);
		}

		this.assertWritablePath(targetPath);
	}

	private assertWritablePath(
		path: string,
		options?: {
			blockReadOnlyDescendants?: boolean;
			canonicalizeTarget?: (path: string) => string;
		},
	): string {
		if (this.policy.mode === "danger-full-access") {
			return canonicalizeForAccess(path);
		}

		const targetPath = (options?.canonicalizeTarget ?? canonicalizeForAccess)(
			path,
		);
		const writableRoots = getWritableRootsWithCwd(this.policy, this.cwd);
		let hasMatchingWritableRoot = false;
		let blockedByReadOnlySubpath = false;

		for (const root of writableRoots) {
			const rootPath = canonicalizeForAccess(root.root);
			if (!isPathWithin(targetPath, rootPath)) {
				continue;
			}

			hasMatchingWritableRoot = true;
			if (
				root.readOnlySubpaths.some((readOnlySubpath) => {
					const readOnlyPath = canonicalizeForAccess(readOnlySubpath);
					return (
						isPathWithin(targetPath, readOnlyPath) ||
						(options?.blockReadOnlyDescendants === true &&
							isPathWithin(readOnlyPath, targetPath))
					);
				})
			) {
				blockedByReadOnlySubpath = true;
			}
		}

		if (!hasMatchingWritableRoot || blockedByReadOnlySubpath) {
			throw new Error(
				`Cannot write outside writable roots in ${this.policy.mode} sandbox mode: ${path}`,
			);
		}

		return targetPath;
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
		return false;
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
