import { describe, expect, it } from "vitest";
import { ScrollContainer } from "../src/components/scroll-container.js";
import type { Component } from "../src/tui.js";

class StaticComponent implements Component {
	constructor(private lines: string[] = []) {}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
}

describe("ScrollContainer history", () => {
	it("updates the last line without duplicating history", () => {
		const content = new StaticComponent(["hello"]);
		const scroll = new ScrollContainer(content, { viewportHeight: 10 });

		expect(scroll.render(20)).toEqual(["hello"]);

		content.setLines(["hello world"]);
		expect(scroll.render(20)).toEqual(["hello world"]);
	});

	it("appends only new lines when content grows", () => {
		const content = new StaticComponent(["a"]);
		const scroll = new ScrollContainer(content, { viewportHeight: 10 });

		expect(scroll.render(20)).toEqual(["a"]);

		content.setLines(["a", "b"]);
		expect(scroll.render(20)).toEqual(["a", "b"]);
	});

	it("keeps history when the child trims output", () => {
		const content = new StaticComponent(["a", "b", "c", "d"]);
		const scroll = new ScrollContainer(content, { viewportHeight: 10 });

		expect(scroll.render(20)).toEqual(["a", "b", "c", "d"]);

		content.setLines(["c", "d"]);
		expect(scroll.render(20)).toEqual(["a", "b", "c", "d"]);
	});

	it("keeps history when the child truncates the tail", () => {
		const content = new StaticComponent(["a", "b", "c"]);
		const scroll = new ScrollContainer(content, { viewportHeight: 10 });

		expect(scroll.render(20)).toEqual(["a", "b", "c"]);

		content.setLines(["a", "b"]);
		expect(scroll.render(20)).toEqual(["a", "b", "c"]);
	});

	it("keeps history when the child clears output", () => {
		const content = new StaticComponent(["first", "second"]);
		const scroll = new ScrollContainer(content, { viewportHeight: 10 });

		expect(scroll.render(20)).toEqual(["first", "second"]);

		content.setLines([]);
		expect(scroll.render(20)).toEqual(["first", "second"]);
	});

	it("keeps the newest lines when history is trimmed", () => {
		const content = new StaticComponent(["one", "two", "three"]);
		const scroll = new ScrollContainer(content, {
			viewportHeight: 10,
			maxHistoryLines: 2,
		});

		expect(scroll.render(20)).toEqual(["two", "three"]);

		content.setLines(["one", "two", "three", "four"]);
		expect(scroll.render(20)).toEqual(["three", "four"]);
	});
});
