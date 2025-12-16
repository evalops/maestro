import { describe, expect, it, vi } from "vitest";
import {
	AnsiKeys,
	ControlCodes,
	type KeyBinding,
	Keymap,
	ctrl,
} from "../src/keymap.js";

// Simple mock editor context for testing
interface MockEditorContext {
	value: string;
	cursorPos: number;
	mode: "normal" | "insert";
}

function createMockContext(): MockEditorContext {
	return {
		value: "",
		cursorPos: 0,
		mode: "normal",
	};
}

describe("Keymap", () => {
	describe("basic handling", () => {
		it("should handle a single key binding", () => {
			const handler = vi.fn();
			const keymap = new Keymap<MockEditorContext>();
			keymap.register({
				keys: [ctrl(ControlCodes.CTRL_A)],
				handler,
				description: "Select all",
			});

			const context = createMockContext();
			const result = keymap.handle(ctrl(ControlCodes.CTRL_A), context);

			expect(result).toBe(true);
			expect(handler).toHaveBeenCalledWith(context);
		});

		it("should return false for unbound keys", () => {
			const keymap = new Keymap<MockEditorContext>();
			keymap.register({
				keys: [ctrl(ControlCodes.CTRL_A)],
				handler: () => {},
				description: "Select all",
			});

			const context = createMockContext();
			const result = keymap.handle(ctrl(ControlCodes.CTRL_B), context);

			expect(result).toBe(false);
		});

		it("should handle multiple key aliases", () => {
			const handler = vi.fn();
			const keymap = new Keymap<MockEditorContext>();
			keymap.register({
				keys: [AnsiKeys.HOME, AnsiKeys.HOME_ALT1, AnsiKeys.HOME_ALT2],
				handler,
				description: "Go to start of line",
			});

			const context = createMockContext();

			expect(keymap.handle(AnsiKeys.HOME, context)).toBe(true);
			expect(keymap.handle(AnsiKeys.HOME_ALT1, context)).toBe(true);
			expect(keymap.handle(AnsiKeys.HOME_ALT2, context)).toBe(true);
			expect(handler).toHaveBeenCalledTimes(3);
		});
	});

	describe("conditional bindings", () => {
		it("should skip binding when condition is false", () => {
			const handler = vi.fn();
			const keymap = new Keymap<MockEditorContext>();
			keymap.register({
				keys: [ctrl(ControlCodes.CTRL_A)],
				handler,
				description: "Insert mode only",
				when: (e) => e.mode === "insert",
			});

			const context = createMockContext();
			context.mode = "normal";
			const result = keymap.handle(ctrl(ControlCodes.CTRL_A), context);

			expect(result).toBe(false);
			expect(handler).not.toHaveBeenCalled();
		});

		it("should execute binding when condition is true", () => {
			const handler = vi.fn();
			const keymap = new Keymap<MockEditorContext>();
			keymap.register({
				keys: [ctrl(ControlCodes.CTRL_A)],
				handler,
				description: "Insert mode only",
				when: (e) => e.mode === "insert",
			});

			const context = createMockContext();
			context.mode = "insert";
			const result = keymap.handle(ctrl(ControlCodes.CTRL_A), context);

			expect(result).toBe(true);
			expect(handler).toHaveBeenCalled();
		});
	});

	describe("priority handling", () => {
		it("should try higher priority bindings first", () => {
			const lowHandler = vi.fn();
			const highHandler = vi.fn();

			const keymap = new Keymap<MockEditorContext>();
			keymap.registerAll([
				{
					keys: [ctrl(ControlCodes.CTRL_A)],
					handler: lowHandler,
					description: "Low priority",
					priority: 0,
				},
				{
					keys: [ctrl(ControlCodes.CTRL_A)],
					handler: highHandler,
					description: "High priority",
					priority: 10,
				},
			]);

			const context = createMockContext();
			keymap.handle(ctrl(ControlCodes.CTRL_A), context);

			expect(highHandler).toHaveBeenCalled();
			expect(lowHandler).not.toHaveBeenCalled();
		});
	});

	describe("getBindings", () => {
		it("should return all registered bindings sorted by priority", () => {
			const keymap = new Keymap<MockEditorContext>();
			keymap.registerAll([
				{
					keys: [ctrl(ControlCodes.CTRL_A)],
					handler: () => {},
					description: "Low priority",
					priority: 0,
				},
				{
					keys: [ctrl(ControlCodes.CTRL_B)],
					handler: () => {},
					description: "High priority",
					priority: 10,
				},
			]);

			const bindings = keymap.getBindings();

			expect(bindings).toHaveLength(2);
			expect(bindings[0].description).toBe("High priority");
			expect(bindings[1].description).toBe("Low priority");
		});
	});

	describe("findMatching", () => {
		it("should find bindings matching a key", () => {
			const keymap = new Keymap<MockEditorContext>();
			keymap.registerAll([
				{
					keys: [ctrl(ControlCodes.CTRL_A)],
					handler: () => {},
					description: "Select all",
				},
				{
					keys: [ctrl(ControlCodes.CTRL_B)],
					handler: () => {},
					description: "Bold",
				},
			]);

			const context = createMockContext();
			const matches = keymap.findMatching(ctrl(ControlCodes.CTRL_A), context);

			expect(matches).toHaveLength(1);
			expect(matches[0].description).toBe("Select all");
		});
	});

	describe("getActiveBindings", () => {
		it("should filter bindings by condition", () => {
			const keymap = new Keymap<MockEditorContext>();
			keymap.registerAll([
				{
					keys: [ctrl(ControlCodes.CTRL_A)],
					handler: () => {},
					description: "Always active",
				},
				{
					keys: [ctrl(ControlCodes.CTRL_B)],
					handler: () => {},
					description: "Insert only",
					when: (e) => e.mode === "insert",
				},
			]);

			const normalContext = createMockContext();
			normalContext.mode = "normal";
			const activeInNormal = keymap.getActiveBindings(normalContext);
			expect(activeInNormal).toHaveLength(1);
			expect(activeInNormal[0].description).toBe("Always active");

			const insertContext = createMockContext();
			insertContext.mode = "insert";
			const activeInInsert = keymap.getActiveBindings(insertContext);
			expect(activeInInsert).toHaveLength(2);
		});
	});

	describe("generateHelp", () => {
		it("should generate help text for bindings", () => {
			const keymap = new Keymap<MockEditorContext>();
			keymap.register({
				keys: [ctrl(ControlCodes.CTRL_A)],
				handler: () => {},
				description: "Select all",
			});

			const help = keymap.generateHelp();
			expect(help).toHaveLength(1);
			expect(help[0]).toContain("Select all");
			expect(help[0]).toContain("Ctrl+A");
		});
	});
});

