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
	type AgentTrajectoryInspectionReport,
	buildAgentTrajectoryInspectionReport,
} from "../src/server/agent-trajectory-inspection.js";
import { replayAgentTrajectoryReport } from "../src/server/agent-trajectory-replay.js";
import { scoreAgentTrajectoryReport } from "../src/server/agent-trajectory-scorers.js";
import { SessionManager } from "../src/session/manager.js";
import { tryParseSessionEntry } from "../src/session/types.js";
import { rulesForTrajectoryFixture } from "./agent-trajectory-fixture-rules.js";

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
	const sessionDir = mkdtempSync(join(tmpdir(), "maestro-trajectory-lab-"));
	const manager = new SessionManager(false, undefined, { sessionDir });
	const scopedSessionDir = dirname(manager.getSessionFile());
	mkdirSync(scopedSessionDir, { recursive: true });
	writeFileSync(join(scopedSessionDir, `${sessionId}.jsonl`), contents.trim());
	return { sessionDir, sessionId };
}

function normalizeInspection(
	value: AgentTrajectoryInspectionReport,
): Omit<AgentTrajectoryInspectionReport, "run"> & {
	run: Omit<AgentTrajectoryInspectionReport["run"], "generatedAt">;
} {
	const { generatedAt: _generatedAt, ...run } = value.run;
	return { ...value, run };
}

function serializeInspection(value: AgentTrajectoryInspectionReport): string {
	return `${JSON.stringify(normalizeInspection(value), null, "\t")}\n`;
}

function checkInspection(
	name: string,
	value: AgentTrajectoryInspectionReport,
	expectedPath: string,
	update: boolean,
): void {
	const actual = serializeInspection(value);
	if (update) {
		writeFileSync(expectedPath, actual);
		return;
	}
	const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
	assert.deepEqual(
		normalizeInspection(value),
		expected,
		`trajectory inspection fixture drifted: ${name}`,
	);
}

async function checkSessionReplayFixture(
	name: string,
	update: boolean,
): Promise<void> {
	const fixtureName = `session-replay/${name}`;
	const contents = readFileSync(join(sessionReplayFixturesDir, name), "utf8");
	const { sessionDir, sessionId } = materializeFixture(contents);
	try {
		const report = await testing.buildRunReconstructionReport(sessionId, {
			sessionDir,
		});
		assert(report, `fixture ${name} did not reconstruct`);
		const score = scoreAgentTrajectoryReport(
			report.trajectory,
			rulesForTrajectoryFixture(fixtureName),
		);
		const inspection = buildAgentTrajectoryInspectionReport({
			timelineItems: report.timeline.items,
			trajectory: report.trajectory,
			replay: report.trajectoryReplay,
			score,
		});
		const expectedPath = join(
			sessionReplayFixturesDir,
			name.replace(/\.jsonl$/u, ".trajectory-inspection.json"),
		);
		checkInspection(fixtureName, inspection, expectedPath, update);
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

function checkTimelineFixture(name: string, update: boolean): void {
	const fixtureName = `agent-trajectory/${name}`;
	const timeline = JSON.parse(
		readFileSync(join(timelineFixturesDir, name), "utf8"),
	) as ComposerRunTimelineResponse;
	const trajectory = buildAgentTrajectoryReport(timeline);
	const replay = replayAgentTrajectoryReport(trajectory);
	const score = scoreAgentTrajectoryReport(
		trajectory,
		rulesForTrajectoryFixture(fixtureName),
	);
	const inspection = buildAgentTrajectoryInspectionReport({
		timelineItems: timeline.items,
		trajectory,
		replay,
		score,
	});
	const expectedPath = join(
		timelineFixturesDir,
		name.replace(/\.timeline\.json$/u, ".trajectory-inspection.json"),
	);
	checkInspection(fixtureName, inspection, expectedPath, update);
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
		`${update ? "Updated" : "Checked"} ${checkedCount} agent trajectory inspection fixture(s).`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
