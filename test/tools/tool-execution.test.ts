import { describe, expect, it } from "vitest";
import { ToolExecutionComponent } from "../../src/cli-tui/tool-execution.js";

/**
 * Helper to get rendered text from component
 * Component.render() returns string[], join to get full text
 */
function getRenderedText(component: ToolExecutionComponent): string {
	const lines = component.render(120); // Use reasonable width
	return lines.join("\n");
}

describe("ToolExecutionComponent - Output Truncation", () => {
	describe("Bash Tool Truncation", () => {
		it("should truncate bash output to 5 lines with indicator", () => {
			const component = new ToolExecutionComponent("bash", {
				command: "ls -la",
			});

			// Simulate bash result with many lines
			const longOutput = Array.from(
				{ length: 20 },
				(_, i) => `line ${i + 1}`,
			).join("\n");

			component.updateResult({
				content: [{ type: "text", text: longOutput }],
				isError: false,
			});

			const rendered = getRenderedText(component);
			const lines = rendered.split("\n");

			// Should contain truncation indicator
			const hasIndicator = rendered.includes("... (15 more lines)");
			expect(hasIndicator).toBe(true);

			// Should only show first 5 lines of output (plus command line, etc)
			const outputLines = lines.filter((line) => line.includes("line "));
			expect(outputLines.length).toBeLessThanOrEqual(5);
		});

		it("should NOT truncate bash output with 5 or fewer lines", () => {
			const component = new ToolExecutionComponent("bash", {
				command: "pwd",
			});

			const shortOutput = "line 1\nline 2\nline 3";

			component.updateResult({
				content: [{ type: "text", text: shortOutput }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should NOT have truncation indicator
			expect(rendered.includes("more lines")).toBe(false);

			// Should show all lines
			expect(rendered.includes("line 1")).toBe(true);
			expect(rendered.includes("line 2")).toBe(true);
			expect(rendered.includes("line 3")).toBe(true);
		});

		it("should handle empty bash output", () => {
			const component = new ToolExecutionComponent("bash", {
				command: "true",
			});

			component.updateResult({
				content: [{ type: "text", text: "" }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should not crash and should show command
			expect(rendered).toContain("bash");
			expect(rendered).toContain("true");
		});
	});

	describe("Read Tool Truncation", () => {
		it("should truncate read output to 10 lines with indicator", () => {
			const component = new ToolExecutionComponent("read", {
				file_path: "/test/file.txt",
			});

			// Simulate file with 50 lines
			const longContent = Array.from(
				{ length: 50 },
				(_, i) => `content line ${i + 1}`,
			).join("\n");

			component.updateResult({
				content: [{ type: "text", text: longContent }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should contain truncation indicator
			expect(rendered).toContain("... (40 more lines)");

			// Should only show first 10 lines
			const outputLines = rendered
				.split("\n")
				.filter((line) => line.includes("content line"));
			expect(outputLines.length).toBeLessThanOrEqual(10);
		});

		it("should NOT truncate read output with 10 or fewer lines", () => {
			const component = new ToolExecutionComponent("read", {
				file_path: "/test/small.txt",
			});

			const shortContent = "line 1\nline 2\nline 3\nline 4\nline 5";

			component.updateResult({
				content: [{ type: "text", text: shortContent }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should NOT have truncation indicator
			expect(rendered.includes("more lines")).toBe(false);

			// Should show all lines
			for (let i = 1; i <= 5; i++) {
				expect(rendered.includes(`line ${i}`)).toBe(true);
			}
		});

		it("should replace tabs with spaces in read output", () => {
			const component = new ToolExecutionComponent("read", {
				file_path: "/test/tabs.txt",
			});

			const contentWithTabs = "line1\there\nline2\tthere";

			component.updateResult({
				content: [{ type: "text", text: contentWithTabs }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Tabs should be replaced with spaces
			expect(rendered.includes("\t")).toBe(false);
		});
	});

	describe("Write Tool Truncation", () => {
		it("should truncate write content to 10 lines with indicator", () => {
			const longContent = Array.from(
				{ length: 30 },
				(_, i) => `written line ${i + 1}`,
			).join("\n");

			const component = new ToolExecutionComponent("write", {
				file_path: "/test/output.txt",
				content: longContent,
			});

			// Set a result to trigger rendering of the content
			component.updateResult({
				content: [{ type: "text", text: "File written" }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should contain truncation indicator
			expect(rendered).toContain("... (20 more lines)");

			// Should show total line count in header
			expect(rendered).toContain("(30 lines)");
		});

		it("should NOT truncate write content with 10 or fewer lines", () => {
			const shortContent = "line 1\nline 2\nline 3";

			const component = new ToolExecutionComponent("write", {
				file_path: "/test/short.txt",
				content: shortContent,
			});

			const rendered = getRenderedText(component);

			// Should NOT have truncation indicator
			expect(rendered.includes("more lines")).toBe(false);

			// Should NOT show line count for short files
			expect(rendered.includes("(3 lines)")).toBe(false);
		});

		it("should replace tabs in write content", () => {
			const contentWithTabs = "function test() {\n\tconsole.log('hello');\n}";

			const component = new ToolExecutionComponent("write", {
				file_path: "/test/code.js",
				content: contentWithTabs,
			});

			const rendered = getRenderedText(component);

			// Tabs should be replaced with spaces
			expect(rendered.includes("\t")).toBe(false);
		});
	});

	describe("Edit Tool (No Truncation)", () => {
		it("should show full diff without truncation", () => {
			const component = new ToolExecutionComponent("edit", {
				file_path: "/test/file.txt",
				old_str: "old content",
				new_str: "new content",
			});

			// Simulate diff result
			component.updateResult({
				content: [{ type: "text", text: "Edit successful" }],
				isError: false,
				details: {
					diff: "+new content\n-old content",
				},
			});

			const rendered = getRenderedText(component);

			// Should show the diff
			expect(rendered).toContain("new content");
			expect(rendered).toContain("old content");

			// Should NOT have truncation indicator
			expect(rendered.includes("more lines")).toBe(false);
		});

		it("should handle edit without diff details", () => {
			const component = new ToolExecutionComponent("edit", {
				file_path: "/test/file.txt",
			});

			component.updateResult({
				content: [{ type: "text", text: "Edit successful" }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should not crash
			expect(rendered).toContain("edit");
			expect(rendered).toContain("file.txt");
		});
	});

	describe("Generic Tool (No Truncation)", () => {
		it("should show full output for generic tools", () => {
			const component = new ToolExecutionComponent("custom_tool", {
				param1: "value1",
				param2: "value2",
			});

			const longOutput = Array.from(
				{ length: 100 },
				(_, i) => `data ${i}`,
			).join("\n");

			component.updateResult({
				content: [{ type: "text", text: longOutput }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Generic tools should show all output (no truncation)
			expect(rendered.includes("more lines")).toBe(false);
			expect(rendered).toContain("data 99"); // Last line should be visible
		});
	});

	describe("Image Handling", () => {
		it("handles pure image output without crashing", () => {
			const component = new ToolExecutionComponent("read", {
				file_path: "/test/image.png",
			});

			component.updateResult({
				content: [
					{ type: "image", mimeType: "image/png", data: "base64data..." },
				],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should show image indicator
			// Should still include the path header even without inline image content
			expect(rendered).toContain("/test/image.png");
		});

		it("should handle mixed text and image content", () => {
			const component = new ToolExecutionComponent("bash", {
				command: "identify image.png",
			});

			component.updateResult({
				content: [
					{ type: "text", text: "Image info: 800x600" },
					{ type: "image", mimeType: "image/jpeg", data: "base64..." },
				],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should show both
			expect(rendered).toContain("Image info");
			expect(rendered).toContain("[Image: image/jpeg]");
		});
	});

	describe("Error State", () => {
		it("should indicate error state visually", () => {
			const component = new ToolExecutionComponent("bash", {
				command: "false",
			});

			component.updateResult({
				content: [{ type: "text", text: "Command failed" }],
				isError: true,
			});

			const rendered = getRenderedText(component);

			// Should show error content
			expect(rendered).toContain("Command failed");
		});
	});

	describe("Args Streaming", () => {
		it("should show partial args before result", () => {
			const component = new ToolExecutionComponent("bash", {
				command: "echo 'building...'",
			});

			// Set pending status to trigger args display (simulates approval flow)
			component.setPendingStatus("Awaiting approval");

			const rendered = getRenderedText(component);

			// Should show command even without result
			expect(rendered).toContain("bash");
			expect(rendered).toContain("building");
		});

		it("should update args incrementally", () => {
			const component = new ToolExecutionComponent("bash", {
				command: "echo",
			});

			// Set pending status to trigger args display
			component.setPendingStatus("Awaiting approval");

			let rendered = getRenderedText(component);
			expect(rendered).toContain("echo");

			// Update with more args
			component.updateArgs({ command: "echo 'hello world'" });

			rendered = getRenderedText(component);
			expect(rendered).toContain("hello world");
		});
	});

	describe("Path Shortening", () => {
		it("should shorten home directory paths", () => {
			const homeDir = process.env.HOME || "/home/user";
			const filePath = `${homeDir}/projects/test.txt`;

			const component = new ToolExecutionComponent("read", {
				file_path: filePath,
			});

			// Set a result to trigger content rendering
			component.updateResult({
				content: [{ type: "text", text: "file contents" }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should show tilde notation
			expect(rendered).toContain("~/");
			expect(rendered).not.toContain(homeDir);
		});

		it("should not shorten non-home paths", () => {
			const component = new ToolExecutionComponent("read", {
				file_path: "/usr/local/bin/tool",
			});

			// Set a result to trigger content rendering
			component.updateResult({
				content: [{ type: "text", text: "file contents" }],
				isError: false,
			});

			const rendered = getRenderedText(component);

			// Should show full path
			expect(rendered).toContain("/usr/local/bin/tool");
		});
	});
});