describe("ControlCodes", () => {
	it("should have correct control character codes", () => {
		expect(ControlCodes.CTRL_A).toBe(1);
		expect(ControlCodes.CTRL_Z).toBe(26);
		expect(ControlCodes.CTRL_C).toBe(3);
		expect(ControlCodes.ESCAPE).toBe(27);
		expect(ControlCodes.BACKSPACE).toBe(127);
	});
});

describe("AnsiKeys", () => {
	it("should have correct arrow key sequences", () => {
		expect(AnsiKeys.UP).toBe("\x1b[A");
		expect(AnsiKeys.DOWN).toBe("\x1b[B");
		expect(AnsiKeys.LEFT).toBe("\x1b[D");
		expect(AnsiKeys.RIGHT).toBe("\x1b[C");
	});

	it("should have correct home/end key sequences", () => {
		expect(AnsiKeys.HOME).toBe("\x1b[H");
		expect(AnsiKeys.END).toBe("\x1b[F");
	});

	it("should have correct alt key sequences", () => {
		expect(AnsiKeys.ALT_B).toBe("\x1bb");
		expect(AnsiKeys.ALT_F).toBe("\x1bf");
	});
});

describe("ctrl helper", () => {
	it("should convert control codes to characters", () => {
		expect(ctrl(ControlCodes.CTRL_A)).toBe("\x01");
		expect(ctrl(ControlCodes.CTRL_C)).toBe("\x03");
		expect(ctrl(ControlCodes.CTRL_Z)).toBe("\x1a");
	});
});
