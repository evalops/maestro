import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { createTool } from "./tool-dsl.js";

const pathInputSchema = Type.Optional(
	Type.Union([
		Type.String({
			description: "Limit diff to a specific path",
			minLength: 1,
		}),
		Type.Array(
			Type.String({
				description: "Multiple paths to include in the diff",
				minLength: 1,
			}),
			{ minItems: 1 },
		),
	]),
);

const diffSchema = Type.Intersect([
	Type.Object({
		mode: Type.Optional(
			Type.Literal("diff", { description: "Show patch output (default)." }),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory for git commands (internal/testing).",
			}),
		),
		staged: Type.Optional(
			Type.Boolean({
				description:
					"Show staged (index) changes instead of working tree modifications.",
				default: false,
			}),
		),
		range: Type.Optional(
			Type.String({
				description:
					"Git revision or range (for example HEAD~1..HEAD). Overrides staged/worktree scope.",
				minLength: 1,
			}),
		),
		context: Type.Optional(
			Type.Integer({
				description: "Number of context lines to include (git -U).",
				minimum: 0,
				maximum: 1000,
			}),
		),
		stat: Type.Optional(
			Type.Boolean({
				description: "Include a summary (--stat) alongside the patch.",
				default: false,
			}),
		),
		wordDiff: Type.Optional(
			Type.Boolean({
				description: "Highlight changes at the word level (--word-diff=color).",
				default: false,
			}),
		),
		nameOnly: Type.Optional(
			Type.Boolean({
				description: "List only filenames that changed (--name-only).",
				default: false,
			}),
		),
		ignoreWhitespace: Type.Optional(
			Type.Boolean({
				description:
					"Ignore whitespace changes (--ignore-space-change). Useful for comparing reformatted code.",
				default: false,
			}),
		),
		ignoreBlankLines: Type.Optional(
			Type.Boolean({
				description:
					"Ignore changes that only add or remove blank lines (--ignore-blank-lines).",
				default: false,
			}),
		),
		paths: pathInputSchema,
	}),
	Type.Object(
		{},
		{
			description:
				"Cannot request both name-only and word-diff output (diff mode only).",
		},
	),
]);

function normalizePaths(paths: string | string[] | undefined): string[] {
	if (paths === undefined) {
		return [];
	}
	return Array.isArray(paths) ? paths : [paths];
}

async function runGitCommand(
	args: string[],
	signal?: AbortSignal,
	cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = spawn("git", args, {
		cwd: cwd ?? process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		signal,
	});

	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		child.once("error", (error) => {
			reject(
				error instanceof Error
					? new Error(`Failed to start git diff: ${error.message}`)
					: new Error(`Failed to start git diff: ${String(error)}`),
			);
		});

		child.once("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
	});
}

type DiffToolDetails = { command: string; status?: ParsedStatus };

export const diffTool = createTool<typeof diffSchema, DiffToolDetails>({
	name: "diff",
	label: "diff",
	description:
		"Inspect git diffs with optional staging, revision, and path filters.",
	schema: diffSchema,
	async run(params, { signal, respond }) {
		const {
			mode = "diff",
			cwd,
			staged,
			range,
			context,
			stat,
			wordDiff,
			nameOnly,
			ignoreWhitespace,
			ignoreBlankLines,
			paths,
		} = params;

		if (wordDiff && nameOnly) {
			throw new Error("Cannot request both name-only and word-diff output.");
		}

		const pathArgs = normalizePaths(paths);

		if (mode !== "diff") {
			throw new Error(
				"Only diff mode is supported. Use the status tool for git status.",
			);
		}

		const args = ["diff"];

		if (!wordDiff) {
			args.push("--no-color");
		}

		if (stat) {
			args.push("--stat");
		}

		if (context !== undefined) {
			args.push(`-U${context}`);
		}

		if (wordDiff) {
			args.push("--word-diff=color");
		}

		if (nameOnly) {
			args.push("--name-only");
		}

		if (ignoreWhitespace) {
			args.push("--ignore-space-change");
		}

		if (ignoreBlankLines) {
			args.push("--ignore-blank-lines");
		}

		if (range) {
			args.push(range);
		} else if (staged) {
			args.push("--cached");
		}

		if (pathArgs.length > 0) {
			args.push("--", ...pathArgs);
		}

		const commandSummary = ["git", ...args].join(" ");

		let result: { stdout: string; stderr: string; exitCode: number };
		try {
			result = await runGitCommand(args, signal, cwd);
		} catch (error) {
			const reason =
				error instanceof Error
					? error.message
					: `Unknown error: ${String(error)}`;
			return respond
				.text(`git diff failed\n\n${reason}`)
				.detail({ command: commandSummary });
		}

		if (result.exitCode !== 0) {
			const message = result.stderr.trim() || result.stdout.trim();
			throw new Error(
				message.length > 0 ? message : "git diff exited with a non-zero status",
			);
		}

		const output = result.stdout.trim();

		if (output.length === 0) {
			return respond
				.text("No changes found for the selected diff options.")
				.detail({ command: commandSummary });
		}

		return respond.text(output).detail({ command: commandSummary });
	},
});

