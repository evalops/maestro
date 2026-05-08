import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
	NativeSandboxMode,
	NativeSandboxPolicy,
} from "../sandbox/native-sandbox.js";

export type FileSystemAccessMode = "none" | "read-only" | "read-write";

export type FileSystemPermissionPath =
	| { kind: "path"; path: string }
	| { kind: "special"; value: "workspace" | "tmp" | "tmpdir" | "full-disk" }
	| { kind: "glob"; pattern: string };

export interface FileSystemPermissionEntry {
	path: FileSystemPermissionPath;
	access: FileSystemAccessMode;
}

export interface FileSystemPermissions {
	entries: FileSystemPermissionEntry[];
	globScanMaxDepth?: number;
}

export interface NetworkPermissions {
	enabled: boolean;
}

export interface PermissionProfile {
	fileSystem?: FileSystemPermissions;
	network?: NetworkPermissions;
}

export interface NormalizePermissionProfileOptions {
	cwd?: string;
}

export interface IntersectPermissionProfileOptions {
	cwd?: string;
}

const ACCESS_RANK: Record<FileSystemAccessMode, number> = {
	none: 0,
	"read-only": 1,
	"read-write": 2,
};

const PROFILE_DEFAULT_CWD = process.cwd();

function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function normalizeConcretePath(path: string, cwd: string): string {
	return canonicalizePath(
		isAbsolute(path) ? resolve(path) : resolve(cwd, path),
	);
}

function permissionPathKey(path: FileSystemPermissionPath): string {
	switch (path.kind) {
		case "path":
			return `path:${path.path}`;
		case "special":
			return `special:${path.value}`;
		case "glob":
			return `glob:${path.pattern}`;
	}
}

function entryKey(entry: FileSystemPermissionEntry): string {
	return `${permissionPathKey(entry.path)}:${entry.access}`;
}

function normalizeEntry(
	entry: FileSystemPermissionEntry,
	cwd: string,
): FileSystemPermissionEntry {
	if (entry.path.kind === "glob" && entry.access !== "none") {
		throw new Error(
			"Permission profile glob entries may only be deny rules for now",
		);
	}

	if (entry.path.kind !== "path") {
		return entry;
	}

	return {
		...entry,
		path: {
			kind: "path",
			path: normalizeConcretePath(entry.path.path, cwd),
		},
	};
}

function maxGlobScanDepth(
	left: number | undefined,
	right: number | undefined,
): number | undefined {
	if (left === undefined) {
		return right;
	}
	if (right === undefined) {
		return left;
	}
	return Math.max(left, right);
}

function resolveSpecialPath(
	value: Extract<FileSystemPermissionPath, { kind: "special" }>["value"],
	cwd: string,
): string | undefined {
	switch (value) {
		case "workspace":
			return normalizeConcretePath(cwd, cwd);
		case "tmp":
			return "/tmp";
		case "tmpdir":
			return process.env.TMPDIR
				? normalizeConcretePath(process.env.TMPDIR, cwd)
				: undefined;
		case "full-disk":
			return "/";
	}
}

function materializePath(
	path: FileSystemPermissionPath,
	cwd: string,
): string | undefined {
	switch (path.kind) {
		case "path":
			return path.path;
		case "special":
			return resolveSpecialPath(path.value, cwd);
		case "glob":
			return undefined;
	}
}

