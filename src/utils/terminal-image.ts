/**
 * Terminal inline-image support detection and escape-sequence emission.
 *
 * Capable terminals (iTerm2, WezTerm, kitty, and sixel-aware terminals) can
 * render image bytes sent via control sequences. This module detects support
 * from the environment and encodes a PNG buffer for the matching protocol.
 *
 * Sixel is detected but not encoded here: sixel requires rasterizing the
 * source image, which needs a real image library. iTerm2 (OSC 1337) and kitty
 * (graphics protocol) both accept the raw image bytes base64-encoded, so they
 * are fully implemented.
 *
 * IMPORTANT: these sequences must be written to a display-only stream (or a
 * TUI render path that strips them before persistence). Tool-result content
 * channels feed the model context as base64, so do NOT route inline escapes
 * through tool text/image content — that wastes tokens and confuses the model.
 *
 * @module utils/terminal-image
 */

export type TerminalImageSupport = "iterm" | "kitty" | "sixel" | "none";

export interface DetectEnv {
	TERM_PROGRAM?: string;
	TERM?: string;
	COLORTERM?: string;
}

/**
 * Detect the best inline-image protocol the current terminal claims to support.
 * Conservative: only returns a protocol when the environment explicitly
 * advertises it.
 */
export function detectTerminalImageSupport(
	env: DetectEnv = process.env,
): TerminalImageSupport {
	const termProgram = env.TERM_PROGRAM ?? "";
	const term = env.TERM ?? "";

	if (termProgram === "iTerm.app" || termProgram === "WezTerm") {
		return "iterm";
	}
	if (term === "xterm-kitty" || termProgram === "kitty") {
		return "kitty";
	}
	// Sixel: some terminals set COLORTERM or accept DECSCUSR queries; we only
	// treat an explicit TERM containing "sixel" as a positive signal.
	if (term.toLowerCase().includes("sixel")) {
		return "sixel";
	}
	return "none";
}

export interface InlineImageOptions {
	/** Display width: pixels, "auto", or N cells (e.g. "40"). Default "auto". */
	width?: string | number;
	/** Display height: pixels, "auto", or N cells. Default "auto". */
	height?: string | number;
	/** Optional filename hint for iTerm2. */
	name?: string;
}

const KITTY_CHUNK_SIZE = 4096;

function b64(buf: Buffer): string {
	return buf.toString("base64");
}

/** Encode a PNG for iTerm2's OSC 1337 inline-image protocol. */
export function encodeItermInline(
	buf: Buffer,
	opts: InlineImageOptions = {},
): string {
	const width = opts.width ?? "auto";
	const height = opts.height ?? "auto";
	const args = [
		"inline=1",
		`width=${width}`,
		`height=${height}`,
		"preserveAspectRatio=0",
	];
	if (opts.name) {
		args.push(`name=${b64(Buffer.from(opts.name, "utf8"))}`);
	}
	return `\x1b]1337;File=${args.join(";")}:${b64(buf)}\x07`;
}

/**
 * Encode a PNG for kitty's graphics protocol, splitting the base64 payload
 * into <=4096-byte chunks with `m=1` continuation markers.
 */
export function encodeKittyInline(buf: Buffer): string {
	const payload = b64(buf);
	const chunks: string[] = [];
	for (let i = 0; i < payload.length; i += KITTY_CHUNK_SIZE) {
		chunks.push(payload.slice(i, i + KITTY_CHUNK_SIZE));
	}
	if (chunks.length === 0) {
		// Empty image: still emit a single transmit chunk.
		return "\x1b_Ga=T,f=100,t=f;\x1b\\";
	}
	const out: string[] = [];
	out.push(`\x1b_Ga=T,f=100,t=f;${chunks[0]}\x1b\\`);
	for (let i = 1; i < chunks.length; i++) {
		out.push(`\x1b_Gm=1;${chunks[i]}\x1b\\`);
	}
	return out.join("");
}

/**
 * Encode an image for the detected protocol. Returns "" when the protocol is
 * unsupported (including sixel, which is detected but not rasterized here).
 */
export function encodeInlineImage(
	buf: Buffer,
	support: TerminalImageSupport = detectTerminalImageSupport(),
	opts: InlineImageOptions = {},
): string {
	switch (support) {
		case "iterm":
			return encodeItermInline(buf, opts);
		case "kitty":
			return encodeKittyInline(buf);
		default:
			return "";
	}
}
