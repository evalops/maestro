import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	A2A_SWARM_STAGE_GATE_MANIFEST,
	validateA2ASwarmStageGateManifest,
} from "../../scripts/check-evidence-integrity.ts";

let tempDir = "";

describe("evidence integrity stage-gate manifest", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("passes against the checked-in A2A swarm stage-gate manifest", () => {
		expect(validateA2ASwarmStageGateManifest(process.cwd())).toEqual([]);
	});

	it("requires realtime delivery to keep push notification evidence", () => {
		const manifest = readManifest();
		const realtime = manifest.stages.find(
			(stage) => stage.id === "stage-6-realtime-delivery",
		);
		expect(realtime).toBeDefined();
		const pushGate = realtime!.exitEvidence.find(
			(evidence) => evidence.id === "push-notifications-delivered",
		);
		expect(pushGate).toBeDefined();
		pushGate!.id = "push-notification-proof";

		const failures = validateManifestFixture(manifest);

		expect(failures).toContain(
			"docs/protocols/a2a-swarm-stage-gates.json stage-6-realtime-delivery exitEvidence missing evidence id push-notifications-delivered",
		);
	});

	it("requires stage gates to preserve production-proof invariants", () => {
		const manifest = readManifest();
		manifest.globalInvariants = manifest.globalInvariants.filter(
			(invariant) =>
				invariant !==
				"Live evidence must redact raw tokens and payloads while preserving enough stable identifiers for independent verification.",
		);

		const failures = validateManifestFixture(manifest);

		expect(failures).toContain(
			"docs/protocols/a2a-swarm-stage-gates.json globalInvariants missing Live evidence must redact raw tokens and payloads while preserving enough stable identifiers for independent verification.",
		);
	});
});

interface StageGateManifestFixture {
	globalInvariants: string[];
	stages: Array<{
		id: string;
		exitEvidence: Array<{ id: string }>;
	}>;
}

function readManifest(): StageGateManifestFixture {
	return JSON.parse(
		readFileSync(A2A_SWARM_STAGE_GATE_MANIFEST, "utf8"),
	) as StageGateManifestFixture;
}

function validateManifestFixture(manifest: StageGateManifestFixture): string[] {
	tempDir = join(
		tmpdir(),
		`a2a-stage-gates-${process.pid}-${Date.now()}-${Math.random()
			.toString(16)
			.slice(2)}`,
	);
	const manifestPath = join(tempDir, A2A_SWARM_STAGE_GATE_MANIFEST);
	mkdirSync(join(tempDir, "docs/protocols"), { recursive: true });
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
	return validateA2ASwarmStageGateManifest(tempDir);
}
