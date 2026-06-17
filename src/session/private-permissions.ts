import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { writeTextFileAtomic } from "../utils/fs.js";

export const PRIVATE_SESSION_DIR_MODE = 0o700;
export const PRIVATE_SESSION_FILE_MODE = 0o600;

export function ensurePrivateSessionDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: PRIVATE_SESSION_DIR_MODE });
	chmodSync(path, PRIVATE_SESSION_DIR_MODE);
}

export function appendPrivateSessionFile(path: string, content: string): void {
	appendFileSync(path, content, {
		encoding: "utf8",
		mode: PRIVATE_SESSION_FILE_MODE,
	});
	chmodSync(path, PRIVATE_SESSION_FILE_MODE);
}

export function writePrivateSessionFile(path: string, content: string): void {
	writeTextFileAtomic(path, content, {
		encoding: "utf-8",
		mode: PRIVATE_SESSION_FILE_MODE,
	});
}
