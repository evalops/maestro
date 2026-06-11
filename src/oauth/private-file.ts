import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
		renameSync(tempPath, filePath);
		chmodSync(filePath, 0o600);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}
