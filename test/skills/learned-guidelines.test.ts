import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendLearnedGuideline,
	formatLearnedGuidelinesForPrompt,
	getLearnedGuidelinesPath,
	loadLearnedGuidelines,
} from "../../src/skills/learned-guidelines.js";

const tempSkillsDirs: string[] = [];

function tempSkillsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "maestro-skills-"));
	tempSkillsDirs.push(dir);
	return dir;
}

async function waitForChildProcess(
	child: ReturnType<typeof spawn>,
): Promise<void> {
	const stderr: Buffer[] = [];
	child.stderr?.on("data", (chunk) => {
		stderr.push(Buffer.from(chunk));
	});
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`bun child exited with code ${code}: ${Buffer.concat(stderr).toString("utf-8")}`,
				),
			);
		});
	});
}

async function waitForChildReady(
	child: ReturnType<typeof spawn>,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let output = "";
		child.once("error", reject);
		child.once("exit", (code) => {
			if (!output.includes("ready")) {
				reject(new Error(`bun child exited before signaling ready: ${code}`));
			}
		});
		child.stdout?.on("data", (chunk) => {
			output += chunk.toString("utf-8");
			if (output.includes("ready")) {
				resolve();
			}
		});
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempSkillsDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("learned guidelines", () => {
	it("returns null when nothing has been recorded", () => {
		const dir = tempSkillsDir();
		expect(loadLearnedGuidelines("incident-triage", dir)).toBeNull();
		expect(formatLearnedGuidelinesForPrompt("incident-triage", dir)).toBeNull();
	});

	it("persists an entry that a later run can load", () => {
		const dir = tempSkillsDir();
		const path = appendLearnedGuideline(
			"incident-triage",
			"5xx spike on checkout -> check the payments service and the LB target group.",
			dir,
		);
		expect(path).toBe(getLearnedGuidelinesPath("incident-triage", dir));
		expect(loadLearnedGuidelines("incident-triage", dir)).toContain(
			"5xx spike on checkout",
		);
	});

	it("accumulates entries as an append-only log separated by rules", () => {
		const dir = tempSkillsDir();
		appendLearnedGuideline("incident-triage", "first mapping", dir);
		appendLearnedGuideline("incident-triage", "second mapping", dir);
		const file = readFileSync(
			getLearnedGuidelinesPath("incident-triage", dir),
			"utf-8",
		);
		expect(file).toContain("first mapping");
		expect(file).toContain("second mapping");
		expect(file).toContain("\n---\n");
	});

	it("wraps loaded guidelines in a prompt block that flags them as priors", () => {
		const dir = tempSkillsDir();
		appendLearnedGuideline(
			"incident-triage",
			"auth 401 storm -> rotate keys",
			dir,
		);
		const block = formatLearnedGuidelinesForPrompt("incident-triage", dir);
		expect(block).toContain("# Learned guidelines (incident-triage)");
		expect(block).toContain("priors to verify");
		expect(block).toContain("auth 401 storm");
	});

	it("rejects an empty entry", () => {
		const dir = tempSkillsDir();
		expect(() =>
			appendLearnedGuideline("incident-triage", "   ", dir),
		).toThrow();
	});

	it("rejects path-like skill names", () => {
		const dir = tempSkillsDir();
		expect(() => getLearnedGuidelinesPath("../incident-triage", dir)).toThrow(
			"Invalid skill name",
		);
		expect(() => loadLearnedGuidelines("incident/triage", dir)).toThrow(
			"Invalid skill name",
		);
		expect(() => appendLearnedGuideline("..", "do not escape", dir)).toThrow(
			"Invalid skill name",
		);
	});

	it("serializes concurrent appends so entries are not lost", async () => {
		const dir = tempSkillsDir();
		const modulePath = fileURLToPath(
			new URL("../../src/skills/learned-guidelines.ts", import.meta.url),
		);
		const entries = Array.from(
			{ length: 8 },
			(_, index) => `entry-${index + 1}`,
		);
		const script = `
import { appendLearnedGuideline } from ${JSON.stringify(modulePath)};
process.stdout.write("ready\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
appendLearnedGuideline("incident-triage", process.env.ENTRY, process.env.SKILLS_DIR);
`;
		const children = entries.map((entry) =>
			spawn("bun", ["--eval", script], {
				env: {
					...process.env,
					ENTRY: entry,
					SKILLS_DIR: dir,
				},
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);

		await Promise.all(children.map((child) => waitForChildReady(child)));
		appendLearnedGuideline("incident-triage", "seed-entry", dir);
		for (const child of children) {
			child.stdin?.end("\n");
		}
		await Promise.all(children.map((child) => waitForChildProcess(child)));

		const file = readFileSync(
			getLearnedGuidelinesPath("incident-triage", dir),
			"utf-8",
		);
		expect(file).toContain("seed-entry");
		for (const entry of entries) {
			expect(file).toContain(entry);
		}
	});

	it("recovers stale locks whose owner process is gone", () => {
		const dir = tempSkillsDir();
		const path = getLearnedGuidelinesPath("incident-triage", dir);
		const lockPath = `${path}.lock`;
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(
			join(lockPath, "owner.json"),
			JSON.stringify({
				pid: 9_999_999,
				token: "dead-owner",
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath, old, old);

		expect(() =>
			appendLearnedGuideline("incident-triage", "after stale lock", dir),
		).not.toThrow();
		expect(loadLearnedGuidelines("incident-triage", dir)).toContain(
			"after stale lock",
		);
	});

	it("does not recover a stale-looking lock while its owner is still alive", () => {
		const dir = tempSkillsDir();
		const path = getLearnedGuidelinesPath("incident-triage", dir);
		const lockPath = `${path}.lock`;
		const holder = spawn("bun", ["--eval", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
		});

		try {
			mkdirSync(lockPath, { recursive: true });
			writeFileSync(
				join(lockPath, "owner.json"),
				JSON.stringify({
					pid: holder.pid,
					token: "live-owner",
					createdAt: new Date(0).toISOString(),
				}),
				"utf-8",
			);
			utimesSync(lockPath, new Date(0), new Date(0));
			vi.spyOn(Date, "now")
				.mockReturnValueOnce(100_000)
				.mockReturnValueOnce(100_001)
				.mockReturnValue(130_026);

			expect(() =>
				appendLearnedGuideline("incident-triage", "should-time-out", dir),
			).toThrow("timed out waiting for learned guidelines lock");
			expect(loadLearnedGuidelines("incident-triage", dir)).toBeNull();
			expect(() =>
				readFileSync(join(lockPath, "owner.json"), "utf-8"),
			).not.toThrow();
		} finally {
			holder.kill("SIGKILL");
			rmSync(lockPath, { recursive: true, force: true });
		}
	});

	it("prunes old entries when the guidelines log grows too large", () => {
		const dir = tempSkillsDir();
		appendLearnedGuideline("incident-triage", "first-entry", dir);
		for (let index = 0; index < 80; index++) {
			appendLearnedGuideline(
				"incident-triage",
				`entry-${index}-${"x".repeat(1024)}`,
				dir,
			);
		}

		const file = readFileSync(
			getLearnedGuidelinesPath("incident-triage", dir),
			"utf-8",
		);
		expect(file).not.toContain("first-entry");
		expect(file).toContain("entry-79");
		expect(Buffer.byteLength(file, "utf-8")).toBeLessThanOrEqual(64 * 1024 + 1);
	});

	it("rejects near-limit entries that exceed the serialized size cap", () => {
		const dir = tempSkillsDir();
		appendLearnedGuideline("incident-triage", "keep-existing", dir);

		expect(() =>
			appendLearnedGuideline("incident-triage", "x".repeat(64 * 1024 - 10), dir),
		).toThrow("exceeds");

		const file = readFileSync(
			getLearnedGuidelinesPath("incident-triage", dir),
			"utf-8",
		);
		expect(file).toContain("keep-existing");
		expect(Buffer.byteLength(file, "utf-8")).toBeLessThanOrEqual(64 * 1024 + 1);
	});

	it("rejects oversized entries without dropping bounded history", () => {
		const oversizedEntry = `oversized-${"x".repeat(70 * 1024)}`;
		const emptyDir = tempSkillsDir();
		expect(() =>
			appendLearnedGuideline("incident-triage", oversizedEntry, emptyDir),
		).toThrow("exceeds");
		expect(loadLearnedGuidelines("incident-triage", emptyDir)).toBeNull();
		expect(
			existsSync(getLearnedGuidelinesPath("incident-triage", emptyDir)),
		).toBe(false);

		const dir = tempSkillsDir();
		appendLearnedGuideline("incident-triage", "keep-this-entry", dir);
		const path = getLearnedGuidelinesPath("incident-triage", dir);
		const before = readFileSync(path, "utf-8");
		expect(() =>
			appendLearnedGuideline("incident-triage", oversizedEntry, dir),
		).toThrow("exceeds");
		const file = readFileSync(path, "utf-8");
		expect(file).toBe(before);
		expect(file).toContain("keep-this-entry");
		expect(Buffer.byteLength(file, "utf-8")).toBeLessThanOrEqual(64 * 1024);
	});

	it("preserves marker entries with CRLF line endings", () => {
		const dir = tempSkillsDir();
		const path = getLearnedGuidelinesPath("incident-triage", dir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			"<!-- maestro-learned-guideline-entry -->\r\nfirst-entry\r\n\r\n---\r\n\r\n<!-- maestro-learned-guideline-entry -->\r\nsecond-entry\r\n",
			"utf-8",
		);

		appendLearnedGuideline("incident-triage", "third-entry", dir);

		const loaded = loadLearnedGuidelines("incident-triage", dir);
		expect(loaded).toContain("first-entry");
		expect(loaded).toContain("second-entry");
		expect(loaded).toContain("third-entry");
	});

	it("preserves guideline text that contains the entry marker", () => {
		const dir = tempSkillsDir();
		const markerBearingEntry =
			"first line\n<!-- maestro-learned-guideline-entry -->\nmarker stays in the body";

		appendLearnedGuideline("incident-triage", markerBearingEntry, dir);
		appendLearnedGuideline("incident-triage", "second-entry", dir);

		const loaded = loadLearnedGuidelines("incident-triage", dir);
		expect(loaded).toContain(markerBearingEntry);
		expect(loaded).toContain("second-entry");
	});

	it("caps oversized legacy files when loading learned guidelines", () => {
		const dir = tempSkillsDir();
		const path = getLearnedGuidelinesPath("incident-triage", dir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			`<!-- maestro-learned-guideline-entry -->\noversized-entry-${"x".repeat(70 * 1024)}\n\n---\n\n<!-- maestro-learned-guideline-entry -->\nbounded-entry\n`,
			"utf-8",
		);

		const loaded = loadLearnedGuidelines("incident-triage", dir);
		const prompt = formatLearnedGuidelinesForPrompt("incident-triage", dir);
		expect(loaded).not.toContain("oversized-entry-");
		expect(loaded).toContain("bounded-entry");
		expect(Buffer.byteLength(loaded ?? "", "utf-8")).toBeLessThanOrEqual(
			64 * 1024,
		);
		expect(prompt).toContain("bounded-entry");
		expect(Buffer.byteLength(prompt ?? "", "utf-8")).toBeLessThanOrEqual(
			64 * 1024,
		);
	});

	it("truncates oversized single-entry legacy files when loading guidelines", () => {
		const dir = tempSkillsDir();
		const path = getLearnedGuidelinesPath("incident-triage", dir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			`<!-- maestro-learned-guideline-entry -->\noversized-only-${"x".repeat(70 * 1024)}\n`,
			"utf-8",
		);

		const loaded = loadLearnedGuidelines("incident-triage", dir);
		expect(loaded).toContain("oversized-only-");
		expect(loaded).toContain("truncated to fit byte cap");
		expect(Buffer.byteLength(loaded ?? "", "utf-8")).toBeLessThanOrEqual(
			64 * 1024,
		);
	});

	it("keeps a near-limit accepted entry in the prompt block", () => {
		const dir = tempSkillsDir();
		const entry = `near-limit-${"x".repeat(64 * 1024 - 80)}`;

		appendLearnedGuideline("incident-triage", entry, dir);

		const loaded = loadLearnedGuidelines("incident-triage", dir);
		const prompt = formatLearnedGuidelinesForPrompt("incident-triage", dir);
		expect(loaded).toContain("near-limit-");
		expect(prompt).toContain("near-limit-");
		expect(prompt).toContain("truncated to fit byte cap");
		expect(Buffer.byteLength(prompt ?? "", "utf-8")).toBeLessThanOrEqual(
			64 * 1024,
		);
	});

	it("preserves entries containing the legacy separator plus marker boundary", () => {
		const dir = tempSkillsDir();
		const boundaryBearingEntry =
			"alpha\n\n---\n\n<!-- maestro-learned-guideline-entry -->\nembedded-boundary";

		appendLearnedGuideline("incident-triage", boundaryBearingEntry, dir);
		appendLearnedGuideline("incident-triage", "second-entry", dir);

		const loaded = loadLearnedGuidelines("incident-triage", dir);
		expect(loaded).toContain(boundaryBearingEntry);
		expect(loaded).toContain("second-entry");
	});

	it("parses marker-formatted files with a UTF-8 BOM", () => {
		const dir = tempSkillsDir();
		const path = getLearnedGuidelinesPath("incident-triage", dir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			"\uFEFF<!-- maestro-learned-guideline-entry -->\nfirst-entry\n\n---\n\n<!-- maestro-learned-guideline-entry -->\nsecond-entry\n",
			"utf-8",
		);

		appendLearnedGuideline("incident-triage", "third-entry", dir);

		const loaded = loadLearnedGuidelines("incident-triage", dir);
		expect(loaded).toContain("first-entry");
		expect(loaded).toContain("second-entry");
		expect(loaded).toContain("third-entry");
	});

	it("does not prune a delimiter-bearing entry into partial fragments", () => {
		const dir = tempSkillsDir();
		const delimiterBearingEntry = `${"a".repeat(30 * 1024)}\n\n---\n\nbeta-marker-${"b".repeat(30 * 1024)}`;
		const laterEntry = `later-entry-${"c".repeat(10 * 1024)}`;

		appendLearnedGuideline("incident-triage", delimiterBearingEntry, dir);
		appendLearnedGuideline("incident-triage", laterEntry, dir);

		const loaded = loadLearnedGuidelines("incident-triage", dir);
		expect(loaded).toContain("later-entry-");
		expect(loaded).not.toContain("beta-marker-");
	});
});