export type ParsedStatus = {
	branch?: {
		head?: string;
		upstream?: string;
		oid?: string;
		ahead?: number;
		behind?: number;
	};
	files: Array<
		| {
				kind: "change" | "rename" | "unmerged";
				path: string;
				indexStatus?: string;
				worktreeStatus?: string;
				score?: number;
				origPath?: string;
				isCopy?: boolean;
		  }
		| { kind: "untracked" | "ignored"; path: string }
		| { kind: "unknown"; raw: string }
	>;
};

const statusMap: Record<string, string> = {
	" ": "unmodified",
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	U: "unmerged",
};

function mapStatusChar(char: string | undefined): string | undefined {
	if (!char) return undefined;
	return statusMap[char] ?? char;
}

export function parseStatusOutput(raw: string): ParsedStatus {
	const entries = raw.split("\0").filter((line) => line.length > 0);
	const parsed: ParsedStatus = { files: [] };
	const headerPattern = /^(?:[12u!?] |# )/;

	let i = 0;
	while (i < entries.length) {
		const entry = entries[i];

		if (entry.startsWith("# branch.")) {
			parsed.branch ??= {};
			if (entry.startsWith("# branch.oid ")) {
				parsed.branch.oid = entry.slice("# branch.oid ".length).trim();
				i += 1;
				continue;
			}
			if (entry.startsWith("# branch.head ")) {
				parsed.branch.head = entry.slice("# branch.head ".length).trim();
				i += 1;
				continue;
			}
			if (entry.startsWith("# branch.upstream ")) {
				parsed.branch.upstream = entry
					.slice("# branch.upstream ".length)
					.trim();
				i += 1;
				continue;
			}
			if (entry.startsWith("# branch.ab ")) {
				const parts = entry.slice("# branch.ab ".length).trim().split(" ");
				const ahead = Number.parseInt(parts[0]?.replace("+", ""), 10);
				const behind = Number.parseInt(parts[1]?.replace("-", ""), 10);
				parsed.branch.ahead = Number.isNaN(ahead) ? undefined : ahead;
				parsed.branch.behind = Number.isNaN(behind) ? undefined : behind;
				i += 1;
				continue;
			}
			i += 1;
			continue;
		}

		if (entry.startsWith("1 ")) {
			const match = entry.match(
				/^1\s+(\S{2})\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/,
			);
			if (!match) {
				throw new Error(`Malformed type1 entry: ${entry}`);
			}
			const xy = match[1];
			parsed.files.push({
				kind: "change",
				path: match[2],
				indexStatus: mapStatusChar(xy[0]),
				worktreeStatus: mapStatusChar(xy[1]),
			});
			i += 1;
			continue;
		}

		if (entry.startsWith("2 ")) {
			const rename = parseRenameEntry(entry, entries[i + 1], headerPattern);
			if (!rename) {
				throw new Error(`Malformed type2 entry: ${entry}`);
			}
			parsed.files.push(rename.file);
			i += rename.consumed;
			continue;
		}

		if (entry.startsWith("u ")) {
			const match = entry.match(
				/^u\s+(\S{2})\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/,
			);
			if (!match) {
				throw new Error(`Malformed unmerged entry: ${entry}`);
			}
			const xy = match[1];
			parsed.files.push({
				kind: "unmerged",
				path: match[2],
				indexStatus: mapStatusChar(xy[0]),
				worktreeStatus: mapStatusChar(xy[1]),
			});
			i += 1;
			continue;
		}

		if (entry.startsWith("? ")) {
			parsed.files.push({ kind: "untracked", path: entry.slice(2) });
			i += 1;
			continue;
		}

		if (entry.startsWith("! ")) {
			parsed.files.push({ kind: "ignored", path: entry.slice(2) });
			i += 1;
			continue;
		}

		throw new Error(`Unrecognized porcelain v2 entry: ${entry}`);
	}

	return parsed;
}

function parseRenameEntry(
	entry: string,
	nextEntry: string | undefined,
	_headerPattern: RegExp,
): { file: ParsedStatus["files"][number]; consumed: number } | undefined {
	// Format: 2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <hW> <score> <path>
	// Some porcelain v2 outputs omit one of the hash slots; allow 5-7 tokens between <sub> and <score>.
	const match = entry.match(/^2\s+(\S{2})\s+(?:\S+\s+){5,7}([RC]\d+)\s+(.+)$/);
	if (!match) return undefined;

	const xy = match[1];
	const scoreToken = match[2];
	const score =
		scoreToken && /^[RC]\d+$/.test(scoreToken)
			? Number.parseInt(scoreToken.slice(1), 10)
			: Number.NaN;
	const isCopy = scoreToken?.startsWith("C") ?? false;
	const path = match[3];
	// The next porcelain entry is always the original path, even if it starts
	// with characters like "! " that look like another entry prefix. Preserve
	// it as-is to avoid misclassifying paths that start with header markers.
	const origPathCandidate = nextEntry;
	const consumed = nextEntry ? 2 : 1;

	return {
		file: {
			kind: "rename",
			path,
			origPath: origPathCandidate,
			score: Number.isNaN(score) ? undefined : score,
			indexStatus: mapStatusChar(xy[0]),
			worktreeStatus: mapStatusChar(xy[1]),
			isCopy,
		},
		consumed,
	};
}
