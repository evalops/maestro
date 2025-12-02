import { describe, expect, it } from "vitest";

import { Box, Column, Row } from "../src/components/layout.js";
import { Text } from "../src/components/text.js";

const renderLines = (
	component: { render: (width: number) => string[] },
	width: number,
) => component.render(width).join("\n");

describe("Row", () => {
	it("splits space with gap and weights", () => {
		const row = new Row(
			[
				new Text("Left", 0, 0),
				new Text("Right", 0, 0),
				new Text("Center", 0, 0),
			],
			{ gap: 2, weights: [1, 1, 2] },
		);
		expect(renderLines(row, 28)).toMatchInlineSnapshot(
			`"Left    Right   Center      "`,
		);
	});
});

describe("Column", () => {
	it("stacks children with gap", () => {
		const col = new Column([new Text("Top", 0, 0), new Text("Bottom", 0, 0)], {
			gap: 1,
		});
		expect(renderLines(col, 10)).toMatchInlineSnapshot(
			`"Top       
          
Bottom    "`,
		);
	});
});

describe("Box", () => {
	it("adds padding, margin, and border", () => {
		const box = new Box(
			[
				new Column(
					[new Text("Header", 0, 0), new Text("Body content that wraps", 0, 0)],
					{ gap: 1 },
				),
			],
			{ paddingX: 1, paddingY: 1, marginX: 1, border: "single" },
		);
		expect(renderLines(box, 34)).toMatchInlineSnapshot(
			`
			" +------------------------------+ 
			 |                             |  
			 | Header                      |  
			 |                             |  
			 | Body content that wraps     |  
			 |                             |  
			 +------------------------------+ "
		`,
		);
	});
});
