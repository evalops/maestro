import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";

export function archivedLogPath(logPath: string, index: number): string {
	return `${logPath}.${index}.gz`;
}

export function rotateArchives(logPath: string, maxSegments: number): void {
	for (let index = maxSegments; index >= 1; index -= 1) {
		const currentPath = archivedLogPath(logPath, index);
		if (!existsSync(currentPath)) {
			continue;
		}
		if (index === maxSegments) {
			try {
				unlinkSync(currentPath);
			} catch {}
		} else {
			const nextPath = archivedLogPath(logPath, index + 1);
			try {
				renameSync(currentPath, nextPath);
			} catch {}
		}
	}
}

export function deleteArchives(logPath: string, maxSegments: number): void {
	const max = Math.max(maxSegments + 5, 5);
	for (let index = 1; index <= max; index += 1) {
		const archived = archivedLogPath(logPath, index);
		if (existsSync(archived)) {
			try {
				unlinkSync(archived);
			} catch {}
		}
	}
}

export function readLogSegment(logPath: string): string {
	try {
		const data = readFileSync(logPath);
		if (logPath.endsWith(".gz")) {
			return gunzipSync(data).toString("utf8");
		}
		return data.toString("utf8");
	} catch {
		return "";
	}
}

export function trimLogText(text: string, tailBytes: number): string {
	if (text.length <= tailBytes) {
		return text;
	}
	return text.slice(-tailBytes);
}

export function tailLogs(
	logPath: string,
	logSegments: number,
	tailBytes: number,
	lines: number,
): string {
	const segments: string[] = [];
	for (let index = logSegments; index >= 1; index -= 1) {
		const archivedPath = archivedLogPath(logPath, index);
		if (existsSync(archivedPath)) {
			const text = trimLogText(readLogSegment(archivedPath), tailBytes);
			if (text) {
				segments.push(text);
			}
		}
	}
	if (existsSync(logPath)) {
		const stat = statSync(logPath);
		if (stat.size > 0) {
			const readSize = Math.min(stat.size, tailBytes);
			const buffer = Buffer.alloc(readSize);
			const fd = openSync(logPath, "r");
			readSync(fd, buffer, 0, readSize, stat.size - readSize);
			closeSync(fd);
			segments.push(trimLogText(buffer.toString("utf8"), tailBytes));
		}
	}
	if (segments.length === 0) {
		return "No logs available.";
	}
	const combined = segments.join("\n").trimEnd();
	if (!combined) {
		return "No logs available.";
	}
	const logLines = combined.split(/\r?\n/);
	const tail = logLines.slice(-lines);
	return tail.join("\n");
}

export function previewLastLine(
	logPath: string,
	logSegments: number,
	tailBytes: number,
	lines: number,
	sanitize: (value: string) => string,
): string | undefined {
	const text = tailLogs(logPath, logSegments, tailBytes, lines).trim();
	if (!text || text === "No logs available.") {
		return undefined;
	}
	const entries = text.split(/\r?\n/).filter(Boolean);
	return sanitize(entries[entries.length - 1]);
}
