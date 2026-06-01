import assert from "node:assert/strict";
import {
	existsSync,
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
import type { ComposerRunTimelineResponse } from "@evalops/contracts";
import { testing } from "../src/cli/commands/run.js";
import { buildAgentTrajectoryReport } from "../src/server/agent-trajectory.js";
import {
	type AgentTrajectoryReplayReport,
	replayAgentTrajectoryReport,
} from "../src/server/agent-trajectory-replay.js";
import { SessionManager } from "../src/session/manager.js";
import { tryParseSessionEntry } from "../src/session/types.js";

const sessionReplayFixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"test",
	"fixtures",
	"session-replay",
);
const timelineFixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"test",
	"fixtures",
	"agent-trajectory",
);

function sessionReplayFixtureNames(): string[] {
	return readdirSync(sessionReplayFixturesDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
}

function timelineFixtureNames(): string[] {
	if (!existsSync(timelineFixturesDir)) return [];
	return readdirSync(timelineFixturesDir)
		.filter((name) => name.endsWith(".timeline.json"))
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
	const sessionDir = mkdtempSync(join(tmpdir(), "maestro-trajectory-replay-"));
	const manager = new SessionManager(false, undefined, { sessionDir });
	const scopedSessionDir = dirname(manager.getSessionFile());
	mkdirSync(scopedSessionDir, { recursive: true });
	writeFileSync(join(scopedSessionDir, `${sessionId}.jsonl`), contents.trim());
	return { sessionDir, sessionId };
}

function serializeReplay(value: unknown): string {
	return `${JSON.stringify(value, null, "\t").replace(
		/(\t+"resultSequences": )\[\n((?:\t+\d+,?\n)+)\t+\]/gu,
		(_match, prefix: string, body: string) => {
			const values = body
				.trim()
				.split("\n")
				.map((line) => line.trim().replace(/,$/u, ""));
			return `${prefix}[${values.join(", ")}]`;
		},
	)}\n`;
}

function normalizeReplay(
	value: AgentTrajectoryReplayReport,
): Omit<AgentTrajectoryReplayReport, "run"> & {
	run: Omit<AgentTrajectoryReplayReport["run"], "generatedAt">;
} {
	const { generatedAt: _generatedAt, ...run } = value.run;
	return { ...value, run };
}

function checkReplay(
	name: string,
	value: AgentTrajectoryReplayReport,
	expectedPath: string,
	update: boolean,
): void {
	const actual = serializeReplay(normalizeReplay(value));
	if (update) {
		writeFileSync(expectedPath, actual);
		return;
	}
	const expected = readFileSync(expectedPath, "utf8");
	assert.equal(actual, expected, `trajectory replay fixture drifted: ${name}`);
}

async function checkSessionReplayFixture(
	name: string,
	update: boolean,
): Promise<void> {
	const contents = readFileSync(join(sessionReplayFixturesDir, name), "utf8");
	const { sessionDir, sessionId } = materializeFixture(contents);
	try {
		const report = await testing.buildRunReconstructionReport(sessionId, {
			sessionDir,
		});
		assert(report, `fixture ${name} did not reconstruct`);
		const replay = replayAgentTrajectoryReport(report.trajectory);
		const expectedPath = join(
			sessionReplayFixturesDir,
			name.replace(/\.jsonl$/u, ".trajectory-replay.json"),
		);
		checkReplay(`session-replay/${name}`, replay, expectedPath, update);
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

function checkTimelineFixture(name: string, update: boolean): void {
	const timeline = JSON.parse(
		readFileSync(join(timelineFixturesDir, name), "utf8"),
	) as ComposerRunTimelineResponse;
	const trajectory = buildAgentTrajectoryReport(timeline);
	const replay = replayAgentTrajectoryReport(trajectory);
	const expectedPath = join(
		timelineFixturesDir,
		name.replace(/\.timeline\.json$/u, ".trajectory-replay.json"),
	);
	checkReplay(`agent-trajectory/${name}`, replay, expectedPath, update);
}

async function main(): Promise<void> {
	const update = process.argv.includes("--update");
	const sessionReplayNames = sessionReplayFixtureNames();
	const timelineNames = timelineFixtureNames();
	for (const name of sessionReplayNames) {
		await checkSessionReplayFixture(name, update);
	}
	for (const name of timelineNames) {
		checkTimelineFixture(name, update);
	}
	const checkedCount = sessionReplayNames.length + timelineNames.length;
	console.log(
		`${update ? "Updated" : "Checked"} ${checkedCount} agent trajectory replay fixture(s).`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
