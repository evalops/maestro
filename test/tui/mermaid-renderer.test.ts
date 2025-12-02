import { describe, expect, it } from "vitest";

import { renderMermaidDiagram } from "../../src/tui/mermaid-renderer.js";

describe("renderMermaidDiagram", () => {
	it("renders a simple top-down graph with boxes", () => {
		const source = `graph TD
A[Start] --> B{Decision}
B --> C[Do thing]
B --> D[Fallback]
`;
		const lines = renderMermaidDiagram(source, 80);
		expect(lines).toBeTruthy();
		expect(lines?.some((line) => line.includes("Start"))).toBe(true);
		expect(lines?.some((line) => /┌.*┐/.test(line))).toBe(true);
	});

	it("returns null for empty content", () => {
		const lines = renderMermaidDiagram("", 60);
		expect(lines).toBeNull();
	});

	it("still renders nodes when cycles prevent some edges", () => {
		const source = `graph TD
A --> B
B --> C
C --> A
`;
		const lines = renderMermaidDiagram(source, 80);
		expect(lines).toBeTruthy();
		expect(lines?.some((line) => line.includes("Skipped edge"))).toBe(true);
	});
});
