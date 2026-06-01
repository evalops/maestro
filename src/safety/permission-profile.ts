import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
	NativeSandboxMode,
	NativeSandboxPolicy,
} from "../sandbox/native-sandbox.js";
import { isPathWithin } from "../utils/path-containment.js";

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
			return normalizeConcretePath("/tmp", cwd);
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

function constrainAccess(
	requested: FileSystemAccessMode,
	granted: FileSystemAccessMode,
): FileSystemAccessMode {
	return ACCESS_RANK[requested] <= ACCESS_RANK[granted] ? requested : granted;
}

function intersectConcretePathEntries(
	requestedEntry: FileSystemPermissionEntry,
	requestedPath: string,
	grantedEntry: FileSystemPermissionEntry,
	grantedPath: string,
): FileSystemPermissionEntry | undefined {
	if (isPathWithin(requestedPath, grantedPath)) {
		return {
			path: requestedEntry.path,
			access: constrainAccess(requestedEntry.access, grantedEntry.access),
		};
	}
	if (isPathWithin(grantedPath, requestedPath)) {
		return {
			path: grantedEntry.path,
			access: constrainAccess(requestedEntry.access, grantedEntry.access),
		};
	}
	return undefined;
}

function intersectionEntryKey(
	entry: FileSystemPermissionEntry,
	cwd: string,
): string {
	const concretePath = materializePath(entry.path, cwd);
	return concretePath
		? `concrete:${concretePath}`
		: permissionPathKey(entry.path);
}

function coalesceToMostRestrictiveEntries(
	entries: FileSystemPermissionEntry[],
	cwd: string,
): FileSystemPermissionEntry[] {
	const entriesByPath = new Map<string, FileSystemPermissionEntry>();
	for (const entry of entries) {
		const key = intersectionEntryKey(entry, cwd);
		const existing = entriesByPath.get(key);
		if (!existing || ACCESS_RANK[entry.access] < ACCESS_RANK[existing.access]) {
			entriesByPath.set(key, entry);
		}
	}
	return [...entriesByPath.values()];
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

function entryGrantsFullDisk(
	entry: FileSystemPermissionEntry,
	cwd: string,
): boolean {
	const concretePath = materializePath(entry.path, cwd);
	return (
		concretePath !== undefined &&
		normalizeConcretePath(concretePath, cwd) === "/"
	);
}

function profileHasFullDiskWrite(
	profile: PermissionProfile,
	cwd: string,
): boolean {
	return readWriteEntries(profile).some((entry) =>
		entryGrantsFullDisk(entry, cwd),
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

			const intersection = intersectConcretePathEntries(
				requestedEntry,
				requestedPath,
				grantedEntry,
				grantedPath,
			);
			if (intersection) {
				acceptedEntries.push(intersection);
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
				entries: coalesceToMostRestrictiveEntries(
					[...acceptedEntries, ...deniedEntries],
					cwd,
				),
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
	if (policy.mode === "read-only") {
		entries.push({
			path: { kind: "special", value: "full-disk" },
			access: "read-only",
		});
	} else if (policy.mode === "workspace-write") {
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

	if (denyEntries(normalized).length > 0) {
		throw new Error(
			"Cannot convert permission profile with deny rules to native sandbox policy without widening permissions",
		);
	}

	if (profileHasFullDiskWrite(normalized, cwd)) {
		return {
			mode: "danger-full-access",
			networkAccess: normalized.network?.enabled === true,
		};
	}

	const writeEntries = readWriteEntries(normalized);
	if (writeEntries.length === 0) {
		const readOnlyEntries = (normalized.fileSystem?.entries ?? []).filter(
			(entry) => entry.access === "read-only",
		);
		const hasFullDiskRead = readOnlyEntries.some((entry) =>
			entryGrantsFullDisk(entry, cwd),
		);
		const hasScopedReadOnly = readOnlyEntries.some(
			(entry) => !entryGrantsFullDisk(entry, cwd),
		);
		if (hasScopedReadOnly && !hasFullDiskRead) {
			throw new Error(
				"Cannot convert scoped read-only permission profile to native read-only policy without widening read permissions",
			);
		}

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
			if (isPathWithin(cwd, entry.path.path)) {
				includesWorkspace = true;
				if (!isPathWithin(entry.path.path, cwd)) {
					writableRoots.push(entry.path.path);
				}
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
