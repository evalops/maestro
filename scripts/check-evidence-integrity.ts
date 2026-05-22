import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_EXCLUDES } from "../src/guardian/types.js";
import { detectEvidenceIntegrityFindings } from "../src/guardian/runner.js";

const A2A_SWARM_STAGE_GATE_MANIFEST =
	"docs/protocols/a2a-swarm-stage-gates.json";

const A2A_SWARM_STAGE_IDS = [
	"stage-0-integrity-foundation",
	"stage-1-platform-identity-topology",
	"stage-2-remote-delegation-task-control",
	"stage-3-subagent-federation",
	"stage-4-swarm-coordination",
	"stage-5-production-proof-operations",
	"stage-6-fleet-hardening",
] as const;

const REQUIRED_A2A_SWARM_STAGE_PROOF_CLASSES: Record<
	(typeof A2A_SWARM_STAGE_IDS)[number],
	string[]
> = {
	"stage-0-integrity-foundation": [
		"precommit-guardrail",
		"live-identifier-dereference",
		"signed-evidence",
		"negative-auth",
	],
	"stage-1-platform-identity-topology": [
		"identity",
		"peer-discovery",
		"heartbeat",
		"audit",
	],
	"stage-2-remote-delegation-task-control": [
		"delegation",
		"task-lifecycle",
		"task-control",
		"no-side-channel",
	],
	"stage-3-subagent-federation": [
		"subagent-routing",
		"capability-negotiation",
		"authorization",
		"provenance",
	],
	"stage-4-swarm-coordination": [
		"swarm-planning",
		"ownership",
		"failure-recovery",
		"outcome-reconciliation",
	],
	"stage-5-production-proof-operations": [
		"git-sha",
		"github-pr",
		"github-actions",
		"signed-evidence",
		"deploy-verifier",
		"traces",
	],
	"stage-6-fleet-hardening": [
		"load-soak",
		"chaos",
		"slo",
		"operator-runbook",
		"quota-retention",
	],
};

const FIXTURE_SELF_TEST_PATHS = [
	/test\/guardian\/evidence-integrity\.test\.ts$/,
	/test\/platform\/a2a-platform-delegation-live\.test\.ts$/,
	/test\/platform\/a2a-platform-live-evidence-verify\.test\.ts$/,
	/src\/guardian\/runner\.ts$/,
] as const;

