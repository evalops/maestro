import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../src/sandbox.js";
import { attachTool, setUploadFunction } from "../src/tools/attach.js";
import { createBashTool } from "../src/tools/bash.js";
import { createEditTool } from "../src/tools/edit.js";
import { createWriteTool } from "../src/tools/write.js";

// Mock executor factory
function createMockExecutor(
	responses: Record<
		string,
		{ code: number; stdout: string; stderr: string }
	> = {},
): Executor {
	return {
		exec: vi.fn().mockImplementation(async (cmd: string) => {
			// Check for matching response
			for (const [pattern, response] of Object.entries(responses)) {
				if (cmd.includes(pattern)) {
					return response;
				}
			}
			// Default success
			return { code: 0, stdout: "", stderr: "" };
		}),
		getWorkspacePath: vi.fn().mockImplementation((p: string) => p),
	} as unknown as Executor;
}

describe("createBashTool", () => {
	it("executes command and returns output", async () => {
		const executor = createMockExecutor({
			"echo hello": { code: 0, stdout: "hello\n", stderr: "" },
		});
		const tool = createBashTool(executor);

		const result = await tool.execute("call1", {
			label: "test",
			command: "echo hello",
		});

		expect(result.content[0]!.text).toBe("hello\n");
	});

	it("combines stdout and stderr", async () => {
		const executor = createMockExecutor({
			test: { code: 0, stdout: "output", stderr: "warning" },
		});
		const tool = createBashTool(executor);

		const result = await tool.execute("call1", {
			label: "test",
			command: "test",
		});

		expect(result.content[0]!.text).toBe("output\nwarning");
	});

	it("returns (no output) for empty results", async () => {
		const executor = createMockExecutor({
			silent: { code: 0, stdout: "", stderr: "" },
		});
		const tool = createBashTool(executor);

		const result = await tool.execute("call1", {
			label: "test",
			command: "silent",
		});

		expect(result.content[0]!.text).toBe("(no output)");
	});

	it("throws on non-zero exit code", async () => {
		const executor = createMockExecutor({
			fail: { code: 1, stdout: "", stderr: "error occurred" },
		});
		const tool = createBashTool(executor);

		await expect(
			tool.execute("call1", { label: "test", command: "fail" }),
		).rejects.toThrow("error occurred");
	});

	it("requests approval for destructive commands", async () => {
		const executor = createMockExecutor();
		const onApprovalNeeded = vi.fn().mockResolvedValue(true);
		const tool = createBashTool(executor, { onApprovalNeeded });

		await tool.execute("call1", {
			label: "test",
			command: "rm -rf /important",
		});

		expect(onApprovalNeeded).toHaveBeenCalled();
		expect(executor.exec).toHaveBeenCalled();
	});

	it("rejects command when approval denied", async () => {
		const executor = createMockExecutor();
		const onApprovalNeeded = vi.fn().mockResolvedValue(false);
		const tool = createBashTool(executor, { onApprovalNeeded });

		const result = await tool.execute("call1", {
			label: "test",
			command: "rm -rf /important",
		});

		expect(result.content[0]!.text).toContain("rejected");
		expect((result.details as { rejected?: boolean })?.rejected).toBe(true);
		expect(executor.exec).not.toHaveBeenCalled();
	});

	it("passes timeout to executor", async () => {
		const executor = createMockExecutor();
		const tool = createBashTool(executor);

		await tool.execute("call1", {
			label: "test",
			command: "sleep 1",
			timeout: 30,
		});

		expect(executor.exec).toHaveBeenCalledWith(
			"sleep 1",
			expect.objectContaining({ timeout: 30 }),
		);
	});
});

