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
import { validateAgentTrajectoryReport } from "../src/server/agent-trajectory-validation.js";
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

type RunReport = Awaited<
	ReturnType<typeof testing.buildRunReconstructionReport>
>;
type TrajectoryEvent = NonNullable<RunReport>["trajectory"]["events"][number];

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
	const sessionDir = mkdtempSync(join(tmpdir(), "maestro-trajectory-fixture-"));
	const manager = new SessionManager(false, undefined, { sessionDir });
	const scopedSessionDir = dirname(manager.getSessionFile());
	mkdirSync(scopedSessionDir, { recursive: true });
	writeFileSync(join(scopedSessionDir, `${sessionId}.jsonl`), contents.trim());
	return { sessionDir, sessionId };
}

function compactEvent(event: TrajectoryEvent): Record<string, unknown> {
	const compact: Record<string, unknown> = {
		id: event.id,
		sequence: event.sequence,
		kind: event.kind,
		phase: event.phase,
		actor: event.actor,
		type: event.type,
		status: event.status,
		visibility: event.visibility,
		source: event.source,
		title: event.title,
		evidence: event.evidence,
	};
	for (const key of ["toolName", "relatedIds", "summary"] as const) {
		if (event[key] !== undefined) {
			compact[key] = event[key];
		}
	}
	return compact;
}

function normalizeReport(
	name: string,
	report: Pick<NonNullable<RunReport>, "trajectory">,
) {
	return {
		schemaVersion: "evalops.maestro.agent-trajectory-fixture.v1",
		fixture: name,
		trajectorySchemaVersion: report.trajectory.schemaVersion,
		run: {
			id: report.trajectory.run.id,
			sessionId: report.trajectory.run.sessionId,
			source: report.trajectory.run.source,
			platformBacked: report.trajectory.run.platformBacked,
		},
		counts: report.trajectory.counts,
		events: report.trajectory.events.map(compactEvent),
	};
}

function serializeFixture(value: unknown): string {
	return `${JSON.stringify(value, null, "\t").replace(
		/(\t+"relatedIds": )\[\n((?:\t+"[^"]+",?\n)+)(\t+)\]/gu,
		(_match, prefix: string, body: string, closingIndent: string) => {
			const ids = body
				.trim()
				.split("\n")
				.map((line) => line.trim().replace(/,$/u, ""));
			const compact = `${prefix}[${ids.join(", ")}]`;
			return compact.length <= 80
				? compact
				: `${prefix}[\n${body}${closingIndent}]`;
		},
	)}\n`;
}

function checkNormalizedReport(
	name: string,
	report: Pick<NonNullable<RunReport>, "trajectory">,
	expectedPath: string,
	update: boolean,
): void {
	const validation = validateAgentTrajectoryReport(report.trajectory);
	assert.equal(
		validation.valid,
		true,
		`trajectory fixture failed validation: ${name}\n${validation.failures.join("\n")}`,
	);
	const normalized = normalizeReport(name, report);
	const actual = serializeFixture(normalized);
	if (update) {
		writeFileSync(expectedPath, actual);
		return;
	}
	const expected = readFileSync(expectedPath, "utf8");
	assert.equal(actual, expected, `trajectory fixture drifted: ${name}`);
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
		const expectedPath = join(
			sessionReplayFixturesDir,
			name.replace(/\.jsonl$/u, ".trajectory.json"),
		);
		checkNormalizedReport(`session-replay/${name}`, report, expectedPath, update);
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

function checkTimelineFixture(name: string, update: boolean): void {
	const timeline = JSON.parse(
		readFileSync(join(timelineFixturesDir, name), "utf8"),
	) as ComposerRunTimelineResponse;
	const report = { trajectory: buildAgentTrajectoryReport(timeline) };
	const expectedPath = join(
		timelineFixturesDir,
		name.replace(/\.timeline\.json$/u, ".trajectory.json"),
	);
	checkNormalizedReport(`agent-trajectory/${name}`, report, expectedPath, update);
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
		`${update ? "Updated" : "Checked"} ${checkedCount} agent trajectory fixture(s).`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