function isPathWithin(child: string, parent: string): boolean {
	const normalizedChild = resolve(child);
	const normalizedParent = resolve(parent);
	if (normalizedChild === normalizedParent) {
		return true;
	}
	if (normalizedParent === "/") {
		return normalizedChild.startsWith("/");
	}
	const rel = relative(normalizedParent, normalizedChild);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function constrainAccess(
	requested: FileSystemAccessMode,
	granted: FileSystemAccessMode,
): FileSystemAccessMode {
	return ACCESS_RANK[requested] <= ACCESS_RANK[granted] ? requested : granted;
}

function readWriteEntries(
	profile: PermissionProfile,
): FileSystemPermissionEntry[] {
	return (profile.fileSystem?.entries ?? []).filter(
		(entry) => entry.access === "read-write",
	);
}

function denyEntries(profile: PermissionProfile): FileSystemPermissionEntry[] {
	return (profile.fileSystem?.entries ?? []).filter(
		(entry) => entry.access === "none",
	);
}

function profileHasFullDiskWrite(profile: PermissionProfile): boolean {
	return readWriteEntries(profile).some(
		(entry) =>
			entry.path.kind === "special" && entry.path.value === "full-disk",
	);
}

export function normalizePermissionProfile(
	profile: PermissionProfile,
	options: NormalizePermissionProfileOptions = {},
): PermissionProfile {
	const cwd = options.cwd ?? PROFILE_DEFAULT_CWD;
	const entriesByKey = new Map<string, FileSystemPermissionEntry>();

	for (const entry of profile.fileSystem?.entries ?? []) {
		const normalized = normalizeEntry(entry, cwd);
		entriesByKey.set(entryKey(normalized), normalized);
	}

	const entries = [...entriesByKey.values()].sort((left, right) =>
		entryKey(left).localeCompare(entryKey(right)),
	);

	return {
		...(entries.length > 0 || profile.fileSystem?.globScanMaxDepth !== undefined
			? {
					fileSystem: {
						entries,
						...(profile.fileSystem?.globScanMaxDepth !== undefined
							? {
									globScanMaxDepth: profile.fileSystem.globScanMaxDepth,
								}
							: {}),
					},
				}
			: {}),
		...(profile.network
			? { network: { enabled: profile.network.enabled === true } }
			: {}),
	};
}

export function mergePermissionProfiles(
	base: PermissionProfile,
	additional: PermissionProfile,
	options: NormalizePermissionProfileOptions = {},
): PermissionProfile {
	const cwd = options.cwd ?? PROFILE_DEFAULT_CWD;
	const normalizedBase = normalizePermissionProfile(base, { cwd });
	const normalizedAdditional = normalizePermissionProfile(additional, { cwd });

	return normalizePermissionProfile(
		{
			fileSystem: {
				entries: [
					...(normalizedBase.fileSystem?.entries ?? []),
					...(normalizedAdditional.fileSystem?.entries ?? []),
				],
				globScanMaxDepth: maxGlobScanDepth(
					normalizedBase.fileSystem?.globScanMaxDepth,
					normalizedAdditional.fileSystem?.globScanMaxDepth,
				),
			},
			network:
				normalizedBase.network || normalizedAdditional.network
					? {
							enabled:
								normalizedBase.network?.enabled === true ||
								normalizedAdditional.network?.enabled === true,
						}
					: undefined,
		},
		{ cwd },
	);
}

export function intersectPermissionProfiles(
	requested: PermissionProfile,
	granted: PermissionProfile,
	options: IntersectPermissionProfileOptions = {},
): PermissionProfile {
	const cwd = options.cwd ?? PROFILE_DEFAULT_CWD;
	const normalizedRequested = normalizePermissionProfile(requested, { cwd });
	const normalizedGranted = normalizePermissionProfile(granted, { cwd });
	const acceptedEntries: FileSystemPermissionEntry[] = [];

	for (const grantedEntry of normalizedGranted.fileSystem?.entries ?? []) {
		if (grantedEntry.access === "none") {
			continue;
		}

		const grantedPath = materializePath(grantedEntry.path, cwd);
		if (!grantedPath) {
			continue;
		}

		for (const requestedEntry of normalizedRequested.fileSystem?.entries ??
			[]) {
			if (requestedEntry.access === "none") {
				continue;
			}

			const requestedPath = materializePath(requestedEntry.path, cwd);
			if (!requestedPath) {
				continue;
			}

			if (
				isPathWithin(grantedPath, requestedPath)
			) {
				acceptedEntries.push({
					path: grantedEntry.path,
					access: constrainAccess(requestedEntry.access, grantedEntry.access),
				});
				break;
			}
		}
	}

	const deniedEntries = [
		...denyEntries(normalizedRequested),
		...denyEntries(normalizedGranted),
	];

	return normalizePermissionProfile(
		{
			fileSystem: {
				entries: [...acceptedEntries, ...deniedEntries],
				globScanMaxDepth: maxGlobScanDepth(
					normalizedRequested.fileSystem?.globScanMaxDepth,
					normalizedGranted.fileSystem?.globScanMaxDepth,
				),
			},
			network:
				normalizedRequested.network || normalizedGranted.network
					? {
							enabled:
								normalizedRequested.network?.enabled === true &&
								normalizedGranted.network?.enabled === true,
						}
					: undefined,
		},
		{ cwd },
	);
}

export function permissionProfileFromNativeSandboxPolicy(
	policy: NativeSandboxPolicy,
	cwd: string = PROFILE_DEFAULT_CWD,
): PermissionProfile {
	if (policy.mode === "danger-full-access") {
		return normalizePermissionProfile(
			{
				fileSystem: {
					entries: [
						{
							path: { kind: "special", value: "full-disk" },
							access: "read-write",
						},
					],
				},
				network: { enabled: policy.networkAccess !== false },
			},
			{ cwd },
		);
	}

	const entries: FileSystemPermissionEntry[] = [];
	if (policy.mode === "workspace-write") {
		entries.push({
			path: { kind: "special", value: "workspace" },
			access: "read-write",
		});

		for (const root of policy.writableRoots ?? []) {
			entries.push({
				path: { kind: "path", path: root },
				access: "read-write",
			});
		}

		if (!policy.excludeSlashTmp) {
			entries.push({
				path: { kind: "special", value: "tmp" },
				access: "read-write",
			});
		}

		if (!policy.excludeTmpdir) {
			entries.push({
				path: { kind: "special", value: "tmpdir" },
				access: "read-write",
			});
		}
	}

	return normalizePermissionProfile(
		{
			...(entries.length > 0 ? { fileSystem: { entries } } : {}),
			network: { enabled: policy.networkAccess === true },
		},
		{ cwd },
	);
}

export function nativeSandboxPolicyFromPermissionProfile(
	profile: PermissionProfile,
	cwd: string = PROFILE_DEFAULT_CWD,
): NativeSandboxPolicy {
	const normalized = normalizePermissionProfile(profile, { cwd });

	if (profileHasFullDiskWrite(normalized)) {
		return {
			mode: "danger-full-access",
			networkAccess: normalized.network?.enabled === true,
		};
	}

	const writeEntries = readWriteEntries(normalized);
	if (writeEntries.length === 0) {
		return {
			mode: "read-only",
			networkAccess: normalized.network?.enabled === true,
		};
	}

	const writableRoots: string[] = [];
	let includesWorkspace = false;
	let includesSlashTmp = false;
	let includesTmpdir = false;

	for (const entry of writeEntries) {
		if (entry.path.kind === "special") {
			switch (entry.path.value) {
				case "workspace":
					includesWorkspace = true;
					break;
				case "tmp":
					includesSlashTmp = true;
					break;
				case "tmpdir":
					includesTmpdir = true;
					break;
				case "full-disk":
					break;
			}
			continue;
		}

		if (entry.path.kind === "path") {
			if (
				isPathWithin(entry.path.path, cwd) &&
				isPathWithin(cwd, entry.path.path)
			) {
				includesWorkspace = true;
			} else {
				writableRoots.push(entry.path.path);
			}
		}
	}

	if (!includesWorkspace) {
		throw new Error(
			"Cannot convert permission profile to native workspace-write policy without granting workspace write",
		);
	}

	return {
		mode: "workspace-write",
		...(writableRoots.length > 0 ? { writableRoots } : {}),
		networkAccess: normalized.network?.enabled === true,
		excludeSlashTmp: !includesSlashTmp,
		excludeTmpdir: !includesTmpdir,
	};
}

export interface NativeSandboxPolicyInput {
	mode: NativeSandboxMode;
	writableRoots?: string[];
	networkAccess?: boolean;
	excludeTmpdir?: boolean;
	excludeSlashTmp?: boolean;
}

export function buildNativeSandboxPolicy(
	input: NativeSandboxPolicyInput,
	cwd: string = PROFILE_DEFAULT_CWD,
): NativeSandboxPolicy {
	return nativeSandboxPolicyFromPermissionProfile(
		permissionProfileFromNativeSandboxPolicy(
			{
				mode: input.mode,
				writableRoots: input.writableRoots,
				networkAccess: input.networkAccess,
				excludeTmpdir: input.excludeTmpdir,
				excludeSlashTmp: input.excludeSlashTmp,
			},
			cwd,
		),
		cwd,
	);
}