function listTrackedFiles(root: string): string[] {
	const output = execFileSync("git", ["ls-files"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((file) => {
			const normalized = file.replace(/\\/g, "/");
			return !DEFAULT_EXCLUDES.some(
				(exclude) =>
					normalized === exclude ||
					normalized.startsWith(exclude) ||
					normalized.includes(`/${exclude}`),
			);
		});
}

function shouldSkipFixtureSelfTest(relative: string): boolean {
	return FIXTURE_SELF_TEST_PATHS.some((fixture) => fixture.test(relative));
}

function readTextFile(path: string): string | null {
	if (!existsSync(path)) {
		return null;
	}
	try {
		const stats = statSync(path);
		if (stats.size > 2 * 1024 * 1024) {
			return null;
		}
		const contents = readFileSync(path, "utf8");
		return contents.includes("\0") ? null : contents;
	} catch {
		return null;
	}
}

function validateA2ASwarmStageGateManifest(root: string): string[] {
	const manifestPath = resolve(root, A2A_SWARM_STAGE_GATE_MANIFEST);
	if (!existsSync(manifestPath)) {
		return [
			`Missing A2A swarm stage-gate manifest: ${A2A_SWARM_STAGE_GATE_MANIFEST}`,
		];
	}
	const contents = readFileSync(manifestPath, "utf8");
	const manifest = requireRecord(
		JSON.parse(contents) as unknown,
		A2A_SWARM_STAGE_GATE_MANIFEST,
	);
	const failures: string[] = [];
	const protocolVersion = stringField(manifest, "protocolVersion");
	if (protocolVersion !== "evalops.maestro.a2a-swarm-stage-gates.v1") {
		failures.push(
			`${A2A_SWARM_STAGE_GATE_MANIFEST} has unexpected protocolVersion ${protocolVersion}`,
		);
	}
	const stages = arrayField(manifest, "stages");
	if (stages.length !== A2A_SWARM_STAGE_IDS.length) {
		failures.push(
			`${A2A_SWARM_STAGE_GATE_MANIFEST} must define exactly ${A2A_SWARM_STAGE_IDS.length} stages`,
		);
	}
	const seenStageIds = new Set<string>();
	let previousStageId: string | undefined;
	stages.forEach((stageValue, index) => {
		const stage = requireRecord(stageValue, `stages[${index}]`);
		const stageId = stringField(stage, "id");
		const canonicalStageId = A2A_SWARM_STAGE_IDS[index];
		if (!canonicalStageId) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} stage ${index} id ${stageId} is not canonical`,
			);
		} else if (stageId !== canonicalStageId) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} stage ${index} id must be ${canonicalStageId}`,
			);
		}
		if (seenStageIds.has(stageId)) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} has duplicate stage id ${stageId}`,
			);
		}
		seenStageIds.add(stageId);
		stringField(stage, "title");
		stringField(stage, "purpose");
		const dependsOn = optionalStringArrayField(stage, "dependsOn");
		if (index === 0 && dependsOn.length > 0) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} first stage must not depend on prior stages`,
			);
		}
		if (index > 0 && previousStageId && !dependsOn.includes(previousStageId)) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} ${stageId} must depend on ${previousStageId}`,
			);
		}
		const entryEvidence = arrayField(stage, "entryEvidence");
		const exitEvidence = arrayField(stage, "exitEvidence");
		if (entryEvidence.length < 2) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} ${stageId} must define at least two entry evidence gates`,
			);
		}
		if (exitEvidence.length < 4) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} ${stageId} must define at least four exit evidence gates`,
			);
		}
		validateEvidenceList(stageId, "entryEvidence", entryEvidence, failures);
		const exitProofClasses = validateEvidenceList(
			stageId,
			"exitEvidence",
			exitEvidence,
			failures,
		);
		for (const proofClass of REQUIRED_A2A_SWARM_STAGE_PROOF_CLASSES[stageId] ??
			[]) {
			if (!exitProofClasses.has(proofClass)) {
				failures.push(
					`${A2A_SWARM_STAGE_GATE_MANIFEST} ${stageId} exitEvidence missing proofClass ${proofClass}`,
				);
			}
		}
		previousStageId = stageId;
	});
	return failures;
}

function validateEvidenceList(
	stageId: string,
	fieldName: "entryEvidence" | "exitEvidence",
	evidence: unknown[],
	failures: string[],
): Set<string> {
	const proofClasses = new Set<string>();
	const evidenceIds = new Set<string>();
	evidence.forEach((evidenceValue, index) => {
		const item = requireRecord(
			evidenceValue,
			`${stageId}.${fieldName}[${index}]`,
		);
		const id = stringField(item, "id");
		if (evidenceIds.has(id)) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} ${stageId}.${fieldName} has duplicate evidence id ${id}`,
			);
		}
		evidenceIds.add(id);
		stringField(item, "description");
		const proofClass = stringField(item, "proofClass");
		proofClasses.add(proofClass);
		const source = stringField(item, "authoritativeSource");
		const verification = stringField(item, "verification");
		if (/tbd|todo|later|manual vibe/iu.test(verification)) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} ${stageId}.${fieldName}.${id} has non-actionable verification`,
			);
		}
		if (
			fieldName === "exitEvidence" &&
			/(fixture|deterministic replay|local-only|synthetic)/iu.test(source)
		) {
			failures.push(
				`${A2A_SWARM_STAGE_GATE_MANIFEST} ${stageId}.${fieldName}.${id} exit source is not production-authoritative`,
			);
		}
	});
	return proofClasses;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return value.trim();
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
	const value = record[key];
	if (!Array.isArray(value)) {
		throw new Error(`${key} must be an array`);
	}
	return value;
}

function optionalStringArrayField(
	record: Record<string, unknown>,
	key: string,
): string[] {
	const value = record[key];
	if (value === undefined) {
		return [];
	}
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === "string" && entry.trim())
	) {
		throw new Error(`${key} must be an array of non-empty strings`);
	}
	return value.map((entry) => entry.trim());
}

function main(): void {
	const root = process.cwd();
	const findings: string[] = [];
	for (const relative of listTrackedFiles(root)) {
		if (shouldSkipFixtureSelfTest(relative)) {
			continue;
		}
		const contents = readTextFile(resolve(root, relative));
		if (!contents) {
			continue;
		}
		for (const finding of detectEvidenceIntegrityFindings(contents)) {
			findings.push(`${finding}: ${relative}`);
		}
	}
	for (const finding of validateA2ASwarmStageGateManifest(root)) {
		findings.push(finding);
	}
	if (findings.length > 0) {
		console.error("Evidence integrity check failed:");
		for (const finding of findings) {
			console.error(`- ${finding}`);
		}
		console.error(
			"Deterministic replay fixtures must not be presented as live production evidence. Use dereferenceable git SHAs, integer PRs, Actions run IDs/logs, deploy-verifier outcomes, and signed bundle identifiers for production proof.",
		);
		process.exitCode = 1;
		return;
	}
	console.log("Evidence integrity check passed.");
}

main();
