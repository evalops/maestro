import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testing } from "../src/cli/commands/run.js";
import { SessionManager } from "../src/session/manager.js";
import { tryParseSessionEntry } from "../src/session/types.js";

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"test",
	"fixtures",
	"session-replay",
);

type RunReport = Awaited<
	ReturnType<typeof testing.buildRunReconstructionReport>
>;
type TimelineItem = NonNullable<RunReport>["timeline"]["items"][number];

function fixtureNames(): string[] {
	return readdirSync(fixturesDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
}

function sessionIdFromFixture(contents: string): string {
	const firstLine = contents
		.split("\n")
		.find((line) => line.trim().length > 0);
	assert(firstLine, "fixture must not be empty");
	const header = tryParseSessionEntry(firstLine);
	assert(header?.type === "session", "fixture must start with session header");
	return header.id;
}

function materializeFixture(contents: string): {
	sessionDir: string;
	sessionId: string;
} {
	const sessionId = sessionIdFromFixture(contents);
	const sessionDir = mkdtempSync(join(tmpdir(), "maestro-replay-fixture-"));
	const manager = new SessionManager(false, undefined, { sessionDir });
	const scopedSessionDir = dirname(manager.getSessionFile());
	mkdirSync(scopedSessionDir, { recursive: true });
	writeFileSync(join(scopedSessionDir, `${sessionId}.jsonl`), contents.trim());
	return { sessionDir, sessionId };
}

function compactItem(item: TimelineItem): Record<string, unknown> {
	const compact: Record<string, unknown> = {
		id: item.id,
		type: item.type,
		status: item.status,
		visibility: item.visibility,
		source: item.source,
		title: item.title,
	};
	for (const key of [
		"role",
		"toolCallId",
		"toolName",
		"summary",
		"approvalRequestId",
		"toolExecutionId",
		"pendingRequestId",
		"pendingRequestKind",
	] as const) {
		if (item[key] !== undefined) {
			compact[key] = item[key];
		}
	}
	return compact;
}

function normalizeReport(name: string, report: NonNullable<RunReport>) {
	return {
		schemaVersion: "evalops.maestro.session-replay-fixture.v1",
		fixture: name,
		session: {
			id: report.session.id,
			cwd: report.session.cwd,
			model: report.session.model,
			messageCount: report.session.messageCount,
		},
		counts: report.counts,
		coverage: report.coverage,
		promptContext: report.promptContext,
		contextManifest: report.contextManifest,
		timeline: report.timeline.items.map(compactItem),
	};
}

async function checkFixture(name: string, update: boolean): Promise<void> {
	const contents = readFileSync(join(fixturesDir, name), "utf8");
	const { sessionDir, sessionId } = materializeFixture(contents);
	try {
		const report = await testing.buildRunReconstructionReport(sessionId, {
			sessionDir,
		});
		assert(report, `fixture ${name} did not reconstruct`);
		const normalized = normalizeReport(name, report);
		const expectedPath = join(fixturesDir, name.replace(/\.jsonl$/u, ".replay.json"));
		const actual = `${JSON.stringify(normalized, null, "\t")}\n`;
		if (update) {
			writeFileSync(expectedPath, actual);
			return;
		}
		const expected = readFileSync(expectedPath, "utf8");
		assert.equal(actual, expected, `replay fixture drifted: ${name}`);
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const update = process.argv.includes("--update");
	const names = fixtureNames();
	for (const name of names) {
		await checkFixture(name, update);
	}
	console.log(
		`${update ? "Updated" : "Checked"} ${names.length} session replay fixture(s).`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
