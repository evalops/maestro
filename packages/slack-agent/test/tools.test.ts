import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecutor } from "../src/sandbox.js";
import {
	attachTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createScheduleTool,
	createSlackAgentTools,
	createStatusTool,
	createWriteTool,
	setUploadFunction,
} from "../src/tools/index.js";

describe("createSlackAgentTools", () => {
	it("creates all default tools", () => {
		const executor = createExecutor({ type: "host" });
		const tools = createSlackAgentTools(executor);

		expect(tools.map((t) => t.name)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"status",
			"attach",
			"deploy",
			"build_dashboard",
			"workflow",
		]);
	});

	it("includes schedule tool when options provided", () => {
		const executor = createExecutor({ type: "host" });
		const tools = createSlackAgentTools(executor, {
			scheduleOptions: {
				onSchedule: async () => ({ success: true }),
				onListTasks: async () => [],
				onCancelTask: async () => ({ success: true }),
			},
		});

		expect(tools.map((t) => t.name)).toContain("schedule");
		expect(tools).toHaveLength(10);
	});
});

describe("bashTool", () => {
	let executor: ReturnType<typeof createExecutor>;

	beforeEach(() => {
		executor = createExecutor({ type: "host" });
	});

	it("executes simple commands", async () => {
		const tool = createBashTool(executor);
		const result = await tool.execute("call-1", {
			label: "echo test",
			command: "echo hello",
		});

		expect(result.content[0]!.text).toBe("hello\n");
	});

	it("combines stdout and stderr", async () => {
		const tool = createBashTool(executor);
		const result = await tool.execute("call-1", {
			label: "mixed output",
			command: "echo stdout && echo stderr >&2",
		});

		expect(result.content[0]!.text).toContain("stdout");
		expect(result.content[0]!.text).toContain("stderr");
	});

	it("throws on non-zero exit code", async () => {
		const tool = createBashTool(executor);

		await expect(
			tool.execute("call-1", {
				label: "failing command",
				command: "exit 1",
			}),
		).rejects.toThrow("exited with code 1");
	});

	it("returns (no output) for empty output", async () => {
		const tool = createBashTool(executor);
		const result = await tool.execute("call-1", {
			label: "silent command",
			command: "true",
		});

		expect(result.content[0]!.text).toBe("(no output)");
	});

	describe("approval workflow", () => {
		it("requests approval for destructive commands", async () => {
			let approvalRequested = false;
			const tool = createBashTool(executor, {
				onApprovalNeeded: async (command, description) => {
					approvalRequested = true;
					expect(command).toContain("rm -rf");
					expect(description).toBeTruthy();
					return false; // Reject
				},
			});

			const result = await tool.execute("call-1", {
				label: "dangerous command",
				command: "rm -rf /tmp/test",
			});

			expect(approvalRequested).toBe(true);
			expect(result.content[0]!.text).toContain("rejected");
			expect(result.details).toHaveProperty("rejected", true);
		});

		it("executes approved destructive commands", async () => {
			const tool = createBashTool(executor, {
				onApprovalNeeded: async () => true, // Approve
			});

			const result = await tool.execute("call-1", {
				label: "mkdir test",
				command: "echo approved",
			});

			expect(result.content[0]!.text).toBe("approved\n");
		});

		it("executes non-destructive commands without approval", async () => {
			let approvalRequested = false;
			const tool = createBashTool(executor, {
				onApprovalNeeded: async () => {
					approvalRequested = true;
					return true;
				},
			});

			await tool.execute("call-1", {
				label: "safe command",
				command: "echo safe",
			});

			expect(approvalRequested).toBe(false);
		});
	});
});

