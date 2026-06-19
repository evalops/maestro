import { describe, expect, it } from "vitest";
import {
	DEFAULT_RELEASE_CANARY_STAGES,
	MAESTRO_OPERATING_LAYER_VERSION,
	buildApprovalDecisionEvidence,
	buildOperatingLayerManifest,
	buildProtocolBoundaryDescriptor,
	buildReleaseCanaryPlan,
	buildRunEffectivenessReport,
	buildRunReadinessReport,
	classifySyncOutcome,
	evaluateExtensionGovernance,
	explainResolvedPolicy,
} from "../../src/platform/operating-layer.js";

describe("operating layer primitives", () => {
	it("declares the platform capabilities that make up the operating layer", () => {
		const manifest = buildOperatingLayerManifest();

		expect(manifest.version).toBe(MAESTRO_OPERATING_LAYER_VERSION);
		expect(manifest.capabilities.map((capability) => capability.id)).toEqual([
			"protocol-boundary",
			"policy-resolution",
			"sync-outbox",
			"approval-evidence",
			"extension-governance",
			"run-readiness",
			"run-effectiveness",
			"release-canary",
		]);
		expect(
			manifest.capabilities.every(
				(capability) => capability.evidenceKinds.length > 0,
			),
		).toBe(true);
	});

	it("turns protocol surfaces into explicit versioned boundaries", () => {
		expect(
			buildProtocolBoundaryDescriptor({
				protocolId: "maestro.headless",
				version: "v1",
				owners: [" platform ", "platform"],
				contracts: ["session-wire", "rpc"],
				compatibility: "stable",
			}),
		).toEqual(
			expect.objectContaining({
				protocolId: "maestro.headless",
				version: "v1",
				owners: ["platform"],
				contracts: ["session-wire", "rpc"],
				compatibility: "stable",
				reasons: expect.arrayContaining([
					"protocol:maestro.headless",
					"version:v1",
					"owner:platform",
					"contract:session-wire",
				]),
			}),
		);
	});

	it("explains policy resolution with the active source and override chain", () => {
		const explanation = explainResolvedPolicy("approvals.mode", [
			{
				layer: "default",
				id: "defaults",
				value: "ask",
				reason: "safe default",
			},
			{
				layer: "workspace",
				id: "workspace",
				value: "suggest",
				reason: "workspace policy",
			},
			{
				layer: "session",
				id: "session",
				value: "deny",
				reason: "incident response",
			},
		]);

		expect(explanation.resolvedValue).toBe("deny");
		expect(explanation.activeSource).toEqual(
			expect.objectContaining({ id: "session", layer: "session" }),
		);
		expect(explanation.chain[2]).toEqual(
			expect.objectContaining({
				id: "session",
				overrides: ["defaults", "workspace"],
			}),
		);
		expect(explanation.reasons).toEqual(
			expect.arrayContaining([
				"subject:approvals.mode",
				"active_source:session",
				"reason:session:incident response",
			]),
		);
	});

	it("classifies missing remote sessions as self-healing sync work", () => {
		expect(
			classifySyncOutcome(
				{
					id: "item-1",
					kind: "message",
					sessionId: "session-1",
					status: "failed",
					attempt: 1,
					maxAttempts: 5,
				},
				{ ok: false, statusCode: 404 },
			),
		).toEqual({
			action: "self_heal_session",
			reason: "remote_session_missing",
			nextAttempt: 2,
		});
	});

	it("blocks exhausted sync retries and keeps retryable errors durable", () => {
		expect(
			classifySyncOutcome(
				{
					id: "item-2",
					kind: "session_update",
					status: "failed",
					attempt: 5,
					maxAttempts: 5,
				},
				{ ok: false, statusCode: 503, errorCode: "service_unavailable" },
			),
		).toEqual({
			action: "block",
			reason: "service_unavailable",
			nextAttempt: 6,
		});
		expect(
			classifySyncOutcome(
				{
					id: "item-2b",
					kind: "message",
					sessionId: "session-1",
					status: "failed",
					attempt: 5,
					maxAttempts: 5,
				},
				{ ok: false, statusCode: 404 },
			),
		).toEqual({
			action: "block",
			reason: "max_attempts_exhausted",
			nextAttempt: 6,
		});
		expect(
			classifySyncOutcome(
				{
					id: "item-3",
					kind: "session_create",
					status: "failed",
					attempt: 1,
					maxAttempts: 5,
				},
				{ ok: false, statusCode: 503 },
			).action,
		).toBe("retry");
		expect(
			classifySyncOutcome(
				{
					id: "item-final-attempt",
					kind: "message",
					status: "failed",
					attempt: 4,
					maxAttempts: 5,
				},
				{ ok: false, statusCode: 503 },
			),
		).toEqual({
			action: "retry",
			reason: "http_503",
			nextAttempt: 5,
		});
		expect(
			classifySyncOutcome(
				{
					id: "item-5",
					kind: "settings",
					status: "failed",
					attempt: 1,
					maxAttempts: 5,
				},
				{ ok: false, statusCode: 404 },
			),
		).toEqual({
			action: "retry",
			reason: "http_404",
			nextAttempt: 2,
		});
		expect(
			classifySyncOutcome(
				{
					id: "item-4",
					kind: "message",
					status: "failed",
					attempt: 5,
					maxAttempts: 5,
				},
				{ ok: false, statusCode: 404 },
			),
		).toEqual({
			action: "block",
			reason: "max_attempts_exhausted",
			nextAttempt: 6,
		});
	});

	it("normalizes approval decisions across surfaces", () => {
		const evidence = buildApprovalDecisionEvidence({
			requestId: "approval-1",
			surface: "tui",
			mode: "ask",
			decision: "denied",
			toolNames: [" shell ", "shell", "write"],
			policyRefs: ["policy:workspace"],
		});

		expect(evidence.toolNames).toEqual(["shell", "write"]);
		expect(evidence.approvedTools).toEqual([]);
		expect(evidence.blockedTools).toEqual(["shell", "write"]);
		expect(evidence.reasons).toEqual(
			expect.arrayContaining(["surface:tui", "mode:ask", "decision:denied"]),
		);
	});

	it("governs extensions by source, signature, publisher, pin, and scope", () => {
		expect(
			evaluateExtensionGovernance(
				{
					id: "plugin-1",
					source: "marketplace",
					publisher: "evalops",
					signed: true,
					requestedScopes: ["repo:read", "session:write"],
				},
				{
					allowedSources: ["builtin", "marketplace"],
					trustedPublishers: ["evalops"],
					allowedScopes: ["repo:read", "session:write"],
					requireSignature: true,
				},
			),
		).toEqual(
			expect.objectContaining({
				allowed: true,
				blockers: [],
				reasons: expect.arrayContaining([
					"source:marketplace",
					"trusted_publisher:evalops",
					"signed",
					"scope:repo:read",
				]),
			}),
		);

		expect(
			evaluateExtensionGovernance(
				{
					id: "plugin-local",
					source: "local",
					publisher: "evalops",
				},
				{
					trustedPublishers: ["evalops"],
				},
			).reasons,
		).not.toContain("trusted_publisher:evalops");

		expect(
			evaluateExtensionGovernance(
				{
					id: "plugin-lockdown",
					source: "marketplace",
					publisher: "evalops",
					requestedScopes: ["repo:read"],
				},
				{
					allowedSources: [],
					trustedPublishers: [],
					allowedScopes: [],
				},
			).blockers,
		).toEqual(
			expect.arrayContaining([
				"source_not_allowed:marketplace",
				"publisher_not_trusted:evalops",
				"scope_not_allowed:repo:read",
			]),
		);

		expect(
			evaluateExtensionGovernance(
				{
					id: "plugin-2",
					source: "git",
					requestedScopes: ["secrets:read"],
				},
				{
					allowedSources: ["git"],
					allowedScopes: ["repo:read"],
					requireSignature: true,
					requirePinnedGitRef: true,
				},
			).blockers,
		).toEqual(
			expect.arrayContaining([
				"signature_required",
				"pinned_git_ref_required",
				"scope_not_allowed:secrets:read",
			]),
		);
	});

	it("builds readiness and effectiveness scorecards with blockers and warnings", () => {
		const readiness = buildRunReadinessReport([
			{ id: "tests", label: "Tests", status: "pass", weight: 2 },
			{ id: "release-gate", label: "Release gate", status: "fail", weight: 2 },
			{ id: "telemetry", label: "Telemetry", status: "warn", weight: 1 },
			{ id: "optional", label: "Optional", status: "unknown", weight: 10 },
		]);

		expect(readiness.score).toBe(50);
		expect(readiness.blockers).toEqual(["readiness:release-gate"]);
		expect(readiness.warnings).toEqual(["readiness:telemetry"]);

		const effectiveness = buildRunEffectivenessReport([
			{
				id: "task-complete",
				label: "Task complete",
				status: "pass",
				weight: 3,
			},
			{ id: "follow-up", label: "Follow-up", status: "warn", weight: 1 },
		]);

		expect(effectiveness.score).toBe(88);
		expect(effectiveness.blockers).toEqual([]);
		expect(effectiveness.warnings).toEqual(["effectiveness:follow-up"]);
	});

	it("defines ordered release canary gates and reports invalid dependencies", () => {
		const plan = buildReleaseCanaryPlan();

		expect(plan.version).toBe(MAESTRO_OPERATING_LAYER_VERSION);
		expect(plan.stages.map((stage) => stage.id)).toEqual([
			"local_release_gate",
			"publish_package",
			"registry_install_smoke",
			"published_replay_evidence",
			"release_notification",
		]);
		expect(plan.blockers).toEqual([]);
		plan.stages[0]!.requires.push("mutated");
		plan.stages[1]!.evidenceKinds.push("mutated");
		expect(buildReleaseCanaryPlan().stages[0]!.requires).toEqual([]);
		expect(buildReleaseCanaryPlan().stages[1]!.evidenceKinds).toEqual([
			"npm.publish",
			"git.tag",
			"github.release",
		]);
		expect(
			buildReleaseCanaryPlan([
				...DEFAULT_RELEASE_CANARY_STAGES,
				{
					id: "broken",
					name: "Broken",
					requires: ["missing"],
					evidenceKinds: ["evidence"],
				},
			]).blockers,
		).toEqual(["missing_stage:broken:missing"]);
		expect(
			buildReleaseCanaryPlan([
				{
					id: "a",
					name: "A",
					requires: ["b"],
					evidenceKinds: ["a"],
				},
				{
					id: "b",
					name: "B",
					requires: ["a"],
					evidenceKinds: ["b"],
				},
			]).blockers,
		).toEqual(
			expect.arrayContaining(["out_of_order_stage:a:b", "cycle:a>b>a"]),
		);
		expect(
			buildReleaseCanaryPlan([
				{
					id: "a",
					name: "A",
					requires: ["b"],
					evidenceKinds: ["a"],
				},
				{
					id: "b",
					name: "B",
					requires: ["a"],
					evidenceKinds: ["b"],
				},
				{
					id: "a",
					name: "A duplicate",
					requires: [],
					evidenceKinds: ["a"],
				},
			]).blockers,
		).toEqual(
			expect.arrayContaining([
				"duplicate_stage:a",
				"out_of_order_stage:a:b",
				"cycle:a>b>a",
			]),
		);
		expect(
			buildReleaseCanaryPlan([
				{
					id: "publish_package",
					name: "Publish package",
					requires: ["local_release_gate"],
					evidenceKinds: ["npm.publish"],
				},
				{
					id: "local_release_gate",
					name: "Local release gate",
					requires: [],
					evidenceKinds: ["test"],
				},
			]).blockers,
		).toEqual(["out_of_order_stage:publish_package:local_release_gate"]);
		expect(
			buildReleaseCanaryPlan([
				{
					id: "publish_package",
					name: "Publish package",
					requires: [],
					evidenceKinds: ["npm.publish"],
				},
				{
					id: "publish_package",
					name: "Duplicate publish package",
					requires: [],
					evidenceKinds: ["npm.publish"],
				},
			]).blockers,
		).toEqual(["duplicate_stage:publish_package"]);
		expect(
			buildReleaseCanaryPlan([
				{
					id: "local_release_gate",
					name: "Local release gate",
					requires: [],
					evidenceKinds: ["test"],
				},
				{
					id: "publish_package",
					name: "Publish package",
					requires: ["local_release_gate"],
					evidenceKinds: ["npm.publish"],
				},
				{
					id: "local_release_gate",
					name: "Duplicate local release gate",
					requires: [],
					evidenceKinds: ["build"],
				},
			]).blockers,
		).toEqual(["duplicate_stage:local_release_gate"]);
		expect(
			buildReleaseCanaryPlan([
				{
					id: "a",
					name: "A",
					requires: ["b"],
					evidenceKinds: ["a"],
				},
				{
					id: "b",
					name: "B",
					requires: ["a"],
					evidenceKinds: ["b"],
				},
				{
					id: "a",
					name: "Duplicate A",
					requires: [],
					evidenceKinds: ["a"],
				},
			]).blockers,
		).toEqual(expect.arrayContaining(["duplicate_stage:a", "cycle:a>b>a"]));
	});
});
