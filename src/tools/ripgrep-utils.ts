import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { safeJsonParse } from "../utils/json.js";

export const pathSchema = Type.Optional(
	Type.Union([
		Type.String({
			description: "Directory or file to search",
			minLength: 1,
		}),
		Type.Array(
			Type.String({
				description: "Multiple directories or files to search",
				minLength: 1,
			}),
			{ minItems: 1 },
		),
	]),
);

export const globSchema = Type.Optional(
	Type.Union([
		Type.String({
			description: "Glob pattern passed to ripgrep",
			minLength: 1,
		}),
		Type.Array(
			Type.String({
				description: "Multiple glob patterns",
				minLength: 1,
			}),
			{ minItems: 1 },
		),
	]),
);

export function toArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

const MAX_RIPGREP_OUTPUT_BYTES = 2_000_000; // ~2MB safeguard

export async function runRipgrep(
	args: string[],
	signal?: AbortSignal,
	cwd?: string,
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
	truncated: boolean;
}> {
	const child = spawn("rg", args, {
		cwd: cwd ?? process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		signal,
	});

	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let truncated = false;

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => {
			if (stdout.length + chunk.length > MAX_RIPGREP_OUTPUT_BYTES) {
				truncated = true;
				stdout += chunk
					.slice(0, Math.max(0, MAX_RIPGREP_OUTPUT_BYTES - stdout.length))
					.toString();
				child.kill("SIGTERM");
				return;
			}
			stdout += chunk;
		});

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk) => {
			if (stderr.length + chunk.length > MAX_RIPGREP_OUTPUT_BYTES) {
				truncated = true;
				stderr += chunk
					.slice(0, Math.max(0, MAX_RIPGREP_OUTPUT_BYTES - stderr.length))
					.toString();
				child.kill("SIGTERM");
				return;
			}
			stderr += chunk;
		});

		child.once("error", (error) => {
			reject(
				error instanceof Error
					? new Error(`Failed to start ripgrep: ${error.message}`)
					: new Error(`Failed to start ripgrep: ${String(error)}`),
			);
		});

		child.once("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0, truncated });
		});
	});
}

export type RipgrepMatch = {
	file: string;
	line: number;
	column: number;
	match: string;
	lines: string;
};

export function parseRipgrepJson(output: string): RipgrepMatch[] {
	const matches: RipgrepMatch[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parsed = safeJsonParse<unknown>(line, "ripgrep output");
		if (!parsed.success) {
			continue;
		}
		const event = parsed.data as {
			type?: string;
			data?: {
				path?: { text?: string };
				line_number?: number;
				lines?: { text?: string };
				submatches?: Array<{
					start?: number;
					match?: { text?: string };
				}>;
			};
		};
		if (event.type !== "match") {
			continue;
		}
		const pathText = event.data?.path?.text ?? "";
		for (const submatch of event.data?.submatches ?? []) {
			matches.push({
				file: pathText,
				line: event.data?.line_number ?? 0,
				column: submatch.start ?? 0,
				match: submatch.match?.text ?? "",
				lines: event.data?.lines?.text ?? "",
			});
		}
	}
	return matches;
}