describe("createEditTool", () => {
	it("replaces text in file", async () => {
		const executor = createMockExecutor({
			cat: { code: 0, stdout: "hello world", stderr: "" },
			printf: { code: 0, stdout: "", stderr: "" },
		});
		const tool = createEditTool(executor);

		const result = await tool.execute("call1", {
			label: "test",
			path: "/test.txt",
			oldText: "hello",
			newText: "goodbye",
		});

		expect(result.content[0]!.text).toContain("Successfully replaced");
		const details = result.details as { diff?: string } | undefined;
		expect(details?.diff).toBeDefined();
	});

	it("throws when text not found", async () => {
		const executor = createMockExecutor({
			cat: { code: 0, stdout: "hello world", stderr: "" },
		});
		const tool = createEditTool(executor);

		await expect(
			tool.execute("call1", {
				label: "test",
				path: "/test.txt",
				oldText: "notfound",
				newText: "replacement",
			}),
		).rejects.toThrow("Could not find the exact text");
	});

	it("throws when multiple occurrences found", async () => {
		const executor = createMockExecutor({
			cat: { code: 0, stdout: "hello hello hello", stderr: "" },
		});
		const tool = createEditTool(executor);

		await expect(
			tool.execute("call1", {
				label: "test",
				path: "/test.txt",
				oldText: "hello",
				newText: "hi",
			}),
		).rejects.toThrow("Found 3 occurrences");
	});

	it("throws when file not found", async () => {
		const executor = createMockExecutor({
			cat: { code: 1, stdout: "", stderr: "No such file" },
		});
		const tool = createEditTool(executor);

		await expect(
			tool.execute("call1", {
				label: "test",
				path: "/missing.txt",
				oldText: "x",
				newText: "y",
			}),
		).rejects.toThrow("No such file");
	});

	it("throws when replacement produces identical content", async () => {
		const executor = createMockExecutor({
			cat: { code: 0, stdout: "same", stderr: "" },
		});
		const tool = createEditTool(executor);

		await expect(
			tool.execute("call1", {
				label: "test",
				path: "/test.txt",
				oldText: "same",
				newText: "same",
			}),
		).rejects.toThrow("No changes made");
	});
});

describe("createWriteTool", () => {
	it("writes content to file", async () => {
		const executor = createMockExecutor();
		const tool = createWriteTool(executor);

		const result = await tool.execute("call1", {
			label: "test",
			path: "/test.txt",
			content: "Hello, World!",
		});

		expect(result.content[0]!.text).toContain("Successfully wrote 13 bytes");
	});

	it("creates parent directories", async () => {
		const executor = createMockExecutor();
		const tool = createWriteTool(executor);

		await tool.execute("call1", {
			label: "test",
			path: "/deep/nested/path/file.txt",
			content: "content",
		});

		expect(executor.exec).toHaveBeenCalledWith(
			expect.stringContaining("mkdir -p"),
			expect.any(Object),
		);
	});

	it("throws on write failure", async () => {
		const executor = createMockExecutor({
			mkdir: { code: 1, stdout: "", stderr: "Permission denied" },
		});
		const tool = createWriteTool(executor);

		await expect(
			tool.execute("call1", {
				label: "test",
				path: "/protected/file.txt",
				content: "content",
			}),
		).rejects.toThrow("Permission denied");
	});

	it("handles files in current directory", async () => {
		const executor = createMockExecutor();
		const tool = createWriteTool(executor);

		await tool.execute("call1", {
			label: "test",
			path: "file.txt",
			content: "content",
		});

		// Should use "." as directory
		expect(executor.exec).toHaveBeenCalledWith(
			expect.stringContaining("mkdir -p '.'"),
			expect.any(Object),
		);
	});
});

describe("attachTool", () => {
	beforeEach(() => {
		setUploadFunction(null as unknown as () => Promise<void>);
	});

	it("throws when upload function not configured", async () => {
		await expect(
			attachTool.execute("call1", {
				label: "test",
				path: "/file.txt",
			}),
		).rejects.toThrow("Upload function not configured");
	});

	it("uploads file with provided path", async () => {
		const uploadFn = vi.fn().mockResolvedValue(undefined);
		setUploadFunction(uploadFn);

		const result = await attachTool.execute("call1", {
			label: "test",
			path: "/path/to/document.pdf",
		});

		expect(uploadFn).toHaveBeenCalledWith(
			expect.stringContaining("document.pdf"),
			"document.pdf",
		);
		expect(result.content[0]!.text).toContain("document.pdf");
	});

	it("uses custom title when provided", async () => {
		const uploadFn = vi.fn().mockResolvedValue(undefined);
		setUploadFunction(uploadFn);

		await attachTool.execute("call1", {
			label: "test",
			path: "/file.txt",
			title: "Custom Title",
		});

		expect(uploadFn).toHaveBeenCalledWith(expect.any(String), "Custom Title");
	});

	it("throws when operation is aborted", async () => {
		const uploadFn = vi.fn().mockResolvedValue(undefined);
		setUploadFunction(uploadFn);

		const controller = new AbortController();
		controller.abort();

		await expect(
			attachTool.execute(
				"call1",
				{ label: "test", path: "/file.txt" },
				controller.signal,
			),
		).rejects.toThrow("Operation aborted");
	});
});
