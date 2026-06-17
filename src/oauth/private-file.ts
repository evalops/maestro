import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Atomic write of a private (mode 0o600) file with fsync on both the
 * file content AND the parent directory, so a power loss or kernel
 * panic between the rename and a periodic fs flush cannot leave the
 * directory entry pointing at a zero-block inode.
 *
 * The adversarial review (round 2) found that the previous
 * implementation skipped fsync, defeating the atomic-rename guarantee
 * on ext4 (especially with data=writeback) — every OAuth provider's
 * tokens could vanish on a single power loss during a file-mode
 * save. This implementation matches `writeTextFileAtomic` in
 * `src/utils/fs.ts` with `fsync: true` (the default there).
 */
export function writePrivateFileSync(filePath: string, data: string): void {
	const tempPath = join(
		dirname(filePath),
		`.${basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`,
	);

	try {
		writeFileSync(tempPath, data, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		chmodSync(tempPath, 0o600);
		// fsync the temp file so its data blocks land on disk before
		// the rename publishes the new name.
		const fd = openSync(tempPath, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tempPath, filePath);
		chmodSync(filePath, 0o600);
		// fsync the parent directory so the rename itself is durable.
		// On macOS this is a no-op (APFS doesn't require it); on ext4
		// with data=writeback it prevents the "new name, zero blocks"
		// failure mode.
		try {
			const dirFd = openSync(dirname(filePath), "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		} catch {
			// Windows / some FUSE filesystems can't fsync a directory.
			// Best-effort — the file's own fsync is the load-bearing one.
		}
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}
