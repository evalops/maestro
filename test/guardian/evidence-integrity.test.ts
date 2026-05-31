import { describe, expect, it } from "vitest";
import { detectEvidenceIntegrityFindings } from "../../src/guardian/runner.js";

const joinParts = (...parts: string[]) => parts.join("");

const SYNTHETIC_SHA = joinParts(
	"9f3a",
	"20260520222033",
	"c0de",
	"5afe",
	"00000000000001",
);

const SYNTHETIC_PR_REF = joinParts(
	"evalops/platform#",
	"prod-pr-lane-20260520T222033Z-local",
);

const SYNTHETIC_GHA_RUN = joinParts("gha-run-", "20260520T222033Z", "-local");

describe("guardian evidence integrity scan", () => {
	it("blocks constructed identifiers that masquerade as production evidence", () => {
		const contents = JSON.stringify({
			proof: "production evidence",
			hard_identifiers: {
				commitSha: SYNTHETIC_SHA,
				pullRequest: SYNTHETIC_PR_REF,
				githubActionsRunId: SYNTHETIC_GHA_RUN,
				proofId: "a2a-swarm-proof-local",
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([
			"Synthetic production commit SHA",
			"Synthetic production PR reference",
			"Synthetic local GitHub Actions run ID",
			"Local proof identifier",
		]);
	});

	it("treats structured production-proof keys as evidence context", () => {
		const contents = [
			JSON.stringify({
				production_evidence: true,
				commitSha: SYNTHETIC_SHA,
			}),
			["live-proof:", `  githubActionsRunId: ${SYNTHETIC_GHA_RUN}`].join("\n"),
			JSON.stringify({
				hardIdentifiers: {
					proofId: "a2a-swarm-proof-local",
				},
			}),
		].join("\n");

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([
			"Synthetic production commit SHA",
			"Synthetic local GitHub Actions run ID",
			"Local proof identifier",
		]);
	});

	it("does not treat larger structured proof keys as evidence context", () => {
		const contents = JSON.stringify({
			nonproduction_evidence: true,
			not_live_proof: true,
			notHardIdentifiers: true,
			commitSha: SYNTHETIC_SHA,
		});

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([]);
	});

	it("treats camelCase production-proof keys as evidence context", () => {
		const contents = JSON.stringify({
			productionEvidence: true,
			liveProof: true,
			commitSha: SYNTHETIC_SHA,
			githubActionsRunId: SYNTHETIC_GHA_RUN,
		});

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([
			"Synthetic production commit SHA",
			"Synthetic local GitHub Actions run ID",
		]);
	});

	it("blocks replay artifacts that assert camelCase production proof", () => {
		const contents = JSON.stringify({
			deterministic_replay: {
				replay: true,
				toolResults: {
					productionEvidence: true,
				},
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toContain(
			"Replay artifact claimed as production evidence",
		);
	});

	it("blocks replay artifacts that assert live production proof", () => {
		const contents = JSON.stringify({
			deterministic_replay: {
				replay: true,
				tool_results: {
					production_evidence: true,
				},
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toContain(
			"Replay artifact claimed as production evidence",
		);
	});

	it("blocks replay artifacts that assert quoted boolean production proof", () => {
		const contents = JSON.stringify({
			deterministic_replay: {
				replay: true,
				tool_results: {
					production_evidence: "true",
				},
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toContain(
			"Replay artifact claimed as production evidence",
		);
	});

	it("blocks padded replay artifacts that assert live production proof", () => {
		const contents = JSON.stringify({
			deterministic_replay: {
				replay: true,
				padding: "x".repeat(900),
				tool_results: {
					production_evidence: true,
				},
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toContain(
			"Replay artifact claimed as production evidence",
		);
	});

	it("blocks replay artifacts that assert production evidence before the replay marker", () => {
		const contents = JSON.stringify({
			tool_results: {
				production_evidence: true,
			},
			deterministic_replay: {
				replay: true,
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toContain(
			"Replay artifact claimed as production evidence",
		);
	});

	it("does not treat unrelated replay-like keys as deterministic replay markers", () => {
		const contents = JSON.stringify({
			proof: "production evidence",
			tool_results: {
				production_evidence: true,
				session_replay: true,
				not_replay: true,
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([]);
	});

	it("does not treat larger proof field names as production evidence claims", () => {
		const contents = JSON.stringify({
			deterministic_replay: {
				replay: true,
				tool_results: {
					nonproduction_evidence: true,
					not_live_proof: true,
					"not-live-proof": true,
				},
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([]);
	});

	it("allows replay fixtures that are honestly labeled as local contract evidence", () => {
		const contents = JSON.stringify({
			deterministic_replay: {
				replay: true,
				proofId: "a2a-swarm-proof-local",
				evidenceClass: "local-contract",
				tool_results: {
					note: "schema replay only",
					githubActionsRunId: SYNTHETIC_GHA_RUN,
				},
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([]);
	});

	it("allows synthetic local run IDs outside production evidence claims", () => {
		const contents = [
			"Example local replay fixture:",
			`githubActionsRunId: ${SYNTHETIC_GHA_RUN}`,
			"proofId: a2a-swarm-proof-local",
		].join("\n");

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([]);
	});

	it("does not reject normal dereferenceable-looking production identifiers", () => {
		const contents = JSON.stringify({
			proof: "production evidence",
			hard_identifiers: {
				commitSha: "87b4b7e5d1790f5bd74102d91bfe45f1b84d2327",
				pullRequest: "evalops/platform#2496",
				githubActionsRunId: "15123456789",
				proofId: "a2a-swarm-proof-20260521T230100Z",
			},
		});

		expect(detectEvidenceIntegrityFindings(contents)).toEqual([]);
	});
});
