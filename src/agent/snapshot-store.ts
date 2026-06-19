import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	rmdirSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { PATHS } from "../config/constants.js";
import { defaultRuntimeEnv } from "../runtime/env.js";
import { writeTextFileAtomic } from "../utils/fs.js";
import type { RewindPlan, RewindRestoreOp } from "./snapshot-rewind-plan.js";

const SNAPSHOT_SHA256_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/iu;

export interface SnapshotBlobStoreConfig {
	rootDir?: string;
}

export interface RewindExecutionResult {
	targetIndex: number;
	fromIndex: number;
	restored: string[];
	deleted: string[];
	bytesRestored: number;
	dryRun: boolean;
}

type PreparedRewindOp =
	| {
			kind: "delete";
			path: string;
			workspacePath: string;
	  }
	| {
			kind: "restore";
			path: string;
			workspacePath: string;
			content: Buffer;
			size: number;
	  };

export function getSnapshotBlobRoot(rootDir?: string): string {
	return (
		rootDir ??
		defaultRuntimeEnv().snapshotBlobDir ??
		join(PATHS.MAESTRO_HOME, "snapshots", "blobs")
	);
}

export function sha256Content(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export class SnapshotBlobStore {
	private readonly rootDir: string;

	constructor(config: SnapshotBlobStoreConfig = {}) {
		this.rootDir = getSnapshotBlobRoot(config.rootDir);
	}

	put(content: string | Buffer): { contentSha256: string; size: number } {
		const buffer = Buffer.isBuffer(content)
			? content
			: Buffer.from(content, "utf-8");
		const contentSha256 = sha256Content(buffer);
		const path = this.getPath(contentSha256);
		if (!existsSync(path)) {
			writeBlobFileAtomic(path, buffer);
		}
		return { contentSha256, size: buffer.byteLength };
	}

	get(contentSha256: string): Buffer {
		const path = this.getPath(contentSha256);
		if (!existsSync(path)) {
			throw new Error(`snapshot blob not found: ${contentSha256}`);
		}
		return readFileSync(path);
	}

	has(contentSha256: string): boolean {
		return existsSync(this.getPath(contentSha256));
	}

	getPath(contentSha256: string): string {
		const clean = normalizeSnapshotContentSha256(contentSha256);
		return join(this.rootDir, clean.slice(0, 2), clean);
	}
}

export function executeRewindPlan(options: {
	plan: RewindPlan;
	workspaceDir: string;
	store?: SnapshotBlobStore;
	dryRun?: boolean;
}): RewindExecutionResult {
	const store = options.store ?? new SnapshotBlobStore();
	const restored: string[] = [];
	const deleted: string[] = [];
	let bytesRestored = 0;
	const workspaceRoot = realpathSync(resolve(options.workspaceDir));
	const preparedOps = options.plan.ops.map((op): PreparedRewindOp => {
		const workspacePath = resolveWorkspacePlanPath(workspaceRoot, op.path);
		if (op.kind === "delete") {
			return { kind: "delete", path: op.path, workspacePath };
		}
		return {
			kind: "restore",
			path: op.path,
			workspacePath,
			content: readRestoreBlob(op, store),
			size: op.size,
		};
	});
	const plannedDeletePaths = new Set(
		preparedOps.flatMap((op) =>
			op.kind === "delete" ? [op.workspacePath] : [],
		),
	);
	preflightBlockingRestoreDirectories(preparedOps, plannedDeletePaths);
	for (const op of preparedOps) {
		if (op.kind === "delete") {
			if (!options.dryRun) {
				rmSync(op.workspacePath, { force: true, recursive: false });
			}
			deleted.push(op.path);
			continue;
		}
		if (!options.dryRun) {
			pruneBlockingRestoreDirectory(op.workspacePath);
			writeBlobFileAtomic(op.workspacePath, op.content);
		}
		restored.push(op.path);
		bytesRestored += op.size;
	}
	return {
		targetIndex: options.plan.targetIndex,
		fromIndex: options.plan.fromIndex,
		restored,
		deleted,
		bytesRestored,
		dryRun: options.dryRun === true,
	};
}

function resolveWorkspacePlanPath(
	workspaceRoot: string,
	opPath: string,
): string {
	if (!opPath || isAbsolute(opPath)) {
		throw new Error(`rewind plan path must be relative: ${opPath}`);
	}
	if (isParentDirectoryRelPath(opPath)) {
		throw new Error(`rewind plan path escapes workspace: ${opPath}`);
	}
	const resolvedPath = resolve(workspaceRoot, opPath);
	const rel = relative(workspaceRoot, resolvedPath);
	if (!rel || isParentDirectoryRelPath(rel) || isAbsolute(rel)) {
		throw new Error(`rewind plan path escapes workspace: ${opPath}`);
	}
	const workspaceRealRoot = realpathSync(workspaceRoot);
	const parentRealPath = resolveRealPath(dirname(resolvedPath));
	const parentRel = relative(workspaceRealRoot, parentRealPath);
	if (
		(parentRealPath !== workspaceRealRoot && !parentRel) ||
		isParentDirectoryRelPath(parentRel) ||
		isAbsolute(parentRel)
	) {
		throw new Error(`rewind plan path escapes workspace: ${opPath}`);
	}
	return resolvedPath;
}

function isParentDirectoryRelPath(relPath: string): boolean {
	return (
		relPath === ".." || relPath.startsWith("../") || relPath.startsWith("..\\")
	);
}

function resolveRealPath(path: string): string {
	const suffix: string[] = [];
	let current = path;
	while (true) {
		if (existsSync(current)) {
			const realBase = realpathSync(current);
			return suffix.length === 0
				? realBase
				: join(realBase, ...suffix.reverse());
		}
		const parent = dirname(current);
		if (parent === current) {
			return path;
		}
		suffix.push(basename(current));
		current = parent;
	}
}

function preflightBlockingRestoreDirectories(
	ops: readonly PreparedRewindOp[],
	plannedDeletePaths: ReadonlySet<string>,
): void {
	for (const op of ops) {
		if (op.kind !== "restore") continue;
		assertRestoreDirectoryPrunable(
			op.workspacePath,
			op.path,
			plannedDeletePaths,
		);
	}
}

function assertRestoreDirectoryPrunable(
	path: string,
	planPath: string,
	plannedDeletePaths: ReadonlySet<string>,
): void {
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const childPath = join(path, entry.name);
		if (plannedDeletePaths.has(childPath)) continue;
		if (entry.isDirectory()) {
			assertRestoreDirectoryPrunable(childPath, planPath, plannedDeletePaths);
			continue;
		}
		throw new Error(
			`rewind restore target is blocked by unplanned workspace entry: ${planPath}`,
		);
	}
}

