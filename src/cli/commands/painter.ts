/**
 * `maestro painter` CLI command.
 *
 * Today this exposes `maestro painter show <path>`, which renders an image
 * inline in a capable terminal (iTerm2/WezTerm/kitty) by writing the protocol
 * escape straight to stdout. This is the display-only integration for the
 * terminal-image emitter: it never routes through the agent loop, so it cannot
 * waste model tokens or corrupt the conversation context.
 *
 * Run from a plain shell, not inside the full-screen TUI (the TUI owns the
 * screen and would overwrite raw writes).
 */

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	type TerminalImageSupport,
	detectTerminalImageSupport,
	encodeInlineImage,
} from "../../utils/terminal-image.js";

export function formatPainterHelp(): string {
	return [
		"Usage:",
		"  maestro painter show <path>   Render an image inline in a capable terminal",
		"",
		"Requires iTerm2, WezTerm, or kitty. Run from a plain shell, not inside",
		"the full-screen TUI.",
	].join("\n");
}

export interface InlineDisplayResult {
	ok: boolean;
	escape?: string;
	reason?: string;
}

/**
 * Pure policy: decide whether an image buffer can be shown inline and produce
 * the escape sequence. Separated from IO so it is unit-testable.
 */
export function resolveInlineDisplay(
	buf: Buffer,
	opts: { name?: string; isTTY?: boolean; support?: TerminalImageSupport } = {},
): InlineDisplayResult {
	if (opts.isTTY === false) {
		return {
			ok: false,
			reason: "stdout is not a TTY; inline image display requires a terminal.",
		};
	}
	const support = opts.support ?? detectTerminalImageSupport();
	const sequence = encodeInlineImage(buf, support, { name: opts.name });
	if (!sequence) {
		return {
			ok: false,
			reason: `Inline image display is not supported in this terminal (detected: ${support}). Use iTerm2, WezTerm, or kitty.`,
		};
	}
	return { ok: true, escape: sequence };
}

export async function handlePainterCommand(
	subcommand: string | undefined,
	args: string[],
	out: NodeJS.WritableStream = process.stdout,
): Promise<void> {
	if (subcommand === "show") {
		await showImage(args[0], out);
		return;
	}
	out.write(`${formatPainterHelp()}\n`);
}

async function showImage(
	pathArg: string | undefined,
	out: NodeJS.WritableStream,
): Promise<void> {
	if (!pathArg) {
		console.error("maestro painter show requires an image path.");
		process.exitCode = 1;
		return;
	}
	const path = resolve(pathArg);
	let buf: Buffer;
	try {
		buf = await readFile(path);
	} catch {
		console.error(`Could not read image: ${path}`);
		process.exitCode = 1;
		return;
	}

	const result = resolveInlineDisplay(buf, {
		name: basename(path),
		isTTY: (out as { isTTY?: boolean }).isTTY,
	});
	if (!result.ok || !result.escape) {
		console.error(result.reason ?? "Inline image display failed.");
		process.exitCode = 1;
		return;
	}
	out.write(result.escape);
}
