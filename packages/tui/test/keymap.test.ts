import { describe, expect, it, vi } from "vitest";

import { AnsiKeys, ControlCodes, Keymap, ctrl } from "../src/keymap.js";

describe("Keymap", () => {
	it("handles simple key bindings", () => {
		const keymap = new Keymap<void>();
		const handler = vi.fn();

		keymap.register({
			keys: ["a"],
			handler,
			description: "Handle letter a",
		});

		expect(keymap.handle("a", undefined)).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);

		expect(keymap.handle("b", undefined)).toBe(false);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("handles control character bindings", () => {
		const keymap = new Keymap<void>();
		const handler = vi.fn();

		keymap.register({
			keys: [ctrl(ControlCodes.CTRL_A)],
			handler,
			description: "Move to start of line",
		});

		expect(keymap.handle(ctrl(ControlCodes.CTRL_A), undefined)).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("handles ANSI escape sequences", () => {
		const keymap = new Keymap<void>();
		const upHandler = vi.fn();
		const downHandler = vi.fn();

		keymap.register({
			keys: [AnsiKeys.UP, AnsiKeys.UP_SS3],
			handler: upHandler,
			description: "Move up",
		});

		keymap.register({
			keys: [AnsiKeys.DOWN],
			handler: downHandler,
			description: "Move down",
		});

		// CSI format
		expect(keymap.handle(AnsiKeys.UP, undefined)).toBe(true);
		expect(upHandler).toHaveBeenCalledTimes(1);

		// SS3 format (application cursor mode)
		expect(keymap.handle(AnsiKeys.UP_SS3, undefined)).toBe(true);
		expect(upHandler).toHaveBeenCalledTimes(2);

		expect(keymap.handle(AnsiKeys.DOWN, undefined)).toBe(true);
		expect(downHandler).toHaveBeenCalledTimes(1);
	});

	it("respects conditional bindings", () => {
		interface Context {
			isEditing: boolean;
		}

		const keymap = new Keymap<Context>();
		const handler = vi.fn();

		keymap.register({
			keys: ["x"],
			handler,
			description: "Delete character",
			when: (ctx) => ctx.isEditing,
		});

		expect(keymap.handle("x", { isEditing: false })).toBe(false);
		expect(handler).not.toHaveBeenCalled();

		expect(keymap.handle("x", { isEditing: true })).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("respects priority ordering", () => {
		const keymap = new Keymap<void>();
		const lowPriorityHandler = vi.fn();
		const highPriorityHandler = vi.fn();

		keymap.register({
			keys: ["a"],
			handler: lowPriorityHandler,
			description: "Low priority",
			priority: 0,
		});

		keymap.register({
			keys: ["a"],
			handler: highPriorityHandler,
			description: "High priority",
			priority: 10,
		});

		keymap.handle("a", undefined);

		// High priority should be called, low priority should not
		expect(highPriorityHandler).toHaveBeenCalledTimes(1);
		expect(lowPriorityHandler).not.toHaveBeenCalled();
	});

	it("supports multiple keys for same binding", () => {
		const keymap = new Keymap<void>();
		const handler = vi.fn();

		keymap.register({
			keys: [AnsiKeys.HOME, AnsiKeys.HOME_ALT1, AnsiKeys.HOME_ALT2],
			handler,
			description: "Go to start",
		});

		keymap.handle(AnsiKeys.HOME, undefined);
		keymap.handle(AnsiKeys.HOME_ALT1, undefined);
		keymap.handle(AnsiKeys.HOME_ALT2, undefined);

		expect(handler).toHaveBeenCalledTimes(3);
	});

	it("passes context to handlers", () => {
		interface Context {
			value: number;
		}

		const keymap = new Keymap<Context>();
		const handler = vi.fn((ctx: Context) => {
			ctx.value += 1;
		});

		keymap.register({
			keys: ["a"],
			handler,
			description: "Increment",
		});

		const context = { value: 0 };
		keymap.handle("a", context);

		expect(context.value).toBe(1);
	});

	it("generates help text", () => {
		const keymap = new Keymap<void>();

		keymap.register({
			keys: [ctrl(ControlCodes.CTRL_A)],
			handler: () => {},
			description: "Move to start of line",
		});

		keymap.register({
			keys: [AnsiKeys.UP],
			handler: () => {},
			description: "Move cursor up",
		});

		const help = keymap.generateHelp();

		expect(help).toHaveLength(2);
		expect(help[0]).toContain("Ctrl+A");
		expect(help[0]).toContain("Move to start of line");
		expect(help[1]).toContain("Up");
		expect(help[1]).toContain("Move cursor up");
	});

	it("finds matching bindings", () => {
		const keymap = new Keymap<void>();

		keymap.register({
			keys: ["a", "A"],
			handler: () => {},
			description: "Letter A",
		});

		keymap.register({
			keys: ["b"],
			handler: () => {},
			description: "Letter B",
		});

		const matches = keymap.findMatching("a", undefined);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("Letter A");
	});

	it("returns active bindings respecting conditions", () => {
		interface Context {
			mode: "normal" | "insert";
		}

		const keymap = new Keymap<Context>();

		keymap.register({
			keys: ["i"],
			handler: () => {},
			description: "Enter insert mode",
			when: (ctx) => ctx.mode === "normal",
		});

		keymap.register({
			keys: ["\x1b"],
			handler: () => {},
			description: "Exit insert mode",
			when: (ctx) => ctx.mode === "insert",
		});

		const normalBindings = keymap.getActiveBindings({ mode: "normal" });
		expect(normalBindings).toHaveLength(1);
		expect(normalBindings[0]?.description).toBe("Enter insert mode");

		const insertBindings = keymap.getActiveBindings({ mode: "insert" });
		expect(insertBindings).toHaveLength(1);
		expect(insertBindings[0]?.description).toBe("Exit insert mode");
	});
});

describe("ctrl helper", () => {
	it("creates control character strings", () => {
		expect(ctrl(1)).toBe("\x01");
		expect(ctrl(26)).toBe("\x1a");
	});
});

describe("ControlCodes", () => {
	it("has correct values", () => {
		expect(ControlCodes.CTRL_A).toBe(1);
		expect(ControlCodes.CTRL_C).toBe(3);
		expect(ControlCodes.CTRL_Z).toBe(26);
		expect(ControlCodes.ESCAPE).toBe(27);
		expect(ControlCodes.BACKSPACE).toBe(127);
	});
});

describe("AnsiKeys", () => {
	it("has correct escape sequences", () => {
		expect(AnsiKeys.UP).toBe("\x1b[A");
		expect(AnsiKeys.DOWN).toBe("\x1b[B");
		expect(AnsiKeys.LEFT).toBe("\x1b[D");
		expect(AnsiKeys.RIGHT).toBe("\x1b[C");
		expect(AnsiKeys.HOME).toBe("\x1b[H");
		expect(AnsiKeys.DELETE).toBe("\x1b[3~");
	});
});
