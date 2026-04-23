import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isProbablyBinary } from "../utils/file-content.js";
import { validatePath } from "../utils/path-validation.js";
import {
	assertWithinWorkspaceRoot,
	resolveWorkspacePath,
} from "./workspace-root.js";

export interface HeadlessUtilityFileReadRequest {
	path: string;
	cwd?: string;
	workspaceRoot?: string;
	offset?: number;
	limit?: number;
}

export interface HeadlessUtilityFileReadResult {
	path: string;
	relative_path: string;
	cwd: string;
	content: string;
	start_line: number;
	end_line: number;
	total_lines: number;
	truncated: boolean;
}

const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 2_000;
const MAX_FILE_BYTES =
	Number.parseInt(
		process.env.MAESTRO_HEADLESS_UTILITY_FILE_READ_MAX_BYTES || "",
		10,
	) || 2 * 1024 * 1024;

function toLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.endsWith("\n")) {
		return normalized.split("\n");
	}
	const trimmed = normalized.slice(0, -1);
	return trimmed ? trimmed.split("\n") : [];
}

export async function readWorkspaceFile(
	request: HeadlessUtilityFileReadRequest,
): Promise<HeadlessUtilityFileReadResult> {
	const cwd =
		resolveWorkspacePath(request.cwd, request.workspaceRoot) ??
		resolveWorkspacePath(undefined, request.workspaceRoot) ??
		resolve(process.cwd());
	const offset = Math.max(1, request.offset ?? 1);
	const limit = Math.max(
		1,
		Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
	);
	const targetPath = resolve(cwd, request.path);
	const validatedPath = await validatePath(targetPath, {
		baseDir: cwd,
		mustExist: true,
		mustBeReadable: true,
		maxSize: MAX_FILE_BYTES,
	});
	assertWithinWorkspaceRoot(validatedPath, request.workspaceRoot);
	const buffer = await readFile(validatedPath);
	if (isProbablyBinary(buffer)) {
		throw new Error(
			`utility_file_read only supports text files: ${request.path}`,
		);
	}

	const lines = toLines(buffer.toString("utf8"));
	if (lines.length > 0 && offset > lines.length) {
		throw new Error(
			`Offset ${offset} is beyond end of file (${lines.length} lines total)`,
		);
	}
	if (lines.length === 0 && offset > 1) {
		throw new Error(`Offset ${offset} is beyond end of file (0 lines total)`);
	}

	const startIndex = lines.length === 0 ? 0 : offset - 1;
	const endIndex = Math.min(lines.length, startIndex + limit);
	return {
		path: validatedPath,
		relative_path: relative(cwd, validatedPath) || validatedPath,
		cwd,
		content: lines.slice(startIndex, endIndex).join("\n"),
		start_line: lines.length === 0 ? 0 : startIndex + 1,
		end_line: lines.length === 0 ? 0 : endIndex,
		total_lines: lines.length,
		truncated: endIndex < lines.length,
	};
}
