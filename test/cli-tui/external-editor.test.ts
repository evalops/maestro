import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalEditor } from "../../src/cli-tui/utils/external-editor.js";

describe("openExternalEditor", () => {
	const originalEditor = process.env.EDITOR;
	const originalVisual = process.env.VISUAL;
	let tmpRoot: string;

	const ui = {
		stop: vi.fn(),
		start: vi.fn(),
		requestRender: vi.fn(),
	};

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "external-editor-test-"));
		vi.spyOn(os, "tmpdir").mockReturnValue(tmpRoot);
		ui.stop.mockClear();
		ui.start.mockClear();
		ui.requestRender.mockClear();
		delete process.env.VISUAL;
	});

	afterEach(() => {
		if (originalEditor === undefined) {
			delete process.env.EDITOR;
		} else {
			process.env.EDITOR = originalEditor;
		}
		if (originalVisual === undefined) {
			delete process.env.VISUAL;
		} else {
			process.env.VISUAL = originalVisual;
		}
		vi.restoreAllMocks();
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("uses an exclusive file inside a private temporary directory", () => {
		const marker = path.join(tmpRoot, "marker.json");
		const editorScript = path.join(tmpRoot, "editor.cjs");
		fs.writeFileSync(
			editorScript,
			`
const fs = require("node:fs");
const path = require("node:path");
const file = process.argv[2];
fs.writeFileSync(process.env.MARKER, JSON.stringify({
  basename: path.basename(file),
  dirname: path.basename(path.dirname(file)),
  dirMode: fs.statSync(path.dirname(file)).mode & 0o777,
  fileMode: fs.statSync(file).mode & 0o777,
  isSymlink: fs.lstatSync(file).isSymbolicLink()
}));
fs.writeFileSync(file, "edited\\n");
`,
			"utf-8",
		);
		process.env.EDITOR = `${process.execPath} ${editorScript}`;
		process.env.MARKER = marker;

		const result = openExternalEditor(ui as never, "initial");

		expect(result).toEqual({ updatedText: "edited" });
		const observed = JSON.parse(fs.readFileSync(marker, "utf-8")) as {
			basename: string;
			dirname: string;
			dirMode: number;
			fileMode: number;
			isSymlink: boolean;
		};
		expect(observed.basename).toBe("input.md");
		expect(observed.dirname).toMatch(/^composer-editor-/);
		expect(observed.dirMode & 0o077).toBe(0);
		expect(observed.fileMode).toBe(0o600);
		expect(observed.isSymlink).toBe(false);
		expect(fs.readdirSync(tmpRoot).sort()).toEqual([
			"editor.cjs",
			"marker.json",
		]);
		expect(ui.stop).toHaveBeenCalledOnce();
		expect(ui.start).toHaveBeenCalledOnce();
		expect(ui.requestRender).toHaveBeenCalledWith("interactive");
	});
});
