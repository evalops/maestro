/**
 * Tests for store.ts - Channel message logging and attachment management
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ChannelStore,
	type LoggedMessage,
} from "../../packages/slack-agent/src/store.js";

describe("ChannelStore", () => {
	let testDir: string;
	let store: ChannelStore;

	beforeEach(() => {
		// Create a unique temp directory for each test
		testDir = join(
			tmpdir(),
			`slack-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		store = new ChannelStore({
			workingDir: testDir,
			botToken: "test-bot-token-placeholder",
		});
	});

	afterEach(() => {
		// Clean up temp directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("constructor", () => {
		it("creates working directory if it does not exist", () => {
			const newDir = join(testDir, "new-subdir");
			new ChannelStore({ workingDir: newDir, botToken: "test" });
			expect(existsSync(newDir)).toBe(true);
		});

		it("does not fail if working directory already exists", () => {
			mkdirSync(testDir, { recursive: true });
			expect(() => {
				new ChannelStore({ workingDir: testDir, botToken: "test" });
			}).not.toThrow();
		});
	});

	describe("getChannelDir", () => {
		it("creates channel directory if it does not exist", () => {
			const channelDir = store.getChannelDir("C123456");
			expect(existsSync(channelDir)).toBe(true);
			expect(channelDir).toBe(join(testDir, "C123456"));
		});

		it("returns existing channel directory without error", () => {
			const channelDir1 = store.getChannelDir("C123456");
			const channelDir2 = store.getChannelDir("C123456");
			expect(channelDir1).toBe(channelDir2);
		});

		it("creates separate directories for different channels", () => {
			const dir1 = store.getChannelDir("C111111");
			const dir2 = store.getChannelDir("C222222");
			expect(dir1).not.toBe(dir2);
			expect(existsSync(dir1)).toBe(true);
			expect(existsSync(dir2)).toBe(true);
		});
	});

	describe("generateLocalFilename", () => {
		it("generates filename with timestamp prefix", () => {
			const filename = store.generateLocalFilename(
				"test.png",
				"1234567890.123456",
			);
			expect(filename).toMatch(/^\d+_test\.png$/);
		});

		it("sanitizes special characters in filename", () => {
			const filename = store.generateLocalFilename(
				"test file (1).png",
				"1234567890.123456",
			);
			expect(filename).not.toContain(" ");
			expect(filename).not.toContain("(");
			expect(filename).not.toContain(")");
			expect(filename).toContain("test_file__1_.png");
		});

		it("preserves allowed characters", () => {
			const filename = store.generateLocalFilename(
				"my-file_v2.tar.gz",
				"1234567890.123456",
			);
			expect(filename).toContain("my-file_v2.tar.gz");
		});

		it("converts timestamp to milliseconds", () => {
			const filename = store.generateLocalFilename(
				"test.txt",
				"1234567890.000000",
			);
			expect(filename).toMatch(/^1234567890000_test\.txt$/);
		});
	});

	describe("processAttachments", () => {
		it("returns empty array for empty files list", () => {
			const attachments = store.processAttachments(
				"C123456",
				[],
				"1234567890.123456",
			);
			expect(attachments).toEqual([]);
		});

		it("creates attachment objects with local paths", () => {
			const files = [
				{
					name: "image.png",
					url_private_download: "https://slack.com/files/image.png",
				},
			];
			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(1);
			expect(attachments[0].original).toBe("image.png");
			expect(attachments[0].local).toContain("C123456/attachments/");
			expect(attachments[0].local).toContain("image.png");
		});

		it("uses url_private as fallback when url_private_download is missing", () => {
			const files = [
				{
					name: "document.pdf",
					url_private: "https://slack.com/files/document.pdf",
				},
			];
			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(1);
			expect(attachments[0].original).toBe("document.pdf");
		});

		it("skips files without URL", () => {
			const files = [
				{ name: "no-url.txt" },
				{
					name: "has-url.txt",
					url_private_download: "https://slack.com/files/has-url.txt",
				},
			];
			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(1);
			expect(attachments[0].original).toBe("has-url.txt");
		});

		it("skips files without name", () => {
			const files = [
				{ url_private_download: "https://slack.com/files/unnamed" },
			];
			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(0);
		});

		it("handles multiple files", () => {
			const files = [
				{
					name: "file1.png",
					url_private_download: "https://slack.com/files/file1.png",
				},
				{
					name: "file2.jpg",
					url_private_download: "https://slack.com/files/file2.jpg",
				},
				{
					name: "file3.pdf",
					url_private: "https://slack.com/files/file3.pdf",
				},
			];
			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(3);
		});
	});

	describe("logMessage", () => {
		it("creates log file and writes message", async () => {
			const message: LoggedMessage = {
				date: new Date().toISOString(),
				ts: "1234567890.123456",
				user: "U123456",
				userName: "testuser",
				displayName: "Test User",
				text: "Hello, world!",
				attachments: [],
				isBot: false,
			};

			const logged = await store.logMessage("C123456", message);
			expect(logged).toBe(true);

			const logPath = join(testDir, "C123456", "log.jsonl");
			expect(existsSync(logPath)).toBe(true);

			const content = readFileSync(logPath, "utf-8");
			const parsed = JSON.parse(content.trim());
			expect(parsed.text).toBe("Hello, world!");
			expect(parsed.user).toBe("U123456");
		});

		it("appends multiple messages to log file", async () => {
			const message1: LoggedMessage = {
				date: new Date().toISOString(),
				ts: "1234567890.111111",
				user: "U111111",
				text: "First message",
				attachments: [],
				isBot: false,
			};

			const message2: LoggedMessage = {
				date: new Date().toISOString(),
				ts: "1234567890.222222",
				user: "U222222",
				text: "Second message",
				attachments: [],
				isBot: false,
			};

			await store.logMessage("C123456", message1);
			await store.logMessage("C123456", message2);

			const logPath = join(testDir, "C123456", "log.jsonl");
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");

			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0]).text).toBe("First message");
			expect(JSON.parse(lines[1]).text).toBe("Second message");
		});

		it("deduplicates messages with same channel and timestamp", async () => {
			const message: LoggedMessage = {
				date: new Date().toISOString(),
				ts: "1234567890.123456",
				user: "U123456",
				text: "Duplicate message",
				attachments: [],
				isBot: false,
			};

			const logged1 = await store.logMessage("C123456", message);
			const logged2 = await store.logMessage("C123456", message);

			expect(logged1).toBe(true);
			expect(logged2).toBe(false);

			const logPath = join(testDir, "C123456", "log.jsonl");
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");

			expect(lines).toHaveLength(1);
		});

		it("generates date from timestamp if not provided", async () => {
			const message: LoggedMessage = {
				date: "",
				ts: "1234567890.123456",
				user: "U123456",
				text: "No date provided",
				attachments: [],
				isBot: false,
			};

			await store.logMessage("C123456", message);

			const logPath = join(testDir, "C123456", "log.jsonl");
			const content = readFileSync(logPath, "utf-8");
			const parsed = JSON.parse(content.trim());

			expect(parsed.date).toBeTruthy();
			expect(new Date(parsed.date).getTime()).toBeGreaterThan(0);
		});

		it("handles bot messages correctly", async () => {
			const message: LoggedMessage = {
				date: new Date().toISOString(),
				ts: "1234567890.123456",
				user: "bot",
				text: "Bot response",
				attachments: [],
				isBot: true,
			};

			await store.logMessage("C123456", message);

			const logPath = join(testDir, "C123456", "log.jsonl");
			const content = readFileSync(logPath, "utf-8");
			const parsed = JSON.parse(content.trim());

			expect(parsed.isBot).toBe(true);
			expect(parsed.user).toBe("bot");
		});

		it("includes attachments in logged message", async () => {
			const message: LoggedMessage = {
				date: new Date().toISOString(),
				ts: "1234567890.123456",
				user: "U123456",
				text: "Message with attachments",
				attachments: [
					{
						original: "file1.png",
						local: "C123456/attachments/1234_file1.png",
					},
					{
						original: "file2.jpg",
						local: "C123456/attachments/1234_file2.jpg",
					},
				],
				isBot: false,
			};

			await store.logMessage("C123456", message);

			const logPath = join(testDir, "C123456", "log.jsonl");
			const content = readFileSync(logPath, "utf-8");
			const parsed = JSON.parse(content.trim());

			expect(parsed.attachments).toHaveLength(2);
			expect(parsed.attachments[0].original).toBe("file1.png");
		});
	});

	describe("logBotResponse", () => {
		it("logs bot response with correct format", async () => {
			await store.logBotResponse(
				"C123456",
				"Hello from bot!",
				"1234567890.123456",
			);

			const logPath = join(testDir, "C123456", "log.jsonl");
			const content = readFileSync(logPath, "utf-8");
			const parsed = JSON.parse(content.trim());

			expect(parsed.user).toBe("bot");
			expect(parsed.text).toBe("Hello from bot!");
			expect(parsed.isBot).toBe(true);
			expect(parsed.attachments).toEqual([]);
		});
	});

	describe("getLastTimestamp", () => {
		it("returns null for non-existent channel", () => {
			const ts = store.getLastTimestamp("C999999");
			expect(ts).toBeNull();
		});

		it("returns null for empty log file", async () => {
			// Create empty channel directory
			store.getChannelDir("C123456");

			const ts = store.getLastTimestamp("C123456");
			expect(ts).toBeNull();
		});

		it("returns timestamp from last message", async () => {
			const message1: LoggedMessage = {
				date: new Date().toISOString(),
				ts: "1234567890.111111",
				user: "U111111",
				text: "First",
				attachments: [],
				isBot: false,
			};

			const message2: LoggedMessage = {
				date: new Date().toISOString(),
				ts: "1234567890.222222",
				user: "U222222",
				text: "Last",
				attachments: [],
				isBot: false,
			};

			await store.logMessage("C123456", message1);
			await store.logMessage("C123456", message2);

			const ts = store.getLastTimestamp("C123456");
			expect(ts).toBe("1234567890.222222");
		});

		it("handles malformed JSON gracefully", async () => {
			// Create channel directory and write invalid JSON
			const channelDir = store.getChannelDir("C123456");
			const logPath = join(channelDir, "log.jsonl");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(logPath, "not valid json\n");

			const ts = store.getLastTimestamp("C123456");
			expect(ts).toBeNull();
		});
	});

	describe("clearHistory", () => {
		it("clears conversation history", async () => {
			// Create some messages
			await store.logMessage("C123456", {
				date: new Date().toISOString(),
				ts: "1234567890.111111",
				user: "U111111",
				text: "First message",
				attachments: [],
				isBot: false,
			});
			await store.logMessage("C123456", {
				date: new Date().toISOString(),
				ts: "1234567890.222222",
				user: "U111111",
				text: "Second message",
				attachments: [],
				isBot: false,
			});

			// Verify messages exist
			const logPath = join(testDir, "C123456", "log.jsonl");
			expect(readFileSync(logPath, "utf-8").trim().split("\n")).toHaveLength(2);

			// Clear history
			await store.clearHistory("C123456");

			// Verify log is empty
			expect(readFileSync(logPath, "utf-8")).toBe("");
		});

		it("creates backup before clearing", async () => {
			await store.logMessage("C123456", {
				date: new Date().toISOString(),
				ts: "1234567890.111111",
				user: "U111111",
				text: "Message to backup",
				attachments: [],
				isBot: false,
			});

			await store.clearHistory("C123456");

			// Check backup file exists
			const channelDir = join(testDir, "C123456");
			const files = readdirSync(channelDir);
			const backupFiles = files.filter((f) => f.endsWith(".jsonl.bak"));

			expect(backupFiles).toHaveLength(1);

			// Verify backup contains the original data
			const backupContent = readFileSync(
				join(channelDir, backupFiles[0]),
				"utf-8",
			);
			expect(backupContent).toContain("Message to backup");
		});

		it("handles non-existent channel gracefully", async () => {
			// Should not throw
			await expect(store.clearHistory("C999999")).resolves.not.toThrow();
		});
	});
});
