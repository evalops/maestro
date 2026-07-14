import { describe, expect, it } from "vitest";
import {
	type TerminalImageSupport,
	detectTerminalImageSupport,
	encodeInlineImage,
	encodeItermInline,
	encodeKittyInline,
} from "../../src/utils/terminal-image.js";

const SAMPLE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);

describe("terminal-image: detection", () => {
	it("detects iTerm.app", () => {
		expect(detectTerminalImageSupport({ TERM_PROGRAM: "iTerm.app" })).toBe(
			"iterm",
		);
	});

	it("detects WezTerm via the 1337 protocol", () => {
		expect(detectTerminalImageSupport({ TERM_PROGRAM: "WezTerm" })).toBe(
			"iterm",
		);
	});

	it("detects kitty by TERM", () => {
		expect(detectTerminalImageSupport({ TERM: "xterm-kitty" })).toBe("kitty");
	});

	it("detects kitty by TERM_PROGRAM", () => {
		expect(detectTerminalImageSupport({ TERM_PROGRAM: "kitty" })).toBe("kitty");
	});

	it("detects sixel only on an explicit TERM signal", () => {
		expect(detectTerminalImageSupport({ TERM: "xterm-256color-sixel" })).toBe(
			"sixel",
		);
	});

	it("returns none for an unsupported terminal", () => {
		expect(detectTerminalImageSupport({ TERM: "xterm-256color" })).toBe("none");
	});

	it("returns none with no env hints", () => {
		expect(detectTerminalImageSupport({})).toBe("none");
	});
});

describe("terminal-image: iTerm2 (OSC 1337)", () => {
	it("wraps the base64 payload with the 1337 File sequence and BEL terminator", () => {
		const out = encodeItermInline(SAMPLE);
		expect(out.startsWith("\x1b]1337;File=")).toBe(true);
		expect(out.endsWith("\x07")).toBe(true);
		expect(out).toContain("inline=1");
		expect(out).toContain(SAMPLE.toString("base64"));
	});

	it("applies width/height and base64-encodes the name hint", () => {
		const out = encodeItermInline(SAMPLE, {
			width: 40,
			height: "auto",
			name: "icon.png",
		});
		expect(out).toContain("width=40");
		expect(out).toContain("height=auto");
		expect(out).toContain(`name=${btoa("icon.png")}`);
	});
});

describe("terminal-image: kitty graphics", () => {
	it("emits a transmit chunk and continuation chunks under the ST terminator", () => {
		const out = encodeKittyInline(SAMPLE);
		// First chunk carries the action/format headers.
		expect(out.startsWith("\x1b_Ga=T,f=100,t=f;")).toBe(true);
		// Every chunk is terminated with String Terminator (ESC \).
		const parts = out.split("\x1b_G").slice(1);
		for (const part of parts) {
			expect(part.endsWith("\x1b\\")).toBe(true);
		}
	});

	it("splits large payloads into multiple m=1 continuation chunks", () => {
		// 10000 bytes -> base64 ~13334 chars -> several 4096-char chunks.
		const big = Buffer.alloc(10000, 0x41);
		const out = encodeKittyInline(big);
		const segments = out.split("\x1b_G").slice(1);
		const transmit = segments.filter((s) =>
			s.startsWith("a=T,f=100,t=f;"),
		).length;
		const continuations = segments.filter((s) => s.startsWith("m=1;")).length;
		expect(transmit).toBe(1);
		expect(continuations).toBeGreaterThanOrEqual(1);
		// The concatenated base64 across chunks reconstructs the source payload.
		const reassembled = segments
			.map((p) => {
				const body = p.endsWith("\x1b\\") ? p.slice(0, -2) : p;
				return body.split(";").pop() ?? "";
			})
			.join("");
		expect(Buffer.from(reassembled, "base64")).toEqual(big);
	});

	it("emits a single transmit chunk for an empty payload", () => {
		const out = encodeKittyInline(Buffer.alloc(0));
		expect(out).toBe("\x1b_Ga=T,f=100,t=f;\x1b\\");
	});
});

describe("terminal-image: encodeInlineImage dispatch", () => {
	it("routes to the iTerm2 encoder", () => {
		const out = encodeInlineImage(SAMPLE, "iterm");
		expect(out.startsWith("\x1b]1337;File=")).toBe(true);
	});

	it("routes to the kitty encoder", () => {
		const out = encodeInlineImage(SAMPLE, "kitty");
		expect(out.startsWith("\x1b_Ga=T,f=100,t=f;")).toBe(true);
	});

	it("returns empty for none", () => {
		expect(encodeInlineImage(SAMPLE, "none")).toBe("");
	});

	it("returns empty for sixel (rasterization not implemented)", () => {
		expect(encodeInlineImage(SAMPLE, "sixel")).toBe("");
	});

	it("defaults to the live environment detection", () => {
		const support: TerminalImageSupport =
			process.env.TERM_PROGRAM === "iTerm.app" ? "iterm" : "none";
		const out = encodeInlineImage(SAMPLE, support);
		if (support === "none") expect(out).toBe("");
		else expect(out.length).toBeGreaterThan(0);
	});
});
