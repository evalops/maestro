import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RotatingLogWriter } from "../../src/tools/background/index.js";

describe("RotatingLogWriter", () => {
	let testDir: string;
	let logPath: string;
	let truncated: boolean;
	let shiftArchivesCalled: boolean;

	beforeEach(() => {
		testDir = join(tmpdir(), `log-rotation-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		logPath = join(testDir, "test.log");
		truncated = false;
		shiftArchivesCalled = false;
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	function createWriter(options: {
		limit?: number;
		segments?: number;
		existingSize?: number;
	}) {
		return new RotatingLogWriter({
			limit: options.limit ?? 1000,
			segments: options.segments ?? 3,
			logPath,
			existingSize: options.existingSize ?? 0,
			markTruncated: () => {
				truncated = true;
			},
			shiftArchives: () => {
				shiftArchivesCalled = true;
			},
			archivedPath: (index: number) => `${logPath}.${index}.gz`,
		});
	}

	function writeAndEnd(writer: RotatingLogWriter, data: string): Promise<void> {
		return new Promise((resolve, reject) => {
			writer.write(data, (err) => {
				if (err) return reject(err);
				writer.end((endErr: Error | null | undefined) => {
					if (endErr) return reject(endErr);
					resolve();
				});
			});
		});
	}

	describe("basic writing", () => {
		it("creates log file and writes data", async () => {
			const writer = createWriter({});
			await writeAndEnd(writer, "Hello, World!");

			expect(existsSync(logPath)).toBe(true);
			expect(readFileSync(logPath, "utf-8")).toBe("Hello, World!");
		});

		it("appends multiple writes", async () => {
			const writer = createWriter({});

			await new Promise<void>((resolve, reject) => {
				writer.write("First ", (err) => {
					if (err) return reject(err);
					writer.write("Second ", (err2) => {
						if (err2) return reject(err2);
						writer.write("Third", (err3) => {
							if (err3) return reject(err3);
							writer.end((endErr: Error | null | undefined) => {
								if (endErr) return reject(endErr);
								resolve();
							});
						});
					});
				});
			});

			expect(readFileSync(logPath, "utf-8")).toBe("First Second Third");
		});

		it("handles Buffer input", async () => {
			const writer = createWriter({});
			const buffer = Buffer.from("Buffer content");

			await new Promise<void>((resolve, reject) => {
				writer.write(buffer, (err) => {
					if (err) return reject(err);
					writer.end((endErr: Error | null | undefined) => {
						if (endErr) return reject(endErr);
						resolve();
					});
				});
			});

			expect(readFileSync(logPath, "utf-8")).toBe("Buffer content");
		});
	});

	describe("size limits", () => {
		it("truncates when limit is 0", async () => {
			const writer = createWriter({ limit: 0 });
			await writeAndEnd(writer, "Some data");

			expect(truncated).toBe(true);
		});

		it("marks truncated when exceeding limit with no segments", async () => {
			const writer = createWriter({ limit: 10, segments: 0 });
			await writeAndEnd(writer, "This is more than 10 bytes");

			expect(truncated).toBe(true);
		});

		it("writes up to limit before rotating", async () => {
			const writer = createWriter({ limit: 20, segments: 1 });
			await writeAndEnd(writer, "12345678901234567890"); // exactly 20 bytes

			expect(existsSync(logPath)).toBe(true);
			expect(readFileSync(logPath, "utf-8")).toBe("12345678901234567890");
			expect(truncated).toBe(false);
		});
	});

	describe("rotation", () => {
		it("rotates log file when limit exceeded", async () => {
			const writer = createWriter({ limit: 10, segments: 1 });
			const rotation = writer.waitForRotation();
			await writeAndEnd(writer, "12345678901234567890"); // 20 bytes

			const { archivePath } = await rotation;
			expect(existsSync(archivePath)).toBe(true);
			expect(shiftArchivesCalled).toBe(true);
		});

		it("compresses rotated logs with gzip", async () => {
			const writer = createWriter({ limit: 10, segments: 1 });
			const rotation = writer.waitForRotation();
			await writeAndEnd(writer, "First ten!Second ten"); // triggers rotation

			const { archivePath } = await rotation;
			expect(existsSync(archivePath)).toBe(true);

			// Decompress and verify content
			const compressed = readFileSync(archivePath);
			const decompressed = gunzipSync(compressed).toString("utf-8");
			expect(decompressed).toBe("First ten!");
		});

		it("calls shiftArchives before rotation", async () => {
			const writer = createWriter({ limit: 10, segments: 1 });
			const rotation = writer.waitForRotation();
			await writeAndEnd(writer, "More than ten bytes here");

			await rotation;
			expect(shiftArchivesCalled).toBe(true);
		});

		it("continues writing after rotation", async () => {
			const writer = createWriter({ limit: 10, segments: 1 });
			await writeAndEnd(writer, "First ten!After rot!");

			// Current log should have content after rotation
			const currentContent = readFileSync(logPath, "utf-8");
			expect(currentContent).toBe("After rot!");
		});
	});

	describe("existing file handling", () => {
		it("respects existingSize parameter", async () => {
			// Simulate existing log with 5 bytes
			const writer = createWriter({ limit: 10, existingSize: 5, segments: 1 });
			await writeAndEnd(writer, "12345"); // 5 more bytes = 10 total, at limit

			expect(existsSync(logPath)).toBe(true);
		});

		it("rotates immediately if existingSize >= limit", async () => {
			const writer = createWriter({
				limit: 10,
				existingSize: 10,
				segments: 1,
			});
			const rotation = writer.waitForRotation();
			await writeAndEnd(writer, "New data");

			await rotation;
			expect(shiftArchivesCalled).toBe(true);
		});
	});

	describe("error handling", () => {
		it("marks truncated when limit is zero", async () => {
			const writer = createWriter({ limit: 0, segments: 0 });

			await new Promise<void>((resolve) => {
				writer.write("data", () => {
					writer.end(() => resolve());
				});
			});

			expect(truncated).toBe(true);
		});

		it("handles drop-all mode gracefully", async () => {
			const writer = createWriter({ limit: 0, segments: 0 });

			// Multiple writes should all be dropped
			await new Promise<void>((resolve) => {
				writer.write("first", () => {
					writer.write("second", () => {
						writer.write("third", () => {
							writer.end(() => resolve());
						});
					});
				});
			});

			expect(truncated).toBe(true);
			// Log file should be empty or not exist
			if (existsSync(logPath)) {
				expect(readFileSync(logPath, "utf-8")).toBe("");
			}
		});
	});

	describe("_final callback", () => {
		it("waits for pending writes before calling final", async () => {
			const writer = createWriter({});
			let writeCompleted = false;

			await new Promise<void>((resolve, reject) => {
				writer.write("data", () => {
					writeCompleted = true;
				});
				writer.end((err: Error | null | undefined) => {
					if (err) return reject(err);
					expect(writeCompleted).toBe(true);
					resolve();
				});
			});
		});
	});
});
