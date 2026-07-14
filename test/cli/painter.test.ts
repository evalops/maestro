import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatPainterHelp,
	handlePainterCommand,
	resolveInlineDisplay,
} from "../../src/cli/commands/painter.js";

function makeSink(isTTY = true): {
	stream: NodeJS.WritableStream;
	chunks: string[];
} {
	const chunks: string[] = [];
	const stream = {
		write: (c: unknown) => {
			chunks.push(String(c));
			return true;
		},
		isTTY,
	};
	return { stream: stream as unknown as NodeJS.WritableStream, chunks };
}

describe("painter cli: formatPainterHelp", () => {
	it("documents the show subcommand", () => {
		const help = formatPainterHelp();
		expect(help).toContain("maestro painter show");
		expect(help).toMatch(/iTerm2|WezTerm|kitty/);
	});
});

describe("painter cli: resolveInlineDisplay", () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

	it("produces an escape for a supported terminal", () => {
		const r = resolveInlineDisplay(png, { support: "iterm", isTTY: true });
		expect(r.ok).toBe(true);
		expect(r.escape?.startsWith("\x1b]1337;File=")).toBe(true);
	});

	it("rejects when the terminal is unsupported", () => {
		const r = resolveInlineDisplay(png, { support: "none", isTTY: true });
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/not supported/);
		expect(r.reason).toContain("none");
	});

	it("rejects when stdout is not a TTY", () => {
		const r = resolveInlineDisplay(png, { support: "iterm", isTTY: false });
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/not a TTY/);
	});

	it("rejects sixel (rasterization not implemented)", () => {
		const r = resolveInlineDisplay(png, { support: "sixel", isTTY: true });
		expect(r.ok).toBe(false);
	});
});

describe("painter cli: handlePainterCommand", () => {
	let savedExitCode: number | undefined;
	const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

	beforeEach(() => {
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.exitCode = savedExitCode;
	});

	it("prints help when no subcommand is given", async () => {
		const { stream, chunks } = makeSink();
		await handlePainterCommand(undefined, [], stream);
		expect(chunks.join("")).toContain("maestro painter show");
	});

	it("errors on `show` with no path", async () => {
		const { stream } = makeSink();
		await handlePainterCommand("show", [], stream);
		expect(process.exitCode).toBe(1);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/image path/));
	});

	it("errors when the path cannot be read", async () => {
		const { stream } = makeSink();
		await handlePainterCommand("show", ["/nonexistent/x.png"], stream);
		expect(process.exitCode).toBe(1);
		expect(errSpy).toHaveBeenCalledWith(
			expect.stringMatching(/Could not read image/),
		);
	});

	it("writes the inline escape to the sink for a supported terminal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "painter-cli-"));
		try {
			const path = join(dir, "img.png");
			writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
			const { stream, chunks } = makeSink(true);
			// Force iTerm2 detection for the duration of the call.
			const prev = process.env.TERM_PROGRAM;
			process.env.TERM_PROGRAM = "iTerm.app";
			try {
				await handlePainterCommand("show", [path], stream);
			} finally {
				if (prev === undefined) delete process.env.TERM_PROGRAM;
				else process.env.TERM_PROGRAM = prev;
			}
			expect(process.exitCode).toBeUndefined();
			expect(chunks.join("").startsWith("\x1b]1337;File=")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
