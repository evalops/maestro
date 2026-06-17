/**
 * Snapshot diff markdown renderer
 *
 * Builds on the session snapshot manifest primitive (part 1 of #2657,
 * merged as #2679) and the diff helper (part 2, merged as #2694).
 * Pure renderer that turns a `BoundarySnapshotDiff` into a markdown
 * block suitable for:
 *
 *   - PR comments when an agent posts "this turn touched the
 *     workspace" annotations
 *   - the orchestrator UI's checkpoint inspector
 *   - audit logs that diff one boundary against another
 *
 * Pure function over the diff type. No I/O.
 */

import type {
	BoundarySnapshotDiff,
	ChangedFile,
	SingleSidedFile,
} from "./snapshot-manifest-diff.js";

export interface RenderSnapshotDiffOptions {
	/**
	 * Title for the rendered block. Defaults to "Workspace diff". Pass
	 * `null` to omit the heading (splicing into a larger document).
	 */
	title?: string | null;
	/**
	 * Heading depth offset. `0` (default) → H3. Clamped to [0, 4],
	 * total capped at H6.
	 */
	headingDepthOffset?: number;
	/**
	 * Show the `unchanged` section. Defaults to false (the diff helper
	 * also defaults to omitting it from the data structure).
	 */
	includeUnchanged?: boolean;
	/**
	 * Maximum number of files rendered per section before the renderer
	 * truncates with "… and N more". Defaults to 50.
	 */
	maxFilesPerSection?: number;
}

/**
 * Render `diff` as a markdown block. The output starts with an
 * H3-by-default heading and a summary line, followed by Added,
 * Removed, Changed (and optionally Unchanged) sections.
 */
export function renderSnapshotDiff(
	diff: BoundarySnapshotDiff,
	options: RenderSnapshotDiffOptions = {},
): string {
	const offset = clampOffset(options.headingDepthOffset ?? 0);
	const h = (level: number) => "#".repeat(Math.min(level + offset, 6));
	const maxFiles = options.maxFilesPerSection ?? 50;
	if (!Number.isInteger(maxFiles) || maxFiles < 0) {
		throw new Error(
			`renderSnapshotDiff: maxFilesPerSection must be a non-negative integer, got ${maxFiles}`,
		);
	}

	const lines: string[] = [];
	if (options.title !== null) {
		const title = options.title ?? "Workspace diff";
		lines.push(`${h(3)} ${escapeMd(title)}`);
		lines.push("");
	}

	const summaryParts: string[] = [];
	if (diff.added.length > 0) summaryParts.push(`+${diff.added.length} added`);
	if (diff.removed.length > 0)
		summaryParts.push(`-${diff.removed.length} removed`);
	if (diff.changed.length > 0)
		summaryParts.push(`~${diff.changed.length} changed`);
	const includeUnchanged =
		options.includeUnchanged === true && diff.unchanged.length > 0;
	if (summaryParts.length === 0 && !includeUnchanged) {
		lines.push("_No changes._");
		return lines.join("\n");
	}
	if (summaryParts.length > 0) {
		lines.push(`**Summary:** ${summaryParts.join(" · ")}`);
	} else {
		// All real-change sections are empty but the caller asked for
		// the unchanged section — render a brief summary so the
		// "Unchanged" block isn't dangling under an empty heading.
		lines.push(
			`_No added / removed / changed files; ${diff.unchanged.length} unchanged._`,
		);
	}

	if (diff.added.length > 0) {
		lines.push("");
		lines.push(`${h(4)} Added (${diff.added.length})`);
		lines.push("");
		appendSingleSided(lines, diff.added, maxFiles);
	}
	if (diff.removed.length > 0) {
		lines.push("");
		lines.push(`${h(4)} Removed (${diff.removed.length})`);
		lines.push("");
		appendSingleSided(lines, diff.removed, maxFiles);
	}
	if (diff.changed.length > 0) {
		lines.push("");
		lines.push(`${h(4)} Changed (${diff.changed.length})`);
		lines.push("");
		appendChanged(lines, diff.changed, maxFiles);
	}
	if (includeUnchanged) {
		lines.push("");
		lines.push(`${h(4)} Unchanged (${diff.unchanged.length})`);
		lines.push("");
		appendSingleSided(lines, diff.unchanged, maxFiles);
	}

	return lines.join("\n");
}

function appendSingleSided(
	lines: string[],
	files: readonly SingleSidedFile[],
	maxFiles: number,
): void {
	const visible = files.slice(0, maxFiles);
	for (const file of visible) {
		lines.push(`- ${codeSpan(file.path)} _(${formatBytes(file.size)})_`);
	}
	if (files.length > maxFiles) {
		lines.push(`- _… and ${files.length - maxFiles} more_`);
	}
}

function appendChanged(
	lines: string[],
	files: readonly ChangedFile[],
	maxFiles: number,
): void {
	const visible = files.slice(0, maxFiles);
	for (const file of visible) {
		const delta = file.toSize - file.fromSize;
		const deltaLabel =
			delta === 0 ? "no size change" : `${delta > 0 ? "+" : ""}${delta} bytes`;
		lines.push(
			`- ${codeSpan(file.path)} _(${formatBytes(file.fromSize)} → ${formatBytes(file.toSize)}, ${deltaLabel})_`,
		);
	}
	if (files.length > maxFiles) {
		lines.push(`- _… and ${files.length - maxFiles} more_`);
	}
}

/**
 * Wrap `input` in a markdown inline code span chosen to safely
 * survive embedded backticks. CommonMark requires the delimiter
 * length to differ from any backtick run inside the body, and treats
 * backslash escapes as literal characters inside code spans (so
 * `\\\`` doesn't close the span). We pick the shortest delimiter that
 * isn't present as a run inside the content. Newlines collapse to a
 * single space so the span can't bleed across lines.
 */
function codeSpan(input: string): string {
	const collapsed = input.replace(/\r?\n|\r/g, " ");
	// Pick a delimiter strictly longer than every backtick run inside
	// the body. The shorter "skip lengths that appear in the body"
	// approach is CommonMark-legal but fragile — some renderers (and
	// some Bugbot scans) read shorter-than-the-longest-run delimiters
	// as ambiguous. Matching git-ai-note-render's helper here keeps
	// the markdown obviously well-formed.
	const runs = collapsed.match(/`+/g) ?? [];
	const longestRun = runs.reduce((max, r) => Math.max(max, r.length), 0);
	const delim = "`".repeat(longestRun + 1);
	// Pad with a space whenever the body contains a backtick, or when
	// the body starts/ends with a backtick. CommonMark strips the
	// leading + trailing space at render time but the raw markdown
	// stays readable and the delimiters don't visually merge with the
	// body. When the body has no backticks at all we keep the tight
	// form (`x`) so the common-case paths don't grow extra padding.
	const needsPad = collapsed.includes("`");
	const body = needsPad ? ` ${collapsed} ` : collapsed;
	return `${delim}${body}${delim}`;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function clampOffset(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 4) return 4;
	return Math.floor(value);
}

function escapeMd(input: string): string {
	return input
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/_/g, "\\_")
		.replace(/\*/g, "\\*")
		.replace(/\r?\n|\r/g, " ");
}
