/**
 * Integration tests for File Upload Handling
 *
 * Tests file upload processing, code file detection, and content extraction
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelStore } from "../../../packages/slack-agent/src/store.js";

describe("File Upload Integration", () => {
	let testDir: string;
	let store: ChannelStore;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`file-upload-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
		store = new ChannelStore({
			workingDir: testDir,
			botToken: "xoxb-test-token",
		});
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("Code File Detection", () => {
		it("detects JavaScript files", () => {
			const jsFiles = [
				{ original: "app.js", local: "test/app.js" },
				{ original: "index.jsx", local: "test/index.jsx" },
				{ original: "utils.ts", local: "test/utils.ts" },
				{ original: "component.tsx", local: "test/component.tsx" },
			];

			for (const file of jsFiles) {
				expect(store.isCodeOrTextFile(file)).toBe(true);
			}
		});

		it("detects Python files", () => {
			const pyFile = { original: "script.py", local: "test/script.py" };
			expect(store.isCodeOrTextFile(pyFile)).toBe(true);
		});

		it("detects config files", () => {
			const configs = [
				{ original: "config.json", local: "test/config.json" },
				{ original: "settings.yaml", local: "test/settings.yaml" },
				{ original: "docker-compose.yml", local: "test/compose.yml" },
				{ original: ".env", local: "test/.env" },
				{ original: ".gitignore", local: "test/.gitignore" },
				{ original: "tsconfig.json", local: "test/tsconfig.json" },
			];

			for (const config of configs) {
				expect(store.isCodeOrTextFile(config)).toBe(true);
			}
		});

		it("detects by mimetype", () => {
			const textFile = {
				original: "unknown",
				local: "test/unknown",
				mimetype: "text/plain",
			};
			expect(store.isCodeOrTextFile(textFile)).toBe(true);

			const jsonFile = {
				original: "data",
				local: "test/data",
				mimetype: "application/json",
			};
			expect(store.isCodeOrTextFile(jsonFile)).toBe(true);

			const jsFile = {
				original: "code",
				local: "test/code",
				mimetype: "application/javascript",
			};
			expect(store.isCodeOrTextFile(jsFile)).toBe(true);
		});

		it("detects by Slack filetype", () => {
			const pythonFile = {
				original: "script",
				local: "test/script",
				filetype: "python",
			};
			expect(store.isCodeOrTextFile(pythonFile)).toBe(true);

			const shellFile = {
				original: "run",
				local: "test/run",
				filetype: "shell",
			};
			expect(store.isCodeOrTextFile(shellFile)).toBe(true);
		});

		it("rejects binary files", () => {
			const binaryFiles = [
				{ original: "image.png", local: "test/image.png" },
				{ original: "photo.jpg", local: "test/photo.jpg" },
				{ original: "archive.zip", local: "test/archive.zip" },
				{ original: "document.pdf", local: "test/document.pdf" },
				{
					original: "binary",
					local: "test/binary",
					mimetype: "application/octet-stream",
				},
			];

			for (const file of binaryFiles) {
				expect(store.isCodeOrTextFile(file)).toBe(false);
			}
		});
	});

	describe("Content Reading", () => {
		it("reads code file content", () => {
			const channelId = "C123456";
			const attachment = {
				original: "test.js",
				local: `${channelId}/attachments/test.js`,
			};

			// Create the file
			const attachmentDir = join(testDir, channelId, "attachments");
			mkdirSync(attachmentDir, { recursive: true });
			writeFileSync(
				join(testDir, attachment.local),
				'console.log("Hello, World!");',
			);

			const content = store.readAttachmentContent(attachment);
			expect(content).toBe('console.log("Hello, World!");');
		});

		it("returns null for non-code files", () => {
			const attachment = {
				original: "image.png",
				local: "C123456/attachments/image.png",
			};

			const content = store.readAttachmentContent(attachment);
			expect(content).toBeNull();
		});

		it("returns null for files exceeding size limit", () => {
			const channelId = "C123456";
			const attachment = {
				original: "large.js",
				local: `${channelId}/attachments/large.js`,
				size: 200000, // 200KB - exceeds default 100KB limit
			};

			const content = store.readAttachmentContent(attachment);
			expect(content).toBeNull();
		});

		it("returns null for missing files", () => {
			const attachment = {
				original: "missing.js",
				local: "C123456/attachments/missing.js",
			};

			const content = store.readAttachmentContent(attachment);
			expect(content).toBeNull();
		});

		it("respects custom size limit", () => {
			const channelId = "C123456";
			const attachment = {
				original: "small.js",
				local: `${channelId}/attachments/small.js`,
			};

			// Create a file with 100 bytes
			const attachmentDir = join(testDir, channelId, "attachments");
			mkdirSync(attachmentDir, { recursive: true });
			const content = "x".repeat(100);
			writeFileSync(join(testDir, attachment.local), content);

			// Should read with 200 byte limit
			expect(store.readAttachmentContent(attachment, 200)).toBe(content);

			// Should return null with 50 byte limit
			expect(store.readAttachmentContent(attachment, 50)).toBeNull();
		});
	});

	describe("Attachment Processing", () => {
		it("processes files with metadata", () => {
			const files = [
				{
					name: "app.ts",
					url_private_download: "https://slack.com/files/app.ts",
					mimetype: "text/typescript",
					filetype: "typescript",
					size: 1024,
				},
			];

			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(1);
			expect(attachments[0].original).toBe("app.ts");
			expect(attachments[0].mimetype).toBe("text/typescript");
			expect(attachments[0].filetype).toBe("typescript");
			expect(attachments[0].size).toBe(1024);
		});

		it("handles multiple files", () => {
			const files = [
				{
					name: "index.js",
					url_private: "https://slack.com/files/index.js",
					mimetype: "application/javascript",
				},
				{
					name: "styles.css",
					url_private: "https://slack.com/files/styles.css",
					mimetype: "text/css",
				},
				{
					name: "README.md",
					url_private: "https://slack.com/files/README.md",
					mimetype: "text/markdown",
				},
			];

			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(3);
			expect(attachments.map((a) => a.original)).toEqual([
				"index.js",
				"styles.css",
				"README.md",
			]);
		});

		it("skips files without URL", () => {
			const files = [
				{ name: "nourl.js" },
				{ name: "hasurl.js", url_private: "https://slack.com/files/hasurl.js" },
			];

			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(1);
			expect(attachments[0].original).toBe("hasurl.js");
		});

		it("skips files without name", () => {
			const files = [
				{ url_private: "https://slack.com/files/noname" },
				{
					name: "hasname.js",
					url_private: "https://slack.com/files/hasname.js",
				},
			];

			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			expect(attachments).toHaveLength(1);
			expect(attachments[0].original).toBe("hasname.js");
		});

		it("generates unique local filenames from timestamp", () => {
			const files = [
				{ name: "test.js", url_private: "https://slack.com/files/test.js" },
			];

			const ts1 = "1234567890.123456";
			const ts2 = "1234567891.123456";

			const attachments1 = store.processAttachments("C123456", files, ts1);
			const attachments2 = store.processAttachments("C123456", files, ts2);

			expect(attachments1[0].local).not.toBe(attachments2[0].local);
		});

		it("sanitizes filenames with special characters", () => {
			const files = [
				{
					name: "my file (1).js",
					url_private: "https://slack.com/files/myfile.js",
				},
			];

			const attachments = store.processAttachments(
				"C123456",
				files,
				"1234567890.123456",
			);

			// Should not contain spaces or parentheses
			expect(attachments[0].local).not.toContain(" ");
			expect(attachments[0].local).not.toContain("(");
			expect(attachments[0].local).not.toContain(")");
			expect(attachments[0].local).toContain("my_file__1_.js");
		});
	});

	describe("Message Logging with Attachments", () => {
		it("logs message with attachment metadata", async () => {
			const channelId = "C123456";
			const message = {
				date: new Date().toISOString(),
				ts: "1234567890.123456",
				user: "U123456",
				userName: "testuser",
				text: "Here's my code",
				attachments: [
					{
						original: "app.ts",
						local: `${channelId}/attachments/app.ts`,
						mimetype: "text/typescript",
						filetype: "typescript",
						size: 1024,
					},
				],
				isBot: false,
			};

			const logged = await store.logMessage(channelId, message);
			expect(logged).toBe(true);

			// Verify the log file exists
			const logPath = join(testDir, channelId, "log.jsonl");
			expect(existsSync(logPath)).toBe(true);
		});

		it("deduplicates messages by timestamp", async () => {
			const channelId = "C123456";
			const message = {
				date: new Date().toISOString(),
				ts: "1234567890.123456",
				user: "U123456",
				text: "Same message",
				attachments: [],
				isBot: false,
			};

			const first = await store.logMessage(channelId, message);
			const second = await store.logMessage(channelId, message);

			expect(first).toBe(true);
			expect(second).toBe(false);
		});
	});

	describe("Channel Isolation", () => {
		it("stores attachments in channel-specific directories", () => {
			const files = [
				{ name: "file.js", url_private: "https://slack.com/files/file.js" },
			];

			const attachments1 = store.processAttachments(
				"C111111",
				files,
				"1234567890.123456",
			);
			const attachments2 = store.processAttachments(
				"C222222",
				files,
				"1234567890.123456",
			);

			expect(attachments1[0].local).toContain("C111111");
			expect(attachments2[0].local).toContain("C222222");
			expect(attachments1[0].local).not.toBe(attachments2[0].local);
		});
	});
});