describe("readTool", () => {
	let executor: ReturnType<typeof createExecutor>;
	let testDir: string;

	beforeEach(async () => {
		executor = createExecutor({ type: "host" });
		testDir = join(tmpdir(), `slack-agent-read-test-${Date.now()}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("reads text files", async () => {
		const filePath = join(testDir, "test.txt");
		await writeFile(filePath, "Hello World\nLine 2\n");

		const tool = createReadTool(executor);
		const result = await tool.execute("call-1", {
			label: "reading test file",
			path: filePath,
		});

		expect(result.content[0]!.text).toContain("Hello World");
		expect(result.content[0]!.text).toContain("Line 2");
	});

	it("reads with offset and limit", async () => {
		const filePath = join(testDir, "lines.txt");
		await writeFile(filePath, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n");

		const tool = createReadTool(executor);
		const result = await tool.execute("call-1", {
			label: "reading with offset",
			path: filePath,
			offset: 2,
			limit: 2,
		});

		expect(result.content[0]!.text).toContain("Line 2");
		expect(result.content[0]!.text).toContain("Line 3");
		expect(result.content[0]!.text).not.toContain("Line 1");
	});

	it("shows remaining lines notice", async () => {
		const filePath = join(testDir, "many-lines.txt");
		const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join(
			"\n",
		);
		await writeFile(filePath, lines);

		const tool = createReadTool(executor);
		const result = await tool.execute("call-1", {
			label: "reading partial",
			path: filePath,
			limit: 10,
		});

		expect(result.content[0]!.text).toContain("more lines not shown");
		// The offset varies based on trailing newlines from head command
		expect(result.content[0]!.text).toMatch(/offset=\d+/);
	});

	it("throws for non-existent files", async () => {
		const tool = createReadTool(executor);

		await expect(
			tool.execute("call-1", {
				label: "reading missing",
				path: join(testDir, "nonexistent.txt"),
			}),
		).rejects.toThrow();
	});

	it("reads image files as base64", async () => {
		// Create a minimal PNG (1x1 transparent pixel)
		const pngData = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
			0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
			0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
			0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00,
			0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00,
			0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);
		const imagePath = join(testDir, "test.png");
		await writeFile(imagePath, pngData);

		const tool = createReadTool(executor);
		const result = await tool.execute("call-1", {
			label: "reading image",
			path: imagePath,
		});

		expect(result.content[0]!.text).toContain("image/png");
		expect(result.content[1]!.type).toBe("image");
		expect(result.content[1]!.mimeType).toBe("image/png");
		expect(result.content[1]!.data).toBeTruthy();
	});
});

describe("writeTool", () => {
	let executor: ReturnType<typeof createExecutor>;
	let testDir: string;

	beforeEach(async () => {
		executor = createExecutor({ type: "host" });
		testDir = join(tmpdir(), `slack-agent-write-test-${Date.now()}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("writes new files", async () => {
		const filePath = join(testDir, "new.txt");

		const tool = createWriteTool(executor);
		const result = await tool.execute("call-1", {
			label: "writing file",
			path: filePath,
			content: "Hello World",
		});

		expect(result.content[0]!.text).toContain("Successfully wrote");
		expect(result.content[0]!.text).toContain("11 bytes");

		const content = await readFile(filePath, "utf-8");
		expect(content).toBe("Hello World");
	});

	it("creates parent directories", async () => {
		const filePath = join(testDir, "nested", "deep", "file.txt");

		const tool = createWriteTool(executor);
		await tool.execute("call-1", {
			label: "writing nested",
			path: filePath,
			content: "Nested content",
		});

		const content = await readFile(filePath, "utf-8");
		expect(content).toBe("Nested content");
	});

	it("overwrites existing files", async () => {
		const filePath = join(testDir, "existing.txt");
		await writeFile(filePath, "Old content");

		const tool = createWriteTool(executor);
		await tool.execute("call-1", {
			label: "overwriting",
			path: filePath,
			content: "New content",
		});

		const content = await readFile(filePath, "utf-8");
		expect(content).toBe("New content");
	});

	it("handles special characters in content", async () => {
		const filePath = join(testDir, "special.txt");
		const specialContent = "Line with 'quotes' and $variables and `backticks`";

		const tool = createWriteTool(executor);
		await tool.execute("call-1", {
			label: "writing special",
			path: filePath,
			content: specialContent,
		});

		const content = await readFile(filePath, "utf-8");
		expect(content).toBe(specialContent);
	});
});

describe("editTool", () => {
	let executor: ReturnType<typeof createExecutor>;
	let testDir: string;

	beforeEach(async () => {
		executor = createExecutor({ type: "host" });
		testDir = join(tmpdir(), `slack-agent-edit-test-${Date.now()}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("replaces text in files", async () => {
		const filePath = join(testDir, "edit.txt");
		await writeFile(filePath, "Hello World");

		const tool = createEditTool(executor);
		const result = await tool.execute("call-1", {
			label: "editing file",
			path: filePath,
			oldText: "World",
			newText: "Universe",
		});

		expect(result.content[0]!.text).toContain("Successfully replaced");

		const content = await readFile(filePath, "utf-8");
		expect(content).toBe("Hello Universe");
	});

	it("throws when text not found", async () => {
		const filePath = join(testDir, "edit.txt");
		await writeFile(filePath, "Hello World");

		const tool = createEditTool(executor);

		await expect(
			tool.execute("call-1", {
				label: "editing missing",
				path: filePath,
				oldText: "NotFound",
				newText: "Replacement",
			}),
		).rejects.toThrow("Could not find the exact text");
	});

	it("throws when multiple occurrences", async () => {
		const filePath = join(testDir, "edit.txt");
		await writeFile(filePath, "Hello Hello Hello");

		const tool = createEditTool(executor);

		await expect(
			tool.execute("call-1", {
				label: "editing ambiguous",
				path: filePath,
				oldText: "Hello",
				newText: "Hi",
			}),
		).rejects.toThrow("Found 3 occurrences");
	});

	it("throws when replacement produces no change", async () => {
		const filePath = join(testDir, "edit.txt");
		await writeFile(filePath, "Hello World");

		const tool = createEditTool(executor);

		await expect(
			tool.execute("call-1", {
				label: "no change",
				path: filePath,
				oldText: "Hello",
				newText: "Hello",
			}),
		).rejects.toThrow("No changes made");
	});

	it("returns diff in details", async () => {
		const filePath = join(testDir, "diff.txt");
		await writeFile(filePath, "Line 1\nLine 2\nLine 3");

		const tool = createEditTool(executor);
		const result = await tool.execute("call-1", {
			label: "with diff",
			path: filePath,
			oldText: "Line 2",
			newText: "Modified Line 2",
		});

		expect(result.details).toHaveProperty("diff");
		const details = result.details as { diff?: string } | undefined;
		const diff = details?.diff as string;
		expect(diff).toContain("-");
		expect(diff).toContain("+");
	});
});

describe("attachTool", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `slack-agent-attach-test-${Date.now()}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		setUploadFunction(null as unknown as () => Promise<void>);
	});

	it("throws when upload function not configured", async () => {
		setUploadFunction(null as unknown as () => Promise<void>);

		await expect(
			attachTool.execute("call-1", {
				label: "attaching",
				path: "/tmp/test.txt",
			}),
		).rejects.toThrow("Upload function not configured");
	});

	it("calls upload function with resolved path", async () => {
		const filePath = join(testDir, "upload.txt");
		await writeFile(filePath, "Content to upload");

		let uploadedPath: string | null = null;
		let uploadedTitle: string | undefined;

		setUploadFunction(async (path, title) => {
			uploadedPath = path;
			uploadedTitle = title;
		});

		const result = await attachTool.execute("call-1", {
			label: "uploading",
			path: filePath,
		});

		expect(uploadedPath).toBe(filePath);
		expect(uploadedTitle).toBe("upload.txt");
		expect(result.content[0]!.text).toContain("Attached file: upload.txt");
	});

	it("uses custom title when provided", async () => {
		const filePath = join(testDir, "upload.txt");
		await writeFile(filePath, "Content");

		let uploadedTitle: string | undefined;
		setUploadFunction(async (_path, title) => {
			uploadedTitle = title;
		});

		await attachTool.execute("call-1", {
			label: "uploading with title",
			path: filePath,
			title: "Custom Title.txt",
		});

		expect(uploadedTitle).toBe("Custom Title.txt");
	});

	it("respects abort signal", async () => {
		setUploadFunction(async () => {});

		const controller = new AbortController();
		controller.abort();

		await expect(
			attachTool.execute(
				"call-1",
				{ label: "aborting", path: "/tmp/test.txt" },
				controller.signal,
			),
		).rejects.toThrow("aborted");
	});
});

describe("statusTool", () => {
	let executor: ReturnType<typeof createExecutor>;

	beforeEach(() => {
		executor = createExecutor({ type: "host" });
	});

	it("reports host environment", async () => {
		const tool = createStatusTool(executor);
		const result = await tool.execute("call-1", { label: "checking status" });

		expect(result.content[0]!.text).toContain("Environment: host");
		expect(result.content[0]!.text).toContain("Workspace:");
	});

	it("includes workspace info", async () => {
		const tool = createStatusTool(executor);
		const result = await tool.execute("call-1", { label: "checking status" });

		expect(result.content[0]!.text).toContain("Disk Usage:");
		expect(result.content[0]!.text).toContain("Files:");
	});

	it("returns structured details", async () => {
		const tool = createStatusTool(executor);
		const result = await tool.execute("call-1", { label: "checking status" });

		expect(result.details).toHaveProperty("environment", "host");
		expect(result.details).toHaveProperty("workspace");
		expect(
			(result.details as { workspace: { path: string } }).workspace,
		).toHaveProperty("path");
	});
});

describe("scheduleTool", () => {
	it("schedules tasks successfully", async () => {
		const tool = createScheduleTool({
			onSchedule: async (description, prompt, when) => ({
				success: true,
				taskId: "task-123",
				nextRun: "2025-01-01T09:00:00Z",
			}),
			onListTasks: async () => [],
			onCancelTask: async () => ({ success: true }),
		});

		const result = await tool.execute("call-1", {
			label: "scheduling",
			action: "schedule",
			description: "Test task",
			prompt: "Do something",
			when: "tomorrow at 9am",
		});

		expect(result.content[0]!.text).toContain("scheduled successfully");
		expect(result.content[0]!.text).toContain("task-123");
		expect(result.content[0]!.text).toContain("2025-01-01T09:00:00Z");
	});

	it("shows warning when present", async () => {
		const tool = createScheduleTool({
			onSchedule: async () => ({
				success: true,
				taskId: "task-123",
				nextRun: "2025-01-01T09:00:00Z",
				warning: "Using UTC timezone",
			}),
			onListTasks: async () => [],
			onCancelTask: async () => ({ success: true }),
		});

		const result = await tool.execute("call-1", {
			label: "scheduling",
			action: "schedule",
			description: "Test",
			prompt: "Do",
			when: "9am",
		});

		expect(result.content[0]!.text).toContain("Warning: Using UTC timezone");
	});

	it("handles schedule errors", async () => {
		const tool = createScheduleTool({
			onSchedule: async () => ({
				success: false,
				error: "Invalid time format",
			}),
			onListTasks: async () => [],
			onCancelTask: async () => ({ success: true }),
		});

		const result = await tool.execute("call-1", {
			label: "scheduling",
			action: "schedule",
			description: "Test",
			prompt: "Do",
			when: "invalid",
		});

		expect(result.content[0]!.text).toContain("Failed to schedule");
		expect(result.content[0]!.text).toContain("Invalid time format");
	});

	it("requires parameters for schedule action", async () => {
		const tool = createScheduleTool({
			onSchedule: async () => ({ success: true }),
			onListTasks: async () => [],
			onCancelTask: async () => ({ success: true }),
		});

		const result = await tool.execute("call-1", {
			label: "scheduling",
			action: "schedule",
		});

		expect(result.content[0]!.text).toContain("requires description");
	});

	it("lists tasks", async () => {
		const tool = createScheduleTool({
			onSchedule: async () => ({ success: true }),
			onListTasks: async () => [
				{
					id: "task-1",
					description: "Daily standup",
					nextRun: "2025-01-01T09:00:00Z",
					recurring: true,
				},
				{
					id: "task-2",
					description: "One-time reminder",
					nextRun: "2025-01-02T15:00:00Z",
					recurring: false,
				},
			],
			onCancelTask: async () => ({ success: true }),
		});

		const result = await tool.execute("call-1", {
			label: "listing tasks",
			action: "list",
		});

		expect(result.content[0]!.text).toContain("Daily standup");
		expect(result.content[0]!.text).toContain("(recurring)");
		expect(result.content[0]!.text).toContain("One-time reminder");
		expect(result.content[0]!.text).not.toContain(
			"One-time reminder (recurring)",
		);
	});

	it("shows message when no tasks", async () => {
		const tool = createScheduleTool({
			onSchedule: async () => ({ success: true }),
			onListTasks: async () => [],
			onCancelTask: async () => ({ success: true }),
		});

		const result = await tool.execute("call-1", {
			label: "listing tasks",
			action: "list",
		});

		expect(result.content[0]!.text).toContain("No scheduled tasks");
	});

	it("cancels tasks", async () => {
		let cancelledId: string | null = null;
		const tool = createScheduleTool({
			onSchedule: async () => ({ success: true }),
			onListTasks: async () => [],
			onCancelTask: async (taskId) => {
				cancelledId = taskId;
				return { success: true };
			},
		});

		const result = await tool.execute("call-1", {
			label: "cancelling",
			action: "cancel",
			taskId: "task-123",
		});

		expect(cancelledId).toBe("task-123");
		expect(result.content[0]!.text).toContain("cancelled successfully");
	});

	it("requires taskId for cancel action", async () => {
		const tool = createScheduleTool({
			onSchedule: async () => ({ success: true }),
			onListTasks: async () => [],
			onCancelTask: async () => ({ success: true }),
		});

		const result = await tool.execute("call-1", {
			label: "cancelling",
			action: "cancel",
		});

		expect(result.content[0]!.text).toContain("requires taskId");
	});

	it("handles cancel errors", async () => {
		const tool = createScheduleTool({
			onSchedule: async () => ({ success: true }),
			onListTasks: async () => [],
			onCancelTask: async () => ({
				success: false,
				error: "Task not found",
			}),
		});

		const result = await tool.execute("call-1", {
			label: "cancelling",
			action: "cancel",
			taskId: "nonexistent",
		});

		expect(result.content[0]!.text).toContain("Failed to cancel");
		expect(result.content[0]!.text).toContain("Task not found");
	});
});