function pruneBlockingRestoreDirectory(path: string): void {
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const childPath = join(path, entry.name);
		if (entry.isDirectory()) pruneBlockingRestoreDirectory(childPath);
	}
	rmdirSync(path);
}

function readRestoreBlob(
	op: RewindRestoreOp,
	store: SnapshotBlobStore,
): Buffer {
	const expectedSha256 = normalizeSnapshotContentSha256(op.contentSha256);
	const content = store.get(op.contentSha256);
	if (content.byteLength !== op.size) {
		throw new Error(
			`snapshot blob size mismatch for ${op.path}: expected ${op.size}, got ${content.byteLength}`,
		);
	}
	const actualSha256 = sha256Content(content);
	if (actualSha256 !== expectedSha256) {
		throw new Error(
			`snapshot blob hash mismatch for ${op.path}: expected ${expectedSha256}, got ${actualSha256}`,
		);
	}
	return content;
}

function normalizeSnapshotContentSha256(contentSha256: string): string {
	if (!SNAPSHOT_SHA256_PATTERN.test(contentSha256)) {
		throw new Error(`invalid snapshot blob sha256: ${contentSha256}`);
	}
	return contentSha256.replace(/^sha256:/iu, "").toLowerCase();
}

function writeBlobFileAtomic(path: string, content: Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	writeTextFileAtomic(path, content.toString("binary"), {
		encoding: "binary",
	});
}
