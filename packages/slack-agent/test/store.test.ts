import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelStore } from "../src/store.js";

describe("ChannelStore", () => {
	let dir: string;
	let store: ChannelStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-store-"));
		store = new ChannelStore({ workingDir: dir, botToken: "x" });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("generates sanitized local filenames", () => {
		const name = store.generateLocalFilename("a b/c.txt", "123.456");
		expect(name).toBe("123456_a_b_c.txt");
	});

	it("detects code/text attachments", () => {
		expect(
			store.isCodeOrTextFile({
				original: "file.rs",
				local: "x",
			}),
		).toBe(true);

		expect(
			store.isCodeOrTextFile({
				original: "image.png",
				local: "x",
				mimetype: "image/png",
			}),
		).toBe(false);

		expect(
			store.isCodeOrTextFile({
				original: "data",
				local: "x",
				mimetype: "application/json",
			}),
		).toBe(true);
	});

	it("dedupes repeated message timestamps", async () => {
		const msg = {
			date: new Date(0).toISOString(),
			ts: "1",
			user: "u",
			text: "hi",
			attachments: [],
			isBot: false,
		};

		expect(await store.logMessage("C1", { ...msg })).toBe(true);
		expect(await store.logMessage("C1", { ...msg })).toBe(false);

		const logPath = join(dir, "C1", "log.jsonl");
		const content = await readFile(logPath, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
	});
});
